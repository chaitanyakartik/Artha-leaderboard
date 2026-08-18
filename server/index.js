import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, ROOT } from './db.js';
import { createRun, loadClassBuckets, loadFieldSchema, loadTaxonomy } from './runs.js';
import { aggregateTask } from './scoring/aggregate.js';
import { ingestWandb } from './ingest/wandb.js';
import { ingestAnalyzerCaptures, ingestAnalyzerRun } from './analyzers.js';
import { config, authConfigured } from './config.js';
import { verifyPassword, issueToken, verifyToken, parseCookies, sessionCookie, clearCookie, COOKIE_NAME } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
const d = db();

const TASKS = ['segmentation', 'classification', 'extraction', 'segregation'];
// Headline metric per task (ranks the board + the overview matrix) and which task-group
// owns a dataset (datasets are scoped: seg+cls share a pool; extraction & segregation own theirs).
const HEADLINE = { segmentation: 'boundary_recall', classification: 'accuracy', extraction: 'field_accuracy', segregation: 'ari' };
const TASK_GROUP = { segmentation: 'seg-cls', classification: 'seg-cls', extraction: 'extraction', segregation: 'segregation' };

// ---- auth gate ------------------------------------------------------------
// Everything requires a valid session except: the login page, login/health APIs,
// and the shared static assets the login page itself needs.
const PUBLIC_PATHS = new Set(['/login.html', '/style.css', '/api/login', '/api/health', '/favicon.ico']);

app.addHook('onRequest', async (req, reply) => {
  if (!authConfigured()) return; // no credential set yet -> open (dev). Set one via scripts/set-password.js
  const url = (req.raw.url || '').split('?')[0];
  if (PUBLIC_PATHS.has(url)) return;

  const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
  const session = verifyToken(token);
  if (session) { req.user = session.u; return; }

  if (url.startsWith('/api/')) return reply.code(401).send({ error: 'unauthorized' });
  return reply.redirect('/login.html');
});

// ---- auth routes ----------------------------------------------------------
app.post('/api/login', async (req, reply) => {
  const { username, password } = req.body || {};
  const ok = authConfigured() &&
    username === config.user &&
    verifyPassword(String(password ?? ''), config.passHash);
  if (!ok) return reply.code(401).send({ error: 'invalid username or password' });
  reply.header('set-cookie', sessionCookie(issueToken(username)));
  return { ok: true, user: username };
});

app.post('/api/logout', async (req, reply) => {
  reply.header('set-cookie', clearCookie());
  return { ok: true };
});

app.get('/api/me', async (req) => ({ user: req.user || null, auth: authConfigured() }));

// ---- editable docs (home page) --------------------------------------------
// Whitelisted, editable text files. Add entries here to expose more on the home page.
const DOCS = { models: path.join(ROOT, 'models.md') };
app.get('/api/docs/:name', async (req, reply) => {
  const p = DOCS[req.params.name];
  if (!p) return reply.code(404).send({ error: 'unknown doc' });
  let content = '';
  try { content = fs.readFileSync(p, 'utf8'); } catch { content = ''; }
  return { name: req.params.name, content };
});
app.put('/api/docs/:name', async (req, reply) => {
  const p = DOCS[req.params.name];
  if (!p) return reply.code(404).send({ error: 'unknown doc' });
  const { content } = req.body || {};
  if (typeof content !== 'string') return reply.code(400).send({ error: 'content string required' });
  fs.writeFileSync(p, content);
  return { ok: true, name: req.params.name, bytes: content.length };
});

// ---- reference data -------------------------------------------------------
app.get('/api/health', async () => ({ ok: true }));
app.get('/api/tasks', async () => d.prepare('SELECT slug, label, sort_order FROM tasks ORDER BY sort_order').all());
app.get('/api/models', async () =>
  d.prepare('SELECT id, name, notes, card_json FROM model_configs ORDER BY name').all()
    .map((m) => ({ id: m.id, name: m.name, notes: m.notes, card: m.card_json ? JSON.parse(m.card_json) : null })));

app.post('/api/models', async (req, reply) => {
  const { name, id: rawId, base, kind, params, tasks, notes } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim())
    return reply.code(400).send({ error: 'name required' });
  if (tasks !== undefined && !Array.isArray(tasks))
    return reply.code(400).send({ error: 'tasks must be an array' });

  // Derive slug from name if not provided, then ensure uniqueness.
  let slug = rawId
    ? String(rawId)
    : name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  if (rawId) {
    // Explicit id: conflict is a hard error.
    if (d.prepare('SELECT 1 FROM model_configs WHERE id = ?').get(slug))
      return reply.code(409).send({ error: 'duplicate_model', message: `model config id "${slug}" already exists` });
  } else {
    // Auto-derived slug: append -2, -3, … until unique.
    const base_slug = slug;
    let attempt = 1;
    while (d.prepare('SELECT 1 FROM model_configs WHERE id = ?').get(slug)) {
      attempt += 1;
      slug = `${base_slug}-${attempt}`;
    }
  }

  // Build card_json from whichever optional fields were provided.
  const card = {};
  if (kind !== undefined) card.kind = kind;
  if (base !== undefined) card.base = base;
  if (params !== undefined) card.params = params;
  if (tasks !== undefined) card.tasks = tasks;
  const cardJson = Object.keys(card).length ? JSON.stringify(card) : null;

  try {
    d.prepare('INSERT INTO model_configs (id, name, notes, card_json) VALUES (?, ?, ?, ?)')
      .run(slug, name.trim(), notes ?? null, cardJson);
  } catch (e) {
    return reply.code(400).send({ error: String(e.message || e) });
  }

  const row = d.prepare('SELECT id, name, notes, card_json FROM model_configs WHERE id = ?').get(slug);
  return { id: row.id, name: row.name, notes: row.notes, card: row.card_json ? JSON.parse(row.card_json) : null };
});

// The class taxonomy + coarse buckets (buckets feed segmentation's bucket-level views).
app.get('/api/classes', async () => d.prepare('SELECT code, label, bucket FROM class_taxonomy ORDER BY code').all());

// Per-(config × task) notes. GET all task notes for a config; PUT upserts one task's note.
app.get('/api/configs/:id/notes', async (req, reply) => {
  if (!d.prepare('SELECT 1 FROM model_configs WHERE id = ?').get(req.params.id))
    return reply.code(404).send({ error: 'unknown model config' });
  return d.prepare('SELECT task, text, updated_at FROM config_task_notes WHERE model_config_id = ?').all(req.params.id);
});
app.put('/api/configs/:id/notes', async (req, reply) => {
  const { task, text } = req.body || {};
  if (!TASKS.includes(task)) return reply.code(400).send({ error: 'bad task' });
  if (!d.prepare('SELECT 1 FROM model_configs WHERE id = ?').get(req.params.id))
    return reply.code(404).send({ error: 'unknown model config' });
  d.prepare(
    `INSERT INTO config_task_notes (model_config_id, task, text, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(model_config_id, task) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`
  ).run(req.params.id, task, typeof text === 'string' ? text : '');
  return { ok: true, model_config_id: req.params.id, task };
});

// Extraction doc-type templates (each with a field schema).
app.get('/api/extraction-types', async () => d.prepare('SELECT * FROM extraction_types ORDER BY name').all());
app.post('/api/extraction-types', async (req, reply) => {
  const { name, field_schema, notes } = req.body || {};
  if (!name) return reply.code(400).send({ error: 'name required' });
  try {
    const info = d.prepare('INSERT INTO extraction_types (name, field_schema, notes) VALUES (?, ?, ?)')
      .run(name, field_schema ? JSON.stringify(field_schema) : null, notes ?? null);
    return d.prepare('SELECT * FROM extraction_types WHERE id = ?').get(info.lastInsertRowid);
  } catch (e) { return reply.code(400).send({ error: String(e.message || e) }); }
});

// Prompt library. Filter by task (+ extraction_type_id for extraction). Full text stored in-app.
app.get('/api/prompts', async (req) => {
  const { task, extraction_type_id } = req.query;
  const where = [], args = [];
  if (task) { where.push('task = ?'); args.push(task); }
  if (extraction_type_id) { where.push('extraction_type_id = ?'); args.push(Number(extraction_type_id)); }
  const sql = `SELECT * FROM prompts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
  return d.prepare(sql).all(...args);
});
app.post('/api/prompts', async (req, reply) => {
  const { task, extraction_type_id, name, version, text, notes } = req.body || {};
  if (!TASKS.includes(task)) return reply.code(400).send({ error: 'bad task' });
  if (!name || !text) return reply.code(400).send({ error: 'name and text required' });
  const info = d.prepare('INSERT INTO prompts (task, extraction_type_id, name, version, text, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(task, extraction_type_id ?? null, name, version ?? null, text, notes ?? null);
  return d.prepare('SELECT * FROM prompts WHERE id = ?').get(info.lastInsertRowid);
});
app.delete('/api/prompts/:id', async (req) => { d.prepare('DELETE FROM prompts WHERE id = ?').run(Number(req.params.id)); return { ok: true }; });

// ---- datasets -------------------------------------------------------------
app.get('/api/datasets', async () => d.prepare('SELECT * FROM datasets ORDER BY created_at DESC').all());

app.post('/api/datasets', async (req, reply) => {
  const { name, n_applicants, n_docs, source_manifest, notes, seg_window_mode, scope } = req.body || {};
  if (!name) return reply.code(400).send({ error: 'name required' });
  const SCOPES = ['seg-cls', 'extraction', 'segregation', 'analyzers'];
  const sc = SCOPES.includes(scope) ? scope : 'seg-cls';
  try {
    const info = d.prepare(
      `INSERT INTO datasets (name, n_applicants, n_docs, source_manifest, scope, seg_window_mode, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(name, n_applicants ?? null, n_docs ?? null, source_manifest ?? null, sc, seg_window_mode ? 1 : 0, notes ?? null);
    return d.prepare('SELECT * FROM datasets WHERE id = ?').get(info.lastInsertRowid);
  } catch (e) {
    return reply.code(400).send({ error: String(e.message || e) });
  }
});

// ---- ground truth ---------------------------------------------------------
// Body: { task, gt: { doc_id: gold, ... }, source_refs?: { doc_id: s3url } }
app.post('/api/datasets/:id/gt', async (req, reply) => {
  const datasetId = Number(req.params.id);
  const { task, gt, source_refs = {} } = req.body || {};
  if (!TASKS.includes(task)) return reply.code(400).send({ error: `task must be one of ${TASKS.join(', ')}` });
  if (!gt || typeof gt !== 'object') return reply.code(400).send({ error: 'gt object required' });
  if (!d.prepare('SELECT 1 FROM datasets WHERE id = ?').get(datasetId))
    return reply.code(404).send({ error: 'dataset not found' });

  const upsert = d.prepare(
    `INSERT INTO gt_items (dataset_id, task, doc_id, source_ref, gold_json)
     VALUES (@dataset_id, @task, @doc_id, @source_ref, @gold_json)
     ON CONFLICT(dataset_id, task, doc_id)
     DO UPDATE SET gold_json = excluded.gold_json, source_ref = excluded.source_ref`
  );
  const tx = d.transaction((entries) => {
    for (const [doc_id, gold] of entries) {
      upsert.run({
        dataset_id: datasetId, task, doc_id,
        source_ref: source_refs[doc_id] ?? null,
        gold_json: JSON.stringify(gold),
      });
    }
  });
  tx(Object.entries(gt));
  const count = d.prepare('SELECT COUNT(*) c FROM gt_items WHERE dataset_id = ? AND task = ?').get(datasetId, task).c;
  return { dataset_id: datasetId, task, gt_count: count };
});

app.get('/api/datasets/:id/gt', async (req) => {
  const datasetId = Number(req.params.id);
  const rows = d.prepare('SELECT task, COUNT(*) c FROM gt_items WHERE dataset_id = ? GROUP BY task').all(datasetId);
  return Object.fromEntries(rows.map((r) => [r.task, r.c]));
});

// Map a createRun() failure code to an HTTP status.
const CODE_STATUS = { coverage_incomplete: 422, unknown_model: 400, unknown_dataset: 404, no_gt: 400, duplicate_external: 409, gt_mismatch: 409, bad_payload: 400 };
function sendResult(reply, res) {
  if (res.ok) return res;
  return reply.code(CODE_STATUS[res.code] || 400).send({ error: res.code, ...res });
}

// ---- runs (score a predictions file) --------------------------------------
// Body: { task, dataset_id, model_config_id, predictions: {doc_id: value},
//         extraction_type_id?, prompt_id?, checkpoint?, supported_classes?, override?, notes? }
// supported_classes: DECLARED file types this run's model handles (array). Omit/null = undeclared.
app.post('/api/runs', async (req, reply) => {
  const b = req.body || {};
  if (!TASKS.includes(b.task)) return reply.code(400).send({ error: 'bad task' });
  if (!b.predictions || typeof b.predictions !== 'object') return reply.code(400).send({ error: 'predictions object required' });
  if (b.supported_classes != null && !Array.isArray(b.supported_classes)) return reply.code(400).send({ error: 'supported_classes must be an array' });
  return sendResult(reply, createRun(d, {
    task: b.task, datasetId: Number(b.dataset_id), modelId: b.model_config_id,
    predictions: b.predictions, override: b.override,
    extractionTypeId: b.extraction_type_id, promptId: b.prompt_id,
    checkpoint: b.checkpoint, supportedClasses: b.supported_classes, notes: b.notes,
  }));
});

// Manual entry (type a number directly, no predictions file / no scoring).
// Body: { task, dataset_id, model_config_id, metrics: {key: value}, notes? }
app.post('/api/runs/manual', async (req, reply) => {
  const b = req.body || {};
  if (!TASKS.includes(b.task)) return reply.code(400).send({ error: 'bad task' });
  if (!b.metrics || typeof b.metrics !== 'object') return reply.code(400).send({ error: 'metrics object required' });
  return sendResult(reply, createRun(d, {
    task: b.task, datasetId: Number(b.dataset_id), modelId: b.model_config_id,
    manualMetrics: b.metrics, promptId: b.prompt_id, notes: b.notes,
  }));
});

// Patch a run: rename (display_name) and/or DECLARE its supported file types
// (supported_classes: array | null). Declaring re-derives the taxonomy-coverage view (no re-score).
// run_key / identity stays fixed.
app.patch('/api/runs/:id', async (req, reply) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const run = d.prepare('SELECT id, task, extraction_type_id FROM runs WHERE id = ?').get(id);
  if (!run) return reply.code(404).send({ error: 'not found' });
  if (b.display_name) d.prepare('UPDATE runs SET display_name = ? WHERE id = ?').run(b.display_name, id);

  if ('supported_classes' in b) {
    if (b.supported_classes != null && !Array.isArray(b.supported_classes)) return reply.code(400).send({ error: 'supported_classes must be an array or null' });
    d.prepare('UPDATE runs SET supported_classes_json = ? WHERE id = ?').run(b.supported_classes ? JSON.stringify(b.supported_classes) : null, id);
    // re-derive coverage from the stored atomic layer (segmentation/classification only)
    if (run.task === 'segmentation' || run.task === 'classification') {
      const supportedClasses = b.supported_classes || null;
      let atomic, opts;
      if (run.task === 'segmentation') {
        atomic = d.prepare('SELECT * FROM analysis_events WHERE run_id = ?').all(id);
        opts = { classBuckets: loadClassBuckets(d), taxonomy: loadTaxonomy(d), supportedClasses };
      } else {
        atomic = d.prepare('SELECT doc_id, predicted_json, gold_json, correct, detail_json FROM item_results WHERE run_id = ?').all(id);
        opts = { taxonomy: loadTaxonomy(d), supportedClasses };
      }
      if (atomic.length) {
        const analysis = aggregateTask(run.task, atomic, opts);
        if (analysis) d.prepare('UPDATE runs SET analysis_json = ? WHERE id = ?').run(JSON.stringify(analysis), id);
      }
    }
  }
  return { ok: true };
});

// ---- W&B auto-ingest (SCAFFOLD, gated off by default) ----------------------
// Enable with ARTHA_WANDB_INGEST=on. Reuses createRun() so scoring is identical.
app.post('/api/ingest/wandb', async (req, reply) => {
  if (!config.wandbIngest) return reply.code(501).send({ error: 'wandb_ingest_disabled', message: 'set ARTHA_WANDB_INGEST=on to enable (future feature)' });
  return sendResult(reply, ingestWandb(d, req.body || {}));
});

// ---- leaderboard ----------------------------------------------------------
app.get('/api/leaderboard', async (req, reply) => {
  const { task, dataset_id } = req.query;
  if (!TASKS.includes(task)) return reply.code(400).send({ error: 'bad task' });
  const runs = d.prepare(
    `SELECT r.*, m.name AS model_name, p.name AS prompt_name, p.version AS prompt_version, et.name AS extraction_type_name
     FROM runs r JOIN model_configs m ON m.id = r.model_config_id
     LEFT JOIN prompts p ON p.id = r.prompt_id
     LEFT JOIN extraction_types et ON et.id = r.extraction_type_id
     WHERE r.task = ? AND r.dataset_id = ? ORDER BY r.created_at DESC`
  ).all(task, Number(dataset_id));
  const metricStmt = d.prepare(`SELECT key, value FROM run_metrics WHERE run_id = ? AND scope = 'overall'`);
  for (const r of runs) r.metrics = Object.fromEntries(metricStmt.all(r.id).map((x) => [x.key, x.value]));
  return runs;
});

// ---- overview (standings matrix) ------------------------------------------
// For a task, across every in-scope dataset: a configs × datasets matrix of the BEST run's
// headline value (+ coverage, run_id, when, #runs). Empty cell = no run = a coverage gap.
app.get('/api/overview', async (req, reply) => {
  const { task } = req.query;
  if (!TASKS.includes(task)) return reply.code(400).send({ error: 'bad task' });
  const headline = HEADLINE[task];
  const datasets = d.prepare(
    "SELECT id, name, n_docs FROM datasets WHERE COALESCE(scope,'seg-cls') = ? ORDER BY created_at DESC"
  ).all(TASK_GROUP[task]);
  const rows = d.prepare(
    `SELECT r.id, r.model_config_id, r.dataset_id, r.coverage_status, r.created_at, r.checkpoint,
            m.name AS model_name, rm.value AS headline
     FROM runs r JOIN model_configs m ON m.id = r.model_config_id
     LEFT JOIN run_metrics rm ON rm.run_id = r.id AND rm.key = ? AND rm.scope = 'overall'
     WHERE r.task = ? ORDER BY r.created_at DESC`
  ).all(headline, task);

  const byConfig = new Map();
  for (const r of rows) {
    if (!byConfig.has(r.model_config_id))
      byConfig.set(r.model_config_id, { model_config_id: r.model_config_id, model_name: r.model_name, cells: {} });
    const cfg = byConfig.get(r.model_config_id);
    let cell = cfg.cells[r.dataset_id];
    if (!cell) cell = cfg.cells[r.dataset_id] = { value: null, coverage_status: null, run_id: null, when: null, checkpoint: null, n_runs: 0 };
    cell.n_runs += 1;
    if (r.headline != null && (cell.value == null || r.headline > cell.value)) {
      cell.value = r.headline; cell.coverage_status = r.coverage_status;
      cell.run_id = r.id; cell.when = r.created_at; cell.checkpoint = r.checkpoint;
    }
  }
  const best = (cfg) => Math.max(-1, ...Object.values(cfg.cells).map((c) => c.value ?? -1));
  const configRows = [...byConfig.values()].sort((a, b) => best(b) - best(a));
  return { task, headline, datasets, rows: configRows };
});

// Reverse-chron feed of scored runs across all tasks/datasets (the "did my last run land" strip).
app.get('/api/runs/recent', async (req) => {
  const limit = Math.min(Number(req.query.limit) || 12, 100);
  const runs = d.prepare(
    `SELECT r.id, r.task, r.dataset_id, r.model_config_id, r.display_name, r.checkpoint, r.coverage_status, r.created_at,
            m.name AS model_name, ds.name AS dataset_name
     FROM runs r JOIN model_configs m ON m.id = r.model_config_id JOIN datasets ds ON ds.id = r.dataset_id
     ORDER BY r.created_at DESC LIMIT ?`
  ).all(limit);
  const hstmt = d.prepare(`SELECT value FROM run_metrics WHERE run_id = ? AND key = ? AND scope = 'overall'`);
  for (const r of runs) {
    r.headline_key = HEADLINE[r.task];
    const hv = hstmt.get(r.id, r.headline_key);
    r.headline = hv ? hv.value : null;
  }
  return runs;
});

app.get('/api/runs/:id', async (req, reply) => {
  const id = Number(req.params.id);
  const run = d.prepare(
    `SELECT r.*, m.name AS model_name, p.name AS prompt_name, p.version AS prompt_version, p.text AS prompt_text, et.name AS extraction_type_name
     FROM runs r JOIN model_configs m ON m.id = r.model_config_id
     LEFT JOIN prompts p ON p.id = r.prompt_id
     LEFT JOIN extraction_types et ON et.id = r.extraction_type_id WHERE r.id = ?`
  ).get(id);
  if (!run) return reply.code(404).send({ error: 'not found' });
  if (run.analysis_json) run.analysis = JSON.parse(run.analysis_json);
  delete run.analysis_json;
  run.supported_classes = run.supported_classes_json ? JSON.parse(run.supported_classes_json) : null;
  delete run.supported_classes_json;
  run.metrics = d.prepare('SELECT key, value, scope FROM run_metrics WHERE run_id = ?').all(id);
  run.items = d.prepare('SELECT doc_id, predicted_json, gold_json, correct, detail_json FROM item_results WHERE run_id = ? LIMIT 2000').all(id);
  return run;
});

// Raw per-page events — the durable, re-aggregatable layer (foundation for future views).
app.get('/api/runs/:id/events', async (req) => {
  const id = Number(req.params.id);
  const total = d.prepare('SELECT COUNT(*) c FROM analysis_events WHERE run_id = ?').get(id).c;
  const limit = Math.min(Number(req.query.limit) || 5000, 20000);
  const events = d.prepare('SELECT * FROM analysis_events WHERE run_id = ? ORDER BY id LIMIT ?').all(id, limit);
  return { run_id: id, total, returned: events.length, events };
});

// Re-derive the analysis from a run's stored ATOMIC layer WITHOUT re-scoring — e.g. after populating
// class buckets, growing the class taxonomy, or adding a new analysis view. Task-dispatched:
// segmentation re-aggregates from analysis_events; classification/extraction from item_results.
app.post('/api/runs/:id/reaggregate', async (req, reply) => {
  const id = Number(req.params.id);
  const run = d.prepare('SELECT id, task, extraction_type_id, supported_classes_json FROM runs WHERE id = ?').get(id);
  if (!run) return reply.code(404).send({ error: 'not found' });
  const supportedClasses = run.supported_classes_json ? JSON.parse(run.supported_classes_json) : null;

  let atomic, opts = {};
  if (run.task === 'segmentation') {
    atomic = d.prepare('SELECT * FROM analysis_events WHERE run_id = ?').all(id);
    opts = { classBuckets: loadClassBuckets(d), taxonomy: loadTaxonomy(d), supportedClasses };
  } else {
    atomic = d.prepare('SELECT doc_id, predicted_json, gold_json, correct, detail_json FROM item_results WHERE run_id = ?').all(id);
    if (run.task === 'classification') opts = { taxonomy: loadTaxonomy(d), supportedClasses };
    else if (run.task === 'extraction') opts = { fieldSchema: loadFieldSchema(d, run.extraction_type_id) };
  }
  if (!atomic.length) return reply.code(400).send({ error: 'no_events', message: 'this run has no stored atomic rows to re-aggregate' });
  const analysis = aggregateTask(run.task, atomic, opts);
  if (!analysis) return reply.code(400).send({ error: 'no_aggregator', message: `no aggregator for task ${run.task}` });
  d.prepare('UPDATE runs SET analysis_json = ? WHERE id = ?').run(JSON.stringify(analysis), id);
  return { ok: true, run_id: id, analysis };
});

app.delete('/api/runs/:id', async (req) => {
  d.prepare('DELETE FROM runs WHERE id = ?').run(Number(req.params.id));
  return { ok: true };
});

// ---- analyzers (judge-scored, ingest-only) --------------------------------

// GET /api/analyzers — full roster ordered by sort_order
app.get('/api/analyzers', async () =>
  d.prepare('SELECT * FROM analyzers ORDER BY sort_order').all()
);

// GET /api/analyzer-captures?dataset_id=&analyzer= — dataset browse
// Without analyzer: grouped counts per slug. With analyzer: list of captures.
app.get('/api/analyzer-captures', async (req, reply) => {
  const { dataset_id, analyzer } = req.query;
  if (!dataset_id) return reply.code(400).send({ error: 'bad_payload', message: 'dataset_id required' });
  const dsId = Number(dataset_id);

  if (analyzer) {
    const rows = d.prepare(`
      SELECT doc_id, analyzer_slug, application, product_type, input_json, reference_output_json
      FROM analyzer_captures
      WHERE dataset_id = ? AND analyzer_slug = ?
      ORDER BY doc_id
    `).all(dsId, analyzer);

    return rows.map((r) => ({
      doc_id: r.doc_id,
      analyzer_slug: r.analyzer_slug,
      application: r.application,
      product_type: r.product_type,
      input: r.input_json ? JSON.parse(r.input_json) : null,
      reference_output: r.reference_output_json ? JSON.parse(r.reference_output_json) : null,
    }));
  }

  // Grouped counts.
  return d.prepare(`
    SELECT a.slug, a.label, a.sort_order, COUNT(ac.id) AS n_captures
    FROM analyzers a
    LEFT JOIN analyzer_captures ac ON ac.dataset_id = ? AND ac.analyzer_slug = a.slug
    GROUP BY a.slug
    ORDER BY a.sort_order
  `).all(dsId);
});

// POST /api/analyzer-captures { dataset_id, captures: [...] } — ingest GT captures
app.post('/api/analyzer-captures', async (req, reply) => {
  const { dataset_id, captures } = req.body || {};
  if (!dataset_id) return reply.code(400).send({ error: 'bad_payload', message: 'dataset_id required' });
  if (!Array.isArray(captures) || captures.length === 0)
    return reply.code(400).send({ error: 'bad_payload', message: 'captures array required' });
  const ds = d.prepare('SELECT id FROM datasets WHERE id = ?').get(Number(dataset_id));
  if (!ds) return reply.code(404).send({ error: 'unknown_dataset', message: `dataset ${dataset_id} not found` });
  try {
    const upserted = ingestAnalyzerCaptures(d, Number(dataset_id), captures);
    return { ok: true, upserted };
  } catch (e) {
    return reply.code(400).send({ error: 'bad_payload', message: String(e.message || e) });
  }
});

// POST /api/analyzer-runs { dataset_id, model, ref_model?, display_name?, judge_model?, items: [...] }
app.post('/api/analyzer-runs', async (req, reply) => {
  const b = req.body || {};
  if (!b.dataset_id) return reply.code(400).send({ error: 'bad_payload', message: 'dataset_id required' });
  if (!b.model) return reply.code(400).send({ error: 'bad_payload', message: 'model required' });
  if (!Array.isArray(b.items)) return reply.code(400).send({ error: 'bad_payload', message: 'items array required' });
  const ds = d.prepare('SELECT id FROM datasets WHERE id = ?').get(Number(b.dataset_id));
  if (!ds) return reply.code(404).send({ error: 'unknown_dataset', message: `dataset ${b.dataset_id} not found` });
  try {
    const result = ingestAnalyzerRun(d, Number(b.dataset_id), {
      model: b.model,
      ref_model: b.ref_model,
      display_name: b.display_name,
      judge_model: b.judge_model,
      notes: b.notes,
      items: b.items,
    });
    return { ok: true, ...result };
  } catch (e) {
    return reply.code(400).send({ error: 'bad_payload', message: String(e.message || e) });
  }
});

// GET /api/analyzer-overview?dataset_id= — per-analyzer standings across all runs
// Returns: [{ slug, label, n_captures, runs: [{ run_id, model_config_id, model_name, n_judged,
//   avg_goodness, avg_faithfulness, avg_completeness, ref_avg_goodness, wins, losses, ties }] }]
app.get('/api/analyzer-overview', async (req, reply) => {
  const { dataset_id } = req.query;
  if (!dataset_id) return reply.code(400).send({ error: 'bad_payload', message: 'dataset_id required' });
  const dsId = Number(dataset_id);

  // All analyzers that have captures in this dataset, ordered by sort_order.
  const analyzerRows = d.prepare(`
    SELECT a.slug, a.label, a.sort_order, COUNT(ac.id) AS n_captures
    FROM analyzers a
    JOIN analyzer_captures ac ON ac.dataset_id = ? AND ac.analyzer_slug = a.slug
    GROUP BY a.slug
    ORDER BY a.sort_order
  `).all(dsId);

  // All runs for this dataset + their per-analyzer aggregates.
  const runItemStmt = d.prepare(`
    SELECT
      ari.run_id,
      ar.model_config_id,
      mc.name AS model_name,
      COUNT(*)                              AS n_judged,
      AVG(ari.overall_goodness)             AS avg_goodness,
      AVG(ari.faithfulness)                 AS avg_faithfulness,
      AVG(ari.completeness)                 AS avg_completeness,
      AVG(ari.ref_goodness)                 AS ref_avg_goodness,
      SUM(CASE WHEN ari.winner = 'model' THEN 1 ELSE 0 END)     AS wins,
      SUM(CASE WHEN ari.winner = 'reference' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN ari.winner = 'tie' THEN 1 ELSE 0 END)       AS ties
    FROM analyzer_run_items ari
    JOIN analyzer_runs ar ON ar.id = ari.run_id
    JOIN model_configs mc ON mc.id = ar.model_config_id
    WHERE ar.dataset_id = ? AND ari.analyzer_slug = ?
    GROUP BY ari.run_id
    ORDER BY avg_goodness DESC
  `);

  const result = analyzerRows.map((az) => ({
    slug: az.slug,
    label: az.label,
    n_captures: az.n_captures,
    runs: runItemStmt.all(dsId, az.slug),
  }));

  return result;
});

// GET /api/analyzer-tree?dataset_id= — the whole nested board in one call:
// analyzer → model type (the run model(s) + the Gemini reference) → runs → per-doc analyses.
// The analyzer node carries the headline gemma-vs-gemini comparison for at-a-glance scanning.
app.get('/api/analyzer-tree', async (req, reply) => {
  const { dataset_id } = req.query;
  if (!dataset_id) return reply.code(400).send({ error: 'bad_payload', message: 'dataset_id required' });
  const dsId = Number(dataset_id);
  const names = Object.fromEntries(d.prepare('SELECT id, name FROM model_configs').all().map((m) => [m.id, m.name]));
  const analyzerRows = d.prepare(`
    SELECT a.slug, a.label, COUNT(ac.id) AS n_captures
    FROM analyzers a
    JOIN analyzer_captures ac ON ac.dataset_id = ? AND ac.analyzer_slug = a.slug
    GROUP BY a.slug ORDER BY a.sort_order`).all(dsId);
  const itemStmt = d.prepare(`
    SELECT ari.run_id, ari.doc_id, ari.overall_goodness AS g, ari.faithfulness AS f, ari.completeness AS c, ari.winner,
           ari.ref_goodness AS rg, ari.ref_faithfulness AS rf, ari.ref_completeness AS rc,
           ar.model_config_id, ar.ref_model_config_id, ar.display_name, ac.application
    FROM analyzer_run_items ari
    JOIN analyzer_runs ar ON ar.id = ari.run_id
    LEFT JOIN analyzer_captures ac ON ac.dataset_id = ar.dataset_id AND ac.analyzer_slug = ari.analyzer_slug AND ac.doc_id = ari.doc_id
    WHERE ar.dataset_id = ? AND ari.analyzer_slug = ? ORDER BY ari.doc_id`);
  const mean = (arr) => { const v = arr.filter((x) => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };

  const out = analyzerRows.map((az) => {
    const items = itemStmt.all(dsId, az.slug);
    if (!items.length) return { slug: az.slug, label: az.label, n_captures: az.n_captures, headline: null, models: [] };
    // --- run model(s) (e.g. gemma), grouped model → run → docs ---
    const byModel = {};
    for (const it of items) ((byModel[it.model_config_id] ||= {})[it.run_id] ||= []).push(it);
    const runModels = Object.entries(byModel).map(([mid, runs]) => {
      const runList = Object.entries(runs).map(([rid, its]) => ({
        run_id: Number(rid), display_name: its[0].display_name || ('run ' + rid), n: its.length,
        avg_goodness: mean(its.map((x) => x.g)), avg_faithfulness: mean(its.map((x) => x.f)), avg_completeness: mean(its.map((x) => x.c)),
        docs: its.map((x) => ({ doc_id: x.doc_id, application: x.application, run_id: x.run_id, goodness: x.g, faithfulness: x.f, completeness: x.c, winner: x.winner })),
      }));
      const all = Object.values(runs).flat();
      return { model_config_id: mid, model_name: names[mid] || mid, kind: 'run',
        avg_goodness: mean(all.map((x) => x.g)), avg_faithfulness: mean(all.map((x) => x.f)), avg_completeness: mean(all.map((x) => x.c)), runs: runList };
    });
    // --- reference model (Gemini), one pseudo-run, deduped by doc ---
    const refId = items.find((x) => x.ref_model_config_id)?.ref_model_config_id;
    const models = [...runModels];
    if (refId) {
      const byDoc = {}; for (const it of items) if (!byDoc[it.doc_id]) byDoc[it.doc_id] = it;
      const refItems = Object.values(byDoc);
      const refDocs = refItems.map((x) => ({ doc_id: x.doc_id, application: x.application, run_id: x.run_id, goodness: x.rg, faithfulness: x.rf, completeness: x.rc, winner: x.winner === 'model' ? 'reference' : x.winner === 'reference' ? 'model' : x.winner }));
      models.push({ model_config_id: refId, model_name: names[refId] || refId, kind: 'reference',
        avg_goodness: mean(refItems.map((x) => x.rg)), avg_faithfulness: mean(refItems.map((x) => x.rf)), avg_completeness: mean(refItems.map((x) => x.rc)),
        runs: [{ run_id: null, display_name: 'reference (prod capture)', n: refDocs.length, avg_goodness: mean(refItems.map((x) => x.rg)), avg_faithfulness: mean(refItems.map((x) => x.rf)), avg_completeness: mean(refItems.map((x) => x.rc)), docs: refDocs }] });
    }
    // --- headline: primary run model vs reference ---
    const prim = runModels[0];
    const wins = items.filter((x) => x.winner === 'model').length;
    const losses = items.filter((x) => x.winner === 'reference').length;
    const ties = items.filter((x) => x.winner === 'tie').length;
    const headline = prim ? {
      model_name: prim.model_name, model_goodness: prim.avg_goodness,
      ref_model_name: refId ? (names[refId] || refId) : null, ref_goodness: refId ? mean(Object.values((() => { const b = {}; for (const it of items) if (!b[it.doc_id]) b[it.doc_id] = it; return b; })()).map((x) => x.rg)) : null,
      wins, losses, ties,
    } : null;
    return { slug: az.slug, label: az.label, n_captures: az.n_captures, headline, models };
  });
  return out;
});

// GET /api/analyzer-board?dataset_id=&analyzer= — single-analyzer board view
// Returns: { analyzer: {...roster}, n_captures, runs: [{run_id, model_config_id, model_name,
//   ref_model_config_id, n_judged, avg_goodness, avg_faithfulness, avg_completeness,
//   ref_avg_goodness, ref_avg_faithfulness, ref_avg_completeness, wins, losses, ties}],
//   docs: [{doc_id, application, judged}] }
app.get('/api/analyzer-board', async (req, reply) => {
  const { dataset_id, analyzer } = req.query;
  if (!dataset_id || !analyzer)
    return reply.code(400).send({ error: 'bad_payload', message: 'dataset_id and analyzer required' });
  const dsId = Number(dataset_id);

  const analyzerRow = d.prepare('SELECT * FROM analyzers WHERE slug = ?').get(analyzer);
  if (!analyzerRow) return reply.code(404).send({ error: `unknown analyzer "${analyzer}"` });

  const n_captures = d.prepare(
    'SELECT COUNT(*) c FROM analyzer_captures WHERE dataset_id = ? AND analyzer_slug = ?'
  ).get(dsId, analyzer).c;

  const runs = d.prepare(`
    SELECT
      ari.run_id,
      ar.model_config_id,
      mc.name AS model_name,
      ar.ref_model_config_id,
      COUNT(*)                              AS n_judged,
      AVG(ari.overall_goodness)             AS avg_goodness,
      AVG(ari.faithfulness)                 AS avg_faithfulness,
      AVG(ari.completeness)                 AS avg_completeness,
      AVG(ari.ref_goodness)                 AS ref_avg_goodness,
      AVG(ari.ref_faithfulness)             AS ref_avg_faithfulness,
      AVG(ari.ref_completeness)             AS ref_avg_completeness,
      SUM(CASE WHEN ari.winner = 'model' THEN 1 ELSE 0 END)     AS wins,
      SUM(CASE WHEN ari.winner = 'reference' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN ari.winner = 'tie' THEN 1 ELSE 0 END)       AS ties
    FROM analyzer_run_items ari
    JOIN analyzer_runs ar ON ar.id = ari.run_id
    JOIN model_configs mc ON mc.id = ar.model_config_id
    WHERE ar.dataset_id = ? AND ari.analyzer_slug = ?
    GROUP BY ari.run_id
    ORDER BY avg_goodness DESC
  `).all(dsId, analyzer);

  // List all captures (docs), flagging whether any run has a result for them.
  const docs = d.prepare(`
    SELECT
      ac.doc_id,
      ac.application,
      EXISTS(
        SELECT 1 FROM analyzer_run_items ari
        JOIN analyzer_runs ar ON ar.id = ari.run_id
        WHERE ar.dataset_id = ? AND ari.analyzer_slug = ? AND ari.doc_id = ac.doc_id
      ) AS judged
    FROM analyzer_captures ac
    WHERE ac.dataset_id = ? AND ac.analyzer_slug = ?
    ORDER BY ac.doc_id
  `).all(dsId, analyzer, dsId, analyzer);

  return { analyzer: analyzerRow, n_captures, runs, docs };
});

// GET /api/analyzer-doc?dataset_id=&analyzer=&doc_id=&run_id= — diff for one capture
// Returns: { doc_id, application, product_type, input (parsed), reference_output (parsed),
//   run: { model_name, output (parsed), overall_goodness, faithfulness, completeness,
//     score_rationale, hallucinations, omissions, factual_errors, winner,
//     comparison_summary, agreements,
//     reference: { model_name, goodness, faithfulness, completeness, score_rationale,
//       hallucinations, omissions, factual_errors } } }
app.get('/api/analyzer-doc', async (req, reply) => {
  const { dataset_id, analyzer, doc_id, run_id } = req.query;
  if (!dataset_id || !analyzer || !doc_id || !run_id)
    return reply.code(400).send({ error: 'bad_payload', message: 'dataset_id, analyzer, doc_id, and run_id required' });
  const dsId = Number(dataset_id);
  const runId = Number(run_id);

  const cap = d.prepare(`
    SELECT doc_id, application, product_type, input_json, reference_output_json
    FROM analyzer_captures
    WHERE dataset_id = ? AND analyzer_slug = ? AND doc_id = ?
  `).get(dsId, analyzer, doc_id);
  if (!cap) return reply.code(404).send({ error: 'capture not found' });

  const item = d.prepare(`
    SELECT ari.*, ar.model_config_id, mc.name AS model_name,
           ar.ref_model_config_id, rmc.name AS ref_model_name
    FROM analyzer_run_items ari
    JOIN analyzer_runs ar ON ar.id = ari.run_id
    JOIN model_configs mc ON mc.id = ar.model_config_id
    LEFT JOIN model_configs rmc ON rmc.id = ar.ref_model_config_id
    WHERE ari.run_id = ? AND ari.analyzer_slug = ? AND ari.doc_id = ?
  `).get(runId, analyzer, doc_id);

  const parseField = (s) => { try { return s ? JSON.parse(s) : null; } catch { return s; } };
  const parseOut = (s) => {
    if (!s) return null;
    try { const p = JSON.parse(s); return p.json !== undefined ? p.json : p.text; } catch { return s; }
  };

  const result = {
    doc_id: cap.doc_id,
    application: cap.application,
    product_type: cap.product_type,
    input: parseField(cap.input_json),
    reference_output: parseField(cap.reference_output_json),
    run: null,
  };

  if (item) {
    result.run = {
      model_name: item.model_name,
      output: parseOut(item.output_json),
      overall_goodness: item.overall_goodness,
      faithfulness: item.faithfulness,
      completeness: item.completeness,
      score_rationale: parseField(item.score_rationale_json),
      hallucinations: parseField(item.hallucinations_json),
      omissions: parseField(item.omissions_json),
      factual_errors: parseField(item.factual_errors_json),
      winner: item.winner,
      comparison_summary: item.comparison_summary,
      agreements: item.agreements,
      reference: {
        model_name: item.ref_model_name ?? item.ref_model_config_id ?? null,
        goodness: item.ref_goodness,
        faithfulness: item.ref_faithfulness,
        completeness: item.ref_completeness,
        score_rationale: parseField(item.ref_score_rationale_json),
        hallucinations: parseField(item.ref_hallucinations_json),
        omissions: parseField(item.ref_omissions_json),
        factual_errors: parseField(item.ref_factual_errors_json),
      },
    };
  }

  return result;
});

// ---- static frontend ------------------------------------------------------
app.register(fastifyStatic, { root: path.join(ROOT, 'public') });

const port = Number(process.env.PORT || 5173);
app.listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`Artha leaderboard on http://0.0.0.0:${port}`))
  .catch((e) => { console.error(e); process.exit(1); });

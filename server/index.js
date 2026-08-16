import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, ROOT } from './db.js';
import { createRun, loadClassBuckets, masterClasses, loadFieldSchema } from './runs.js';
import { aggregateTask } from './scoring/aggregate.js';
import { ingestWandb } from './ingest/wandb.js';
import { config, authConfigured } from './config.js';
import { verifyPassword, issueToken, verifyToken, parseCookies, sessionCookie, clearCookie, COOKIE_NAME } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
const d = db();

const TASKS = ['segmentation', 'classification', 'extraction', 'segregation'];

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

// The master class taxonomy (grows over time; profiles + enabled/disabled reference it).
app.get('/api/classes', async () => d.prepare('SELECT code, label, bucket FROM class_taxonomy ORDER BY code').all());

// Classifier profiles = named enabled subsets of the master list (classification).
app.get('/api/classifier-profiles', async () => {
  const profs = d.prepare('SELECT * FROM classifier_profiles ORDER BY name').all();
  const cnt = d.prepare('SELECT COUNT(*) c FROM profile_classes WHERE profile_id = ?');
  for (const p of profs) p.n_classes = cnt.get(p.id).c;
  return profs;
});
app.post('/api/classifier-profiles', async (req, reply) => {
  const { name, classes = [], notes } = req.body || {};
  if (!name) return reply.code(400).send({ error: 'name required' });
  try {
    const tx = d.transaction(() => {
      const pid = d.prepare('INSERT INTO classifier_profiles (name, notes) VALUES (?, ?)').run(name, notes ?? null).lastInsertRowid;
      const sel = d.prepare('SELECT id FROM class_taxonomy WHERE code = ?');
      const link = d.prepare('INSERT OR IGNORE INTO profile_classes (profile_id, class_id) VALUES (?, ?)');
      let linked = 0; const missing = [];
      for (const code of classes) { const c = sel.get(String(code)); if (c) { link.run(pid, c.id); linked++; } else missing.push(code); }
      return { pid, linked, missing };
    });
    const { pid, linked, missing } = tx();
    return { id: pid, name, n_classes: linked, missing_codes: missing };
  } catch (e) { return reply.code(400).send({ error: String(e.message || e) }); }
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
  const SCOPES = ['seg-cls', 'extraction', 'segregation'];
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
//         profile_id?, extraction_type_id?, override?, notes? }
app.post('/api/runs', async (req, reply) => {
  const b = req.body || {};
  if (!TASKS.includes(b.task)) return reply.code(400).send({ error: 'bad task' });
  if (!b.predictions || typeof b.predictions !== 'object') return reply.code(400).send({ error: 'predictions object required' });
  return sendResult(reply, createRun(d, {
    task: b.task, datasetId: Number(b.dataset_id), modelId: b.model_config_id,
    predictions: b.predictions, override: b.override,
    profileId: b.profile_id, extractionTypeId: b.extraction_type_id, promptId: b.prompt_id,
    checkpoint: b.checkpoint, notes: b.notes,
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

// Rename a run's display name (run_key / identity stays fixed).
app.patch('/api/runs/:id', async (req, reply) => {
  const { display_name } = req.body || {};
  if (!display_name) return reply.code(400).send({ error: 'display_name required' });
  const info = d.prepare('UPDATE runs SET display_name = ? WHERE id = ?').run(display_name, Number(req.params.id));
  if (!info.changes) return reply.code(404).send({ error: 'not found' });
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
  if (run.enabled_classes_json) run.enabled_classes = JSON.parse(run.enabled_classes_json);
  delete run.enabled_classes_json;
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
  const run = d.prepare('SELECT id, task, extraction_type_id, enabled_classes_json FROM runs WHERE id = ?').get(id);
  if (!run) return reply.code(404).send({ error: 'not found' });

  let atomic, opts = {};
  if (run.task === 'segmentation') {
    atomic = d.prepare('SELECT * FROM analysis_events WHERE run_id = ?').all(id);
    opts = { classBuckets: loadClassBuckets(d) };
  } else {
    atomic = d.prepare('SELECT doc_id, predicted_json, gold_json, correct, detail_json FROM item_results WHERE run_id = ?').all(id);
    if (run.task === 'classification') opts = { master: masterClasses(d), enabled: run.enabled_classes_json ? JSON.parse(run.enabled_classes_json) : null };
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

// ---- static frontend ------------------------------------------------------
app.register(fastifyStatic, { root: path.join(ROOT, 'public') });

const port = Number(process.env.PORT || 5173);
app.listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`Artha leaderboard on http://0.0.0.0:${port}`))
  .catch((e) => { console.error(e); process.exit(1); });

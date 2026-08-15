import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, ROOT, UPLOAD_DIR } from './db.js';
import { scoreTask, checkCoverage } from './scoring/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
const d = db();

const TASKS = ['segmentation', 'classification', 'extraction', 'segregation'];

// ---- reference data -------------------------------------------------------
app.get('/api/health', async () => ({ ok: true }));
app.get('/api/tasks', async () => d.prepare('SELECT slug, label, sort_order FROM tasks ORDER BY sort_order').all());
app.get('/api/models', async () => d.prepare('SELECT id, name, notes FROM model_configs ORDER BY name').all());

// ---- datasets -------------------------------------------------------------
app.get('/api/datasets', async () => d.prepare('SELECT * FROM datasets ORDER BY created_at DESC').all());

app.post('/api/datasets', async (req, reply) => {
  const { name, n_applicants, n_docs, source_manifest, notes } = req.body || {};
  if (!name) return reply.code(400).send({ error: 'name required' });
  try {
    const info = d.prepare(
      `INSERT INTO datasets (name, n_applicants, n_docs, source_manifest, notes)
       VALUES (?, ?, ?, ?, ?)`
    ).run(name, n_applicants ?? null, n_docs ?? null, source_manifest ?? null, notes ?? null);
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

function loadGt(datasetId, task) {
  const rows = d.prepare('SELECT doc_id, gold_json FROM gt_items WHERE dataset_id = ? AND task = ?').all(datasetId, task);
  const gt = {};
  for (const r of rows) gt[r.doc_id] = JSON.parse(r.gold_json);
  return gt;
}

// ---- runs (score a predictions file) --------------------------------------
// Body: { task, dataset_id, model_config_id, predictions: {doc_id: value},
//         profile_id?, extraction_type_id?, override?, notes? }
app.post('/api/runs', async (req, reply) => {
  const b = req.body || {};
  const { task, dataset_id, model_config_id, predictions, profile_id, extraction_type_id, override, notes } = b;
  if (!TASKS.includes(task)) return reply.code(400).send({ error: 'bad task' });
  if (!predictions || typeof predictions !== 'object') return reply.code(400).send({ error: 'predictions object required' });
  if (!d.prepare('SELECT 1 FROM model_configs WHERE id = ?').get(model_config_id))
    return reply.code(400).send({ error: `unknown model_config_id "${model_config_id}"` });

  const gt = loadGt(Number(dataset_id), task);
  const gtIds = Object.keys(gt);
  if (gtIds.length === 0) return reply.code(400).send({ error: 'no ground truth uploaded for this dataset+task' });

  const cov = checkCoverage(Object.keys(predictions), gtIds);
  if (!cov.full && !override) {
    return reply.code(422).send({
      error: 'coverage_incomplete',
      message: `${cov.missing.length} GT doc(s) have no prediction`,
      missing: cov.missing.slice(0, 50),
      missing_count: cov.missing.length,
      hint: 'resubmit with override:true to score the covered subset only',
    });
  }

  // scope GT to covered docs when overriding
  const scoredGt = cov.full ? gt : Object.fromEntries(gtIds.filter((id) => predictions[id] != null).map((id) => [id, gt[id]]));

  let opts = {};
  if (task === 'classification' && profile_id) {
    const codes = d.prepare(
      `SELECT c.code FROM profile_classes pc JOIN class_taxonomy c ON c.id = pc.class_id WHERE pc.profile_id = ?`
    ).all(profile_id).map((r) => r.code);
    opts.profileClasses = codes;
  }
  if (task === 'extraction' && extraction_type_id) {
    const et = d.prepare('SELECT field_schema FROM extraction_types WHERE id = ?').get(extraction_type_id);
    if (et?.field_schema) opts.fieldSchema = JSON.parse(et.field_schema);
  }

  const result = scoreTask(task, predictions, scoredGt, opts);

  const tx = d.transaction(() => {
    const info = d.prepare(
      `INSERT INTO runs (task, dataset_id, model_config_id, extraction_type_id, classifier_profile_id,
                         predictions_path, coverage_status, coverage_missing, source, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'upload', ?)`
    ).run(task, Number(dataset_id), model_config_id, extraction_type_id ?? null, profile_id ?? null,
          null, cov.full ? 'full' : 'partial', cov.missing.length, notes ?? null);
    const runId = info.lastInsertRowid;

    const predPath = path.join(UPLOAD_DIR, `run-${runId}.json`);
    fs.writeFileSync(predPath, JSON.stringify(predictions));
    d.prepare('UPDATE runs SET predictions_path = ? WHERE id = ?').run(predPath, runId);

    const mStmt = d.prepare('INSERT INTO run_metrics (run_id, key, value, scope) VALUES (?, ?, ?, ?)');
    for (const m of result.metrics) mStmt.run(runId, m.key, m.value, m.scope);

    const iStmt = d.prepare(
      'INSERT INTO item_results (run_id, doc_id, predicted_json, gold_json, correct, detail_json) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const it of result.items) iStmt.run(runId, it.doc_id, it.predicted_json, it.gold_json, it.correct, it.detail_json);
    return runId;
  });
  const runId = tx();

  return { run_id: runId, coverage: cov.full ? 'full' : 'partial', missing_count: cov.missing.length, headline: result.headline, metrics: result.metrics };
});

// Manual entry (type a number directly, no predictions file / no scoring).
// Body: { task, dataset_id, model_config_id, metrics: {key: value}, notes? }
app.post('/api/runs/manual', async (req, reply) => {
  const { task, dataset_id, model_config_id, metrics, notes } = req.body || {};
  if (!TASKS.includes(task)) return reply.code(400).send({ error: 'bad task' });
  if (!metrics || typeof metrics !== 'object') return reply.code(400).send({ error: 'metrics object required' });
  if (!d.prepare('SELECT 1 FROM model_configs WHERE id = ?').get(model_config_id))
    return reply.code(400).send({ error: 'unknown model_config_id' });

  const tx = d.transaction(() => {
    const info = d.prepare(
      `INSERT INTO runs (task, dataset_id, model_config_id, coverage_status, source, notes)
       VALUES (?, ?, ?, 'manual', 'manual', ?)`
    ).run(task, Number(dataset_id), model_config_id, notes ?? null);
    const runId = info.lastInsertRowid;
    const mStmt = d.prepare('INSERT INTO run_metrics (run_id, key, value, scope) VALUES (?, ?, ?, ?)');
    for (const [k, v] of Object.entries(metrics)) mStmt.run(runId, k, Number(v), 'overall');
    return runId;
  });
  return { run_id: tx() };
});

// ---- leaderboard ----------------------------------------------------------
app.get('/api/leaderboard', async (req, reply) => {
  const { task, dataset_id } = req.query;
  if (!TASKS.includes(task)) return reply.code(400).send({ error: 'bad task' });
  const runs = d.prepare(
    `SELECT r.*, m.name AS model_name
     FROM runs r JOIN model_configs m ON m.id = r.model_config_id
     WHERE r.task = ? AND r.dataset_id = ? ORDER BY r.created_at DESC`
  ).all(task, Number(dataset_id));
  const metricStmt = d.prepare(`SELECT key, value FROM run_metrics WHERE run_id = ? AND scope = 'overall'`);
  for (const r of runs) r.metrics = Object.fromEntries(metricStmt.all(r.id).map((x) => [x.key, x.value]));
  return runs;
});

app.get('/api/runs/:id', async (req, reply) => {
  const id = Number(req.params.id);
  const run = d.prepare('SELECT r.*, m.name AS model_name FROM runs r JOIN model_configs m ON m.id = r.model_config_id WHERE r.id = ?').get(id);
  if (!run) return reply.code(404).send({ error: 'not found' });
  run.metrics = d.prepare('SELECT key, value, scope FROM run_metrics WHERE run_id = ?').all(id);
  run.items = d.prepare('SELECT doc_id, predicted_json, gold_json, correct, detail_json FROM item_results WHERE run_id = ? LIMIT 2000').all(id);
  return run;
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

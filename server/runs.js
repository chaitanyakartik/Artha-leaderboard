// Shared run-creation core. The UI upload, manual entry, and W&B auto-ingest all funnel
// through createRun() so identity, dedup, coverage and scoring behave identically everywhere.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { UPLOAD_DIR } from './db.js';
import { scoreTask, checkCoverage } from './scoring/index.js';
import { normalizeLabel } from './scoring/util.js';
import { semanticName, makeRunKey } from './naming.js';

// Stable hash of a GT set (sorted doc_ids + gold). Lets auto-ingest assert "the GT matches"
// the eval a training run was scored against, and detects GT drift between runs.
export function gtFingerprint(gt) {
  const norm = Object.keys(gt).sort().map((k) => `${k}:${JSON.stringify(gt[k])}`).join('|');
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

export function loadGt(d, datasetId, task) {
  const rows = d.prepare('SELECT doc_id, gold_json FROM gt_items WHERE dataset_id = ? AND task = ?').all(datasetId, task);
  const gt = {};
  for (const r of rows) gt[r.doc_id] = JSON.parse(r.gold_json);
  return gt;
}

function scoringOpts(d, task, { profileId, extractionTypeId }) {
  const opts = {};
  if (task === 'classification' && profileId) {
    opts.profileClasses = d.prepare(
      `SELECT c.code FROM profile_classes pc JOIN class_taxonomy c ON c.id = pc.class_id WHERE pc.profile_id = ?`
    ).all(profileId).map((r) => r.code);
  }
  if (task === 'extraction' && extractionTypeId) {
    const et = d.prepare('SELECT field_schema FROM extraction_types WHERE id = ?').get(extractionTypeId);
    if (et?.field_schema) opts.fieldSchema = JSON.parse(et.field_schema);
  }
  if (task === 'segmentation') {
    // class -> bucket map for the bucket-level "popular misses". Empty until the taxonomy's
    // `bucket` column is populated (schema pending); keys normalized to match the scorer.
    const rows = d.prepare('SELECT code, bucket FROM class_taxonomy WHERE bucket IS NOT NULL').all();
    if (rows.length) opts.classBuckets = Object.fromEntries(rows.map((r) => [normalizeLabel(r.code), r.bucket]));
  }
  return opts;
}

// Insert a run row, retrying on the (astronomically unlikely) run_key UNIQUE collision.
function insertRunRow(d, base, fields) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const run_key = makeRunKey(base);
      const info = d.prepare(
        `INSERT INTO runs (run_key, display_name, task, dataset_id, model_config_id,
                           extraction_type_id, classifier_profile_id, predictions_path,
                           coverage_status, coverage_missing, source, origin, external_ref,
                           gt_fingerprint, analysis_json, notes)
         VALUES (@run_key, @display_name, @task, @dataset_id, @model_config_id,
                 @extraction_type_id, @classifier_profile_id, @predictions_path,
                 @coverage_status, @coverage_missing, @source, @origin, @external_ref,
                 @gt_fingerprint, @analysis_json, @notes)`
      ).run({ run_key, ...fields });
      return { run_id: info.lastInsertRowid, run_key };
    } catch (e) {
      if (String(e.message).includes('runs.run_key') && attempt < 4) continue;
      throw e;
    }
  }
}

// params: { task, datasetId, modelId, origin='ui', externalRef=null, notes=null,
//           predictions=null, manualMetrics=null, override=false,
//           profileId=null, extractionTypeId=null, date=new Date() }
// Returns a discriminated result: { ok:true, ... } or { ok:false, code, message, ... }.
export function createRun(d, params) {
  const {
    task, datasetId, modelId, origin = 'ui', externalRef = null, notes = null,
    predictions = null, manualMetrics = null, override = false,
    profileId = null, extractionTypeId = null, date = new Date(),
  } = params;

  const model = d.prepare('SELECT id, name FROM model_configs WHERE id = ?').get(modelId);
  if (!model) return { ok: false, code: 'unknown_model', message: `unknown model_config_id "${modelId}"` };
  const dataset = d.prepare('SELECT id, name FROM datasets WHERE id = ?').get(datasetId);
  if (!dataset) return { ok: false, code: 'unknown_dataset', message: 'dataset not found' };

  // Dedup: the same external run must not be ingested twice.
  if (externalRef) {
    const dupe = d.prepare('SELECT id, run_key FROM runs WHERE origin = ? AND external_ref = ?').get(origin, externalRef);
    if (dupe) return { ok: false, code: 'duplicate_external', message: `already ingested as run ${dupe.id}`, run_id: dupe.id, run_key: dupe.run_key };
  }

  const base = semanticName({ task, dataset: dataset.name, model: model.name, date });

  // ---- manual entry: numbers typed in, no scoring ----
  if (manualMetrics) {
    const tx = d.transaction(() => {
      const { run_id } = insertRunRow(d, base, {
        display_name: base, task, dataset_id: datasetId, model_config_id: modelId,
        extraction_type_id: extractionTypeId, classifier_profile_id: profileId,
        predictions_path: null, coverage_status: 'manual', coverage_missing: 0,
        source: 'manual', origin, external_ref: externalRef, gt_fingerprint: null,
        analysis_json: null, notes,
      });
      const mStmt = d.prepare('INSERT INTO run_metrics (run_id, key, value, scope) VALUES (?, ?, ?, ?)');
      for (const [k, v] of Object.entries(manualMetrics)) mStmt.run(run_id, k, Number(v), 'overall');
      return run_id;
    });
    const run_id = tx();
    return { ok: true, run_id, display_name: base, coverage: 'manual' };
  }

  // ---- scored: predictions vs stored GT ----
  const gt = loadGt(d, datasetId, task);
  const gtIds = Object.keys(gt);
  if (gtIds.length === 0) return { ok: false, code: 'no_gt', message: 'no ground truth uploaded for this dataset+task' };

  const cov = checkCoverage(Object.keys(predictions || {}), gtIds);
  if (!cov.full && !override) {
    return {
      ok: false, code: 'coverage_incomplete',
      message: `${cov.missing.length} GT doc(s) have no prediction`,
      missing: cov.missing.slice(0, 50), missing_count: cov.missing.length,
    };
  }
  const scoredGt = cov.full ? gt : Object.fromEntries(gtIds.filter((id) => predictions[id] != null).map((id) => [id, gt[id]]));
  const result = scoreTask(task, predictions, scoredGt, scoringOpts(d, task, { profileId, extractionTypeId }));

  const tx = d.transaction(() => {
    const { run_id } = insertRunRow(d, base, {
      display_name: base, task, dataset_id: datasetId, model_config_id: modelId,
      extraction_type_id: extractionTypeId, classifier_profile_id: profileId,
      predictions_path: null, coverage_status: cov.full ? 'full' : 'partial',
      coverage_missing: cov.missing.length, source: 'upload', origin, external_ref: externalRef,
      gt_fingerprint: gtFingerprint(gt),
      analysis_json: result.analysis ? JSON.stringify(result.analysis) : null, notes,
    });
    const predPath = path.join(UPLOAD_DIR, `run-${run_id}.json`);
    fs.writeFileSync(predPath, JSON.stringify(predictions));
    d.prepare('UPDATE runs SET predictions_path = ? WHERE id = ?').run(predPath, run_id);

    const mStmt = d.prepare('INSERT INTO run_metrics (run_id, key, value, scope) VALUES (?, ?, ?, ?)');
    for (const m of result.metrics) mStmt.run(run_id, m.key, m.value, m.scope);
    const iStmt = d.prepare('INSERT INTO item_results (run_id, doc_id, predicted_json, gold_json, correct, detail_json) VALUES (?, ?, ?, ?, ?, ?)');
    for (const it of result.items) iStmt.run(run_id, it.doc_id, it.predicted_json, it.gold_json, it.correct, it.detail_json);
    return run_id;
  });
  const run_id = tx();

  return {
    ok: true, run_id, display_name: base,
    coverage: cov.full ? 'full' : 'partial', missing_count: cov.missing.length,
    headline: result.headline, metrics: result.metrics, analysis: result.analysis || null,
  };
}

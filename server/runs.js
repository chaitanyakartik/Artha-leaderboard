// Shared run-creation core. The UI upload, manual entry, and W&B auto-ingest all funnel
// through createRun() so identity, dedup, coverage and scoring behave identically everywhere.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { UPLOAD_DIR } from './db.js';
import { scoreTask, checkCoverage } from './scoring/index.js';
import { validatePredictions } from './scoring/validate.js';
import { normalizeLabel } from './scoring/util.js';
import { semanticName, makeRunKey } from './naming.js';

// Stable hash of a GT set (sorted doc_ids + gold). Lets auto-ingest assert "the GT matches"
// the eval a training run was scored against, and detects GT drift between runs.
export function gtFingerprint(gt) {
  const norm = Object.keys(gt).sort().map((k) => `${k}:${JSON.stringify(gt[k])}`).join('|');
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

// class -> bucket map (KYC/PKYC/ITR/...), keyed by the normalized class code so it matches the
// scorer. Empty until class_taxonomy.bucket is populated. Shared by scoring + re-aggregation.
export function loadClassBuckets(d) {
  const rows = d.prepare('SELECT code, bucket FROM class_taxonomy WHERE bucket IS NOT NULL').all();
  return Object.fromEntries(rows.map((r) => [normalizeLabel(r.code), r.bucket]));
}

// The master class taxonomy (code + label + bucket). Feeds per-run taxonomy-coverage.
export function loadTaxonomy(d) {
  return d.prepare('SELECT code, label, bucket FROM class_taxonomy').all();
}

export function loadGt(d, datasetId, task) {
  const rows = d.prepare('SELECT doc_id, gold_json FROM gt_items WHERE dataset_id = ? AND task = ?').all(datasetId, task);
  const gt = {};
  for (const r of rows) gt[r.doc_id] = JSON.parse(r.gold_json);
  return gt;
}

// An extraction type's field schema ([{name,type}]).
export function loadFieldSchema(d, typeId) {
  if (!typeId) return null;
  const et = d.prepare('SELECT field_schema FROM extraction_types WHERE id = ?').get(typeId);
  return et?.field_schema ? JSON.parse(et.field_schema) : null;
}

function scoringOpts(d, task, { extractionTypeId }) {
  const opts = {};
  if (task === 'extraction' && extractionTypeId) {
    const schema = loadFieldSchema(d, extractionTypeId);
    if (schema) opts.fieldSchema = schema;
  }
  if (task === 'segmentation') {
    const bk = loadClassBuckets(d);
    if (Object.keys(bk).length) opts.classBuckets = bk;
  }
  if (task === 'classification' || task === 'segmentation') opts.taxonomy = loadTaxonomy(d);
  return opts;
}

// Insert a run row, retrying on the (astronomically unlikely) run_key UNIQUE collision.
function insertRunRow(d, base, fields) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const run_key = makeRunKey(base);
      const info = d.prepare(
        `INSERT INTO runs (run_key, display_name, task, dataset_id, model_config_id,
                           extraction_type_id, predictions_path,
                           coverage_status, coverage_missing, source, origin, external_ref,
                           gt_fingerprint, analysis_json, prompt_id, supported_classes_json, checkpoint, notes)
         VALUES (@run_key, @display_name, @task, @dataset_id, @model_config_id,
                 @extraction_type_id, @predictions_path,
                 @coverage_status, @coverage_missing, @source, @origin, @external_ref,
                 @gt_fingerprint, @analysis_json, @prompt_id, @supported_classes_json, @checkpoint, @notes)`
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
//           extractionTypeId=null, promptId=null, date=new Date() }
// Returns a discriminated result: { ok:true, ... } or { ok:false, code, message, ... }.
export function createRun(d, params) {
  const {
    task, datasetId, modelId, origin = 'ui', externalRef = null, notes = null,
    predictions = null, manualMetrics = null, override = false,
    extractionTypeId = null, promptId = null, checkpoint = null,
    supportedClasses = null, date = new Date(),
  } = params;
  const supportedJson = Array.isArray(supportedClasses) ? JSON.stringify(supportedClasses) : null;

  const model = d.prepare('SELECT id, name FROM model_configs WHERE id = ?').get(modelId);
  if (!model) return { ok: false, code: 'unknown_model', message: `unknown model_config_id "${modelId}"` };
  const dataset = d.prepare('SELECT id, name, seg_window_mode FROM datasets WHERE id = ?').get(datasetId);
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
        extraction_type_id: extractionTypeId,
        predictions_path: null, coverage_status: 'manual', coverage_missing: 0,
        source: 'manual', origin, external_ref: externalRef, gt_fingerprint: null,
        analysis_json: null, prompt_id: promptId, supported_classes_json: supportedJson, checkpoint, notes,
      });
      const mStmt = d.prepare('INSERT INTO run_metrics (run_id, key, value, scope) VALUES (?, ?, ?, ?)');
      for (const [k, v] of Object.entries(manualMetrics)) mStmt.run(run_id, k, Number(v), 'overall');
      return run_id;
    });
    const run_id = tx();
    return { ok: true, run_id, display_name: base, coverage: 'manual' };
  }

  // ---- scored: predictions vs stored GT ----
  const shapeErr = validatePredictions(task, predictions);
  if (shapeErr) return { ok: false, code: 'bad_payload', message: shapeErr.message, expected: shapeErr.expected };

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
  const opts = scoringOpts(d, task, { extractionTypeId });
  if (task === 'segmentation') opts.windowMode = !!dataset.seg_window_mode;
  if (supportedClasses) opts.supportedClasses = supportedClasses; // DECLARED support (never inferred)
  const result = scoreTask(task, predictions, scoredGt, opts);

  const tx = d.transaction(() => {
    const { run_id } = insertRunRow(d, base, {
      display_name: base, task, dataset_id: datasetId, model_config_id: modelId,
      extraction_type_id: extractionTypeId,
      predictions_path: null, coverage_status: cov.full ? 'full' : 'partial',
      coverage_missing: cov.missing.length, source: 'upload', origin, external_ref: externalRef,
      gt_fingerprint: gtFingerprint(gt),
      analysis_json: result.analysis ? JSON.stringify(result.analysis) : null,
      prompt_id: promptId, supported_classes_json: supportedJson, checkpoint, notes,
    });
    const predPath = path.join(UPLOAD_DIR, `run-${run_id}.json`);
    fs.writeFileSync(predPath, JSON.stringify(predictions));
    d.prepare('UPDATE runs SET predictions_path = ? WHERE id = ?').run(predPath, run_id);

    const mStmt = d.prepare('INSERT INTO run_metrics (run_id, key, value, scope) VALUES (?, ?, ?, ?)');
    for (const m of result.metrics) mStmt.run(run_id, m.key, m.value, m.scope);
    const iStmt = d.prepare('INSERT INTO item_results (run_id, doc_id, predicted_json, gold_json, correct, detail_json) VALUES (?, ?, ?, ?, ?, ?)');
    for (const it of result.items) iStmt.run(run_id, it.doc_id, it.predicted_json, it.gold_json, it.correct, it.detail_json);

    // Durable atomic events — the re-aggregatable layer (segmentation emits these).
    if (result.events && result.events.length) {
      const eStmt = d.prepare(
        `INSERT INTO analysis_events (run_id, doc_id, page, gt_tag, pred_tag, gt_class, pred_class,
           gt_seg_class, pred_seg_class, gt_bucket, pred_bucket, gt_boundary, pred_boundary,
           error_type, confidence, prev_gt_class)
         VALUES (@run_id, @doc_id, @page, @gt_tag, @pred_tag, @gt_class, @pred_class,
           @gt_seg_class, @pred_seg_class, @gt_bucket, @pred_bucket, @gt_boundary, @pred_boundary,
           @error_type, @confidence, @prev_gt_class)`
      );
      for (const e of result.events) eStmt.run({ run_id, ...e });
    }
    return run_id;
  });
  const run_id = tx();

  return {
    ok: true, run_id, display_name: base,
    coverage: cov.full ? 'full' : 'partial', missing_count: cov.missing.length,
    headline: result.headline, metrics: result.metrics, analysis: result.analysis || null,
  };
}

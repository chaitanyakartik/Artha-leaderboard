// W&B auto-ingest — SCAFFOLD, disabled by default (enable with ARTHA_WANDB_INGEST=on).
//
// Future flow: a training run finishes -> its final eval (predictions or metrics) is POSTed
// here -> if the GT for that dataset+task matches what it was scored against, we auto-create a
// run via createRun() with origin:'wandb'. The wandb run path is the external_ref, so the same
// run can't be ingested twice. The run gets a semantic name now; you can rename it later.
//
// Nothing here scores differently — it reuses the exact same createRun() core as the UI.
import { createRun, loadGt, gtFingerprint } from '../runs.js';

// Expected payload shape (documented contract; validated loosely for now):
// {
//   wandb: { entity, project, run_id, run_url },   // provenance -> external_ref
//   task, dataset_id, model_config_id,
//   predictions: { doc_id: value },  // OR  metrics: { key: value } for a pre-computed eval
//   gt_fingerprint?: "…"             // optional: assert the GT the run was scored against
// }
export function ingestWandb(d, payload) {
  const { wandb, task, dataset_id, model_config_id, predictions, metrics, gt_fingerprint } = payload || {};
  if (!wandb?.run_id) return { ok: false, code: 'bad_payload', message: 'wandb.run_id required' };
  if (!task || !dataset_id || !model_config_id) return { ok: false, code: 'bad_payload', message: 'task, dataset_id, model_config_id required' };

  const externalRef = wandb.run_url || `${wandb.entity || ''}/${wandb.project || ''}/${wandb.run_id}`;

  // "GT matches" gate: only auto-log if the caller's GT fingerprint matches our stored GT.
  if (gt_fingerprint) {
    const current = gtFingerprint(loadGt(d, Number(dataset_id), task));
    if (current !== gt_fingerprint) {
      return { ok: false, code: 'gt_mismatch', message: 'GT fingerprint does not match stored ground truth', expected: current };
    }
  }

  return createRun(d, {
    task,
    datasetId: Number(dataset_id),
    modelId: model_config_id,
    origin: 'wandb',
    externalRef,
    notes: `auto-ingested from W&B ${externalRef}`,
    ...(predictions ? { predictions, override: true } : { manualMetrics: metrics || {} }),
  });
}

// Dispatch to the per-task scorer.
import * as classification from './classification.js';
import * as extraction from './extraction.js';
import * as segmentation from './segmentation.js';
import * as segregation from './segregation.js';

const SCORERS = { classification, extraction, segmentation, segregation };

export function scoreTask(task, pred, gt, opts = {}) {
  const scorer = SCORERS[task];
  if (!scorer) throw new Error(`no scorer for task "${task}"`);
  return scorer.score(pred, gt, opts);
}

// Coverage gate: every GT doc_id must appear in the predictions file.
export function checkCoverage(predIds, gtIds) {
  const predSet = new Set(predIds);
  const gtSet = new Set(gtIds);
  const missing = gtIds.filter((id) => !predSet.has(id)); // GT docs with no prediction
  const extra = predIds.filter((id) => !gtSet.has(id));   // predictions with no GT
  return { full: missing.length === 0, missing, extra };
}

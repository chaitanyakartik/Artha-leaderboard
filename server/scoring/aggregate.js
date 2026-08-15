// Task-dispatched aggregation over a run's ATOMIC layer:
//   segmentation -> analysis_events (per page)   ·   classification/extraction -> item_results (per doc)
// Same function runs at score time (in-memory atomic rows) and on demand (rows loaded from the DB),
// so a new analysis view — or a grown class taxonomy — re-aggregates old runs without re-scoring.
import { aggregate as segmentation } from './seg_aggregate.js';
import { aggregate as classification } from './class_aggregate.js';
import { aggregate as extraction } from './extraction_aggregate.js';

const AGG = { segmentation, classification, extraction };

export function aggregateTask(task, atomic, opts = {}) {
  const fn = AGG[task];
  return fn ? fn(atomic, opts) : null;
}

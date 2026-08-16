// Classification scorer — stores one atomic row per doc; all breakdowns derive in class_aggregate.js.
// pred/gt: doc_id -> class code (string) | { class|label|predicted, confidence? }
// Every GT doc is scored against its true class (no enabled/disabled scoping — see git history:
// classifier profiles were removed; extraction keeps templates because file type matters there).
import { normalizeLabel } from './util.js';
import { aggregate } from './class_aggregate.js';

const cls = (v) => {
  if (v == null) return null;
  const raw = typeof v === 'object' ? (v.class ?? v.label ?? v.predicted ?? null) : v;
  return raw == null ? null : normalizeLabel(raw);
};

export function score(pred, gt, opts = {}) {
  const items = [];
  for (const doc of Object.keys(gt)) {
    const truth = cls(gt[doc]);
    if (truth == null) continue;
    const p = cls(pred[doc]);
    items.push({
      doc_id: doc,
      predicted_json: JSON.stringify(p),
      gold_json: JSON.stringify(String(truth)),
      correct: p === truth ? 1 : 0,
      detail_json: null,
    });
  }

  const analysis = aggregate(items, { taxonomy: opts.taxonomy, supportedClasses: opts.supportedClasses });
  const metrics = [
    { key: 'accuracy', value: analysis.accuracy, scope: 'overall' },
    { key: 'macro_f1', value: analysis.macro_f1, scope: 'overall' },
    { key: 'n_scored', value: analysis.overview.n_scored, scope: 'overall' },
  ];
  for (const c of analysis.per_class) metrics.push({ key: `class:${c.class}:f1`, value: c.f1, scope: 'per_class' });

  return { headline: { key: 'accuracy', value: analysis.accuracy }, metrics, items, analysis };
}

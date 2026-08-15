// Classification scorer — stores one atomic row per doc; all breakdowns derive in class_aggregate.js.
// pred/gt: doc_id -> class code (string) | { class|label|predicted, confidence? }
// opts.profileClasses: the classes this run's model was enabled/trained for (the enabled snapshot).
//   When given, metrics are SCOPED to docs whose true class is in that subset; out-of-scope docs are
//   kept as items (flagged in_scope:false) so the aggregator can still count them.
// opts.master: the full class taxonomy (for enabled-vs-disabled).
import { normalizeLabel } from './util.js';
import { aggregate } from './class_aggregate.js';

const cls = (v) => {
  if (v == null) return null;
  const raw = typeof v === 'object' ? (v.class ?? v.label ?? v.predicted ?? null) : v;
  return raw == null ? null : normalizeLabel(raw);
};

export function score(pred, gt, opts = {}) {
  const { profileClasses } = opts;
  const scope = profileClasses && profileClasses.length ? new Set(profileClasses.map(normalizeLabel)) : null;

  const items = [];
  for (const doc of Object.keys(gt)) {
    const truth = cls(gt[doc]);
    if (truth == null) continue;
    const inScope = !scope || scope.has(String(truth));
    const p = cls(pred[doc]);
    const correct = inScope ? (p === truth ? 1 : 0) : null;
    items.push({
      doc_id: doc,
      predicted_json: JSON.stringify(p),
      gold_json: JSON.stringify(String(truth)),
      correct,
      detail_json: JSON.stringify({ in_scope: inScope }),
    });
  }

  const analysis = aggregate(items, { master: opts.master || [], enabled: profileClasses || null });
  const metrics = [
    { key: 'accuracy', value: analysis.accuracy, scope: 'overall' },
    { key: 'macro_f1', value: analysis.macro_f1, scope: 'overall' },
    { key: 'n_scored', value: analysis.overview.n_scored, scope: 'overall' },
    { key: 'n_out_of_scope', value: analysis.overview.n_out_of_scope, scope: 'overall' },
  ];
  for (const c of analysis.per_class) metrics.push({ key: `class:${c.class}:f1`, value: c.f1, scope: 'per_class' });

  return { headline: { key: 'accuracy', value: analysis.accuracy }, metrics, items, analysis };
}

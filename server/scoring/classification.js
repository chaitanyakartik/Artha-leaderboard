// Classification scorer.
// pred:  doc_id -> class code (string) | { class|label|predicted, confidence? }
// gt:    doc_id -> class code (string) | { class|label }
// opts.profileClasses: optional array of class codes the classifier was trained for.
//   When given, metrics are SCOPED to docs whose true class is in that subset.
import { prf, round } from './util.js';

const cls = (v) => {
  if (v == null) return null;
  if (typeof v === 'object') return v.class ?? v.label ?? v.predicted ?? null;
  return v;
};

export function score(pred, gt, { profileClasses } = {}) {
  const scope = profileClasses && profileClasses.length ? new Set(profileClasses.map(String)) : null;
  const stats = new Map(); // label -> {tp, fp, fn}
  const bump = (label, k) => {
    if (!stats.has(label)) stats.set(label, { tp: 0, fp: 0, fn: 0 });
    stats.get(label)[k]++;
  };

  const items = [];
  let n = 0, correct = 0, skipped = 0;

  for (const doc of Object.keys(gt)) {
    const truth = cls(gt[doc]);
    if (truth == null) continue;
    const t = String(truth);
    if (scope && !scope.has(t)) { skipped++; continue; }

    const p = cls(pred[doc]);
    const pc = p == null ? null : String(p);
    const ok = pc === t;
    n++; if (ok) correct++;

    if (ok) bump(t, 'tp');
    else { bump(t, 'fn'); if (pc != null) bump(pc, 'fp'); }

    items.push({
      doc_id: doc,
      predicted_json: JSON.stringify(pc),
      gold_json: JSON.stringify(t),
      correct: ok ? 1 : 0,
      detail_json: null,
    });
  }

  const labels = [...stats.keys()];
  const perClass = labels.map((l) => ({ label: l, ...prf(stats.get(l).tp, stats.get(l).fp, stats.get(l).fn) }));
  const macroF1 = labels.length ? round(perClass.reduce((s, c) => s + c.f1, 0) / labels.length) : 0;
  const accuracy = n ? round(correct / n) : 0;

  const metrics = [
    { key: 'accuracy', value: accuracy, scope: 'overall' },
    { key: 'macro_f1', value: macroF1, scope: 'overall' },
    { key: 'n_scored', value: n, scope: 'overall' },
    { key: 'n_out_of_scope', value: skipped, scope: 'overall' },
  ];
  for (const c of perClass) metrics.push({ key: `class:${c.label}:f1`, value: c.f1, scope: 'per_class' });

  return { headline: { key: 'accuracy', value: accuracy }, metrics, items };
}

// Extraction scorer — field-typed matching ("real accuracy", not raw exact-match).
// pred: doc_id -> { field: value }
// gt:   doc_id -> { field: value }
// opts.fieldSchema: optional [{ name, type }] (type: string|number|amount|date).
//   Missing schema => all fields treated as string; field set inferred from GT.
import { fieldMatch, round } from './util.js';

export function score(pred, gt, { fieldSchema } = {}) {
  const typeOf = new Map((fieldSchema || []).map((f) => [f.name, f.type || 'string']));

  const fieldStats = new Map(); // field -> {correct, total}
  const bump = (field, ok) => {
    if (!fieldStats.has(field)) fieldStats.set(field, { correct: 0, total: 0 });
    const s = fieldStats.get(field);
    s.total++; if (ok) s.correct++;
  };

  const items = [];
  let docExact = 0, nDocs = 0, totalFields = 0, correctFields = 0;

  for (const doc of Object.keys(gt)) {
    const g = gt[doc] || {};
    const p = pred[doc] || {};
    const fields = Object.keys(g);
    let allOk = fields.length > 0;
    const detail = {};

    for (const f of fields) {
      const ok = fieldMatch(p[f], g[f], typeOf.get(f) || 'string');
      bump(f, ok);
      detail[f] = { pred: p[f] ?? null, gold: g[f], ok };
      totalFields++; if (ok) correctFields++; else allOk = false;
    }

    nDocs++; if (allOk) docExact++;
    items.push({
      doc_id: doc,
      predicted_json: JSON.stringify(p),
      gold_json: JSON.stringify(g),
      correct: allOk ? 1 : 0,
      detail_json: JSON.stringify(detail),
    });
  }

  const fieldAccuracy = totalFields ? round(correctFields / totalFields) : 0;
  const docExactMatch = nDocs ? round(docExact / nDocs) : 0;

  const metrics = [
    { key: 'field_accuracy', value: fieldAccuracy, scope: 'overall' },
    { key: 'doc_exact_match', value: docExactMatch, scope: 'overall' },
    { key: 'n_docs', value: nDocs, scope: 'overall' },
  ];
  for (const [f, s] of fieldStats) {
    metrics.push({ key: `field:${f}`, value: s.total ? round(s.correct / s.total) : 0, scope: 'per_field' });
  }

  return { headline: { key: 'field_accuracy', value: fieldAccuracy }, metrics, items };
}

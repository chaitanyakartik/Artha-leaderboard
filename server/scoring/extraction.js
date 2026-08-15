// Extraction scorer — field-typed matching; stores raw pred/gold per field so char-similarity and
// macro/micro can be re-derived later. All breakdowns live in extraction_aggregate.js.
// pred/gt: doc_id -> { field: value }
// opts.fieldSchema: optional [{ name, type }] (type: string|number|amount|date). Missing schema =>
//   all fields string; field set inferred from GT (present-based support).
import { fieldMatch } from './util.js';
import { aggregate } from './extraction_aggregate.js';

export function score(pred, gt, opts = {}) {
  const fieldSchema = opts.fieldSchema;
  const typeOf = new Map((fieldSchema || []).map((f) => [f.name, f.type || 'string']));

  const items = [];
  for (const doc of Object.keys(gt)) {
    const g = gt[doc] || {};
    const p = pred[doc] || {};
    const detail = {};
    for (const f of Object.keys(g)) {
      detail[f] = { pred: p[f] ?? null, gold: g[f], ok: fieldMatch(p[f], g[f], typeOf.get(f) || 'string') };
    }
    const allOk = Object.keys(g).length > 0 && Object.values(detail).every((x) => x.ok);
    items.push({
      doc_id: doc,
      predicted_json: JSON.stringify(p),
      gold_json: JSON.stringify(g),
      correct: allOk ? 1 : 0,
      detail_json: JSON.stringify(detail),
    });
  }

  const analysis = aggregate(items, { fieldSchema });
  const metrics = [
    { key: 'field_accuracy', value: analysis.field_accuracy, scope: 'overall' },        // micro (headline)
    { key: 'macro_field_accuracy', value: analysis.macro_field_accuracy, scope: 'overall' },
    { key: 'char_similarity', value: analysis.micro_char_sim, scope: 'overall' },
    { key: 'doc_exact_match', value: analysis.doc_exact_match, scope: 'overall' },
    { key: 'n_docs', value: analysis.overview.n_docs, scope: 'overall' },
  ];
  for (const f of analysis.per_field) metrics.push({ key: `field:${f.field}`, value: f.accuracy, scope: 'per_field' });

  return { headline: { key: 'field_accuracy', value: analysis.field_accuracy }, metrics, items, analysis };
}

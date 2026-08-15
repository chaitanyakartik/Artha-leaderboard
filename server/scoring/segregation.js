// Segregation scorer  [semantics DRAFT — confirm what a "group" is: applicant? category?].
// Model: each doc is assigned to a group. Group labels are arbitrary, so we score the
// PARTITION agreement, not label equality.
// pred/gt: doc_id -> group_id (string|number)
// Metrics: Adjusted Rand Index (chance-corrected partition agreement) + purity.
import { choose2, round } from './util.js';

export function score(pred, gt) {
  const docs = Object.keys(gt).filter((d) => pred[d] != null);
  const n = docs.length;

  // Contingency table: gtGroup -> predGroup -> count
  const table = new Map();
  const aRow = new Map(); // gt group totals
  const bCol = new Map(); // pred group totals
  for (const d of docs) {
    const g = String(gt[d]);
    const p = String(pred[d]);
    if (!table.has(g)) table.set(g, new Map());
    const row = table.get(g);
    row.set(p, (row.get(p) || 0) + 1);
    aRow.set(g, (aRow.get(g) || 0) + 1);
    bCol.set(p, (bCol.get(p) || 0) + 1);
  }

  let sumCellC2 = 0, purityHits = 0;
  const predMax = new Map(); // pred group -> best gt count (for purity)
  for (const [, row] of table) {
    for (const [p, nij] of row) {
      sumCellC2 += choose2(nij);
      predMax.set(p, Math.max(predMax.get(p) || 0, nij));
    }
  }
  for (const [, best] of predMax) purityHits += best;

  const sumA = [...aRow.values()].reduce((s, x) => s + choose2(x), 0);
  const sumB = [...bCol.values()].reduce((s, x) => s + choose2(x), 0);
  const totalC2 = choose2(n);
  const expected = totalC2 ? (sumA * sumB) / totalC2 : 0;
  const maxIndex = (sumA + sumB) / 2;
  const ari = maxIndex - expected ? round((sumCellC2 - expected) / (maxIndex - expected)) : 1;
  const purity = n ? round(purityHits / n) : 0;

  const items = docs.map((d) => ({
    doc_id: d,
    predicted_json: JSON.stringify(String(pred[d])),
    gold_json: JSON.stringify(String(gt[d])),
    correct: null,
    detail_json: null,
  }));

  return {
    headline: { key: 'ari', value: ari },
    metrics: [
      { key: 'ari', value: ari, scope: 'overall' },
      { key: 'purity', value: purity, scope: 'overall' },
      { key: 'n_gt_groups', value: aRow.size, scope: 'overall' },
      { key: 'n_pred_groups', value: bCol.size, scope: 'overall' },
      { key: 'n_docs', value: n, scope: 'overall' },
    ],
    items,
  };
}

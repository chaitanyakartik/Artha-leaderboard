// Segmentation scorer  [semantics DRAFT — confirm what a "segment" is].
// Model: a doc (bundle) is split into ordered page ranges.
// pred/gt: doc_id -> [[start,end], ...]  OR  [{start,end}|{start_page,end_page}, ...]
// Metric: boundary P/R/F1 over the internal cut points (segment starts, minus the doc start),
//         plus exact-match rate (identical boundary sets).
import { prf, round } from './util.js';

function boundaries(segs) {
  const starts = (segs || [])
    .map((s) => (Array.isArray(s) ? s[0] : s.start ?? s.start_page))
    .filter((x) => x != null)
    .map(Number)
    .sort((a, b) => a - b);
  if (starts.length <= 1) return new Set();
  return new Set(starts.slice(1)); // internal cuts only
}

export function score(pred, gt) {
  let tp = 0, fp = 0, fn = 0, exact = 0, nDocs = 0;
  const items = [];

  for (const doc of Object.keys(gt)) {
    const g = boundaries(gt[doc]);
    const p = boundaries(pred[doc]);
    let dtp = 0, dfp = 0, dfn = 0;
    for (const b of p) (g.has(b) ? dtp++ : dfp++);
    for (const b of g) if (!p.has(b)) dfn++;
    tp += dtp; fp += dfp; fn += dfn;

    const isExact = dfp === 0 && dfn === 0;
    nDocs++; if (isExact) exact++;
    items.push({
      doc_id: doc,
      predicted_json: JSON.stringify([...p]),
      gold_json: JSON.stringify([...g]),
      correct: isExact ? 1 : 0,
      detail_json: JSON.stringify({ tp: dtp, fp: dfp, fn: dfn }),
    });
  }

  const { precision, recall, f1 } = prf(tp, fp, fn);
  const exactRate = nDocs ? round(exact / nDocs) : 0;

  return {
    headline: { key: 'boundary_f1', value: f1 },
    metrics: [
      { key: 'boundary_f1', value: f1, scope: 'overall' },
      { key: 'boundary_precision', value: precision, scope: 'overall' },
      { key: 'boundary_recall', value: recall, scope: 'overall' },
      { key: 'exact_match', value: exactRate, scope: 'overall' },
      { key: 'n_docs', value: nDocs, scope: 'overall' },
    ],
    items,
  };
}

// Taxonomy coverage — a PURE derivation shared by classification + segmentation.
// Answers, for one run against the CURRENT master taxonomy: which file-type classes does this
// benchmark actually exercise (support > 0, + how well the model did), which taxonomy classes have
// NO support here, and which observed labels are off-taxonomy (hallucinations / synonyms to reconcile).
//
// Derived, not declared — so it can't drift, and it re-computes as the taxonomy grows (re-aggregate).
//
//   supported: [{ code, support, score }]  — classes with GT support in this run (score = F1 / boundary-recall)
//   seen:      string[]                     — every class observed (GT or predicted), for off-taxonomy detection
//   taxonomy:  [{ code, label, bucket }]    — the master list
import { normalizeLabel } from './util.js';

export function buildCoverage(supported, seen, taxonomy) {
  if (!taxonomy || !taxonomy.length) return null;
  const norm = normalizeLabel;
  const supMap = new Map();
  for (const s of supported) supMap.set(norm(s.code), { support: s.support, score: s.score });
  const taxSet = new Set(taxonomy.map((t) => norm(t.code)));

  const byBucket = new Map();
  for (const t of taxonomy) {
    const bk = t.bucket || '(unbucketed)';
    if (!byBucket.has(bk)) byBucket.set(bk, []);
    const sup = supMap.get(norm(t.code));
    byBucket.get(bk).push({ code: t.code, label: t.label, supported: !!sup, support: sup?.support ?? 0, score: sup?.score ?? null });
  }
  const buckets = [...byBucket.entries()].map(([bucket, classes]) => {
    classes.sort((a, b) => (b.supported - a.supported) || ((b.score ?? -1) - (a.score ?? -1)) || a.code.localeCompare(b.code));
    return { bucket, total: classes.length, supported: classes.filter((c) => c.supported).length, classes };
  }).sort((a, b) => (b.supported - a.supported) || a.bucket.localeCompare(b.bucket)); // touched buckets first

  // observed labels not in the taxonomy (GT with support, or predicted-only with support 0)
  const off = [];
  for (const c of seen) {
    const nc = norm(c);
    if (taxSet.has(nc) || off.some((o) => norm(o.code) === nc)) continue;
    off.push({ code: c, support: supMap.get(nc)?.support ?? 0 });
  }

  return {
    n_classes_total: taxonomy.length,
    n_classes_supported: buckets.reduce((s, b) => s + b.supported, 0),
    n_buckets_total: byBucket.size,
    n_buckets_touched: buckets.filter((b) => b.supported > 0).length,
    buckets,
    off_taxonomy: off.sort((a, b) => b.support - a.support),
  };
}

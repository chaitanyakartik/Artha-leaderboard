// Taxonomy coverage — a PURE derivation shared by classification + segmentation.
//
// "Support" is DECLARED, never inferred: each run states, at ingest, which file-type classes its
// model was built/trained to handle (runs.supported_classes_json). This function maps that
// declaration onto the master taxonomy and cross-references what the eval actually tested:
//   - declared + tested   -> we know how well it does (score)
//   - declared + untested -> supported, but this eval had no examples (a coverage gap in the eval)
//   - not declared        -> the model does not claim this file type
//   - tested + NOT declared -> a conflict: the eval graded a type the model never claimed (flagged)
//   - off-taxonomy        -> a label seen (GT or predicted) that isn't in the master taxonomy
//
//   declared:  string[] | null            — the run's declared supported classes (null = undeclared)
//   tested:    [{ code, support, score }]  — classes with GT support in this run (score = F1 / boundary-recall)
//   seen:      string[]                    — every class observed (GT or predicted), for off-taxonomy + conflicts
//   taxonomy:  [{ code, label, bucket }]   — the master list
import { normalizeLabel } from './util.js';

export function buildCoverage(declared, tested, seen, taxonomy) {
  if (!taxonomy || !taxonomy.length) return null;
  const norm = normalizeLabel;
  const undeclared = declared == null;
  const declaredSet = undeclared ? null : new Set(declared.map(norm));
  const testMap = new Map((tested || []).map((t) => [norm(t.code), { support: t.support, score: t.score }]));
  const taxSet = new Set(taxonomy.map((t) => norm(t.code)));

  const byBucket = new Map();
  for (const t of taxonomy) {
    const bk = t.bucket || '(unbucketed)';
    if (!byBucket.has(bk)) byBucket.set(bk, []);
    const nc = norm(t.code);
    const tst = testMap.get(nc);
    byBucket.get(bk).push({
      code: t.code, label: t.label,
      declared: undeclared ? null : declaredSet.has(nc),
      tested: !!tst, support: tst?.support ?? 0, score: tst?.score ?? null,
    });
  }
  const rank = (c) => (c.declared ? 0 : 1); // declared first
  const buckets = [...byBucket.entries()].map(([bucket, classes]) => {
    classes.sort((a, b) => rank(a) - rank(b) || (b.tested - a.tested) || ((b.score ?? -1) - (a.score ?? -1)) || a.code.localeCompare(b.code));
    return {
      bucket, total: classes.length,
      declared: undeclared ? null : classes.filter((c) => c.declared).length,
      tested: classes.filter((c) => c.tested).length,
      classes,
    };
  }).sort((a, b) => ((b.declared ?? b.tested) - (a.declared ?? a.tested)) || a.bucket.localeCompare(b.bucket));

  // conflicts: a class the eval graded that the run never declared support for
  const conflicts = undeclared ? [] : [...testMap.keys()]
    .filter((nc) => taxSet.has(nc) && !declaredSet.has(nc))
    .map((nc) => { const t = taxonomy.find((x) => norm(x.code) === nc); return { code: t ? t.code : nc, support: testMap.get(nc).support }; })
    .sort((a, b) => b.support - a.support);

  // off-taxonomy: observed labels not in the master taxonomy at all
  const off = [];
  for (const c of seen || []) {
    const nc = norm(c);
    if (taxSet.has(nc) || off.some((o) => norm(o.code) === nc)) continue;
    off.push({ code: c, support: testMap.get(nc)?.support ?? 0 });
  }

  return {
    undeclared,
    n_classes_total: taxonomy.length,
    n_declared: undeclared ? null : buckets.reduce((s, b) => s + b.declared, 0),
    n_tested: [...testMap.keys()].filter((nc) => taxSet.has(nc)).length,
    n_buckets_total: byBucket.size,
    n_buckets_declared: undeclared ? null : buckets.filter((b) => b.declared > 0).length,
    buckets,
    conflicts,
    off_taxonomy: off.sort((a, b) => b.support - a.support),
  };
}

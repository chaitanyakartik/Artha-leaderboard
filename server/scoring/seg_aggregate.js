// Segmentation aggregations — a PURE function of per-page error events.
//
// This is the whole point of the event-sourced design (chaitu, 2026-08-15): the scorer emits
// one atomic event per page; every analysis view is derived here. A new view invented later is
// a new function over the SAME events — re-aggregate from the DB, never re-score. `aggregate()`
// runs both at score time (in-memory events) and on demand (events loaded from analysis_events).
//
// Event shape (see segmentation.js::extractEvents):
//   { doc_id, page, gt_tag, pred_tag, gt_class, pred_class, gt_seg_class, pred_seg_class,
//     gt_bucket, pred_bucket, gt_boundary, pred_boundary, error_type, confidence, prev_gt_class }
//   error_type ∈ null | 'missed_start' | 'false_start' | 'wrong_class'
import { prf, round } from './util.js';
import { buildCoverage } from './coverage.js';

const inc = (map, k, by = 1) => map.set(k, (map.get(k) || 0) + by);
const desc = (a, b) => b.count - a.count;
const avg = (xs) => (xs.length ? round(xs.reduce((s, x) => s + x, 0) / xs.length, 2) : 0);

// group events by doc, preserving page order
function byDoc(events) {
  const m = new Map();
  for (const e of events) { if (!m.has(e.doc_id)) m.set(e.doc_id, []); m.get(e.doc_id).push(e); }
  return m;
}

// segments on one side ('gt'|'pred') of a doc's ordered events -> [{class, length, start_page}]
function segmentsOf(docEvents, side) {
  const tagKey = `${side}_tag`, clsKey = `${side}_seg_class`;
  const segs = [];
  docEvents.forEach((e, i) => {
    const isStart = i === 0 || e[tagKey] === 'start';
    if (isStart) segs.push({ class: e[clsKey] || 'unknown', length: 0, start_page: e.page });
    if (segs.length) segs[segs.length - 1].length++;
  });
  return segs;
}

function pairsWithExamples(errType, events, keyFn) {
  const counts = new Map(), examples = new Map();
  for (const e of events) {
    if (e.error_type !== errType) continue;
    const k = keyFn(e);
    inc(counts, k);
    if (!examples.has(k)) examples.set(k, []);
    const ex = examples.get(k);
    if (ex.length < 3) ex.push({ doc_id: e.doc_id, page: e.page, prev_class: e.prev_gt_class, expected: `${e.prev_gt_class || '?'} → ${e.gt_seg_class || '?'}` });
  }
  return [...counts.entries()]
    .map(([k, count]) => {
      const [from, to] = k.split('||');
      return { from, to, count, examples: examples.get(k) };
    })
    .sort(desc);
}

export function aggregate(events, opts = {}) {
  // Bucket is a DERIVED attribute of class, applied at aggregation time — never trusted from the
  // stored event. That's what lets a newly-populated class->bucket map light up bucket views on
  // re-aggregation, with no re-score. Events stay pure at the class level.
  const classBuckets = opts.classBuckets || {};
  const bucketsMapped = Object.keys(classBuckets).length > 0;
  const bucketOf = (c) => classBuckets[c] || null;

  // ---- boundary detection (headline) ----
  let tp = 0, fp = 0, fn = 0;
  for (const e of events) {
    if (e.gt_boundary && e.pred_boundary) tp++;
    else if (e.gt_boundary && !e.pred_boundary) fn++;   // missed start -> merge
    else if (!e.gt_boundary && e.pred_boundary) fp++;   // false start  -> split
  }
  const b = prf(tp, fp, fn);

  // ---- §1 confusion matrix + §5/§6 per-class/bucket page metrics ----
  const labels = new Set();
  const cell = new Map();                 // "gt||pred" -> count  (page-level segment class)
  const gtPages = new Map(), predPages = new Map(), correctPages = new Map();
  const bCell = new Map(), gtBk = new Map(), predBk = new Map(), correctBk = new Map();
  let pageHit = 0, pageTot = 0, startHit = 0, startTot = 0;
  for (const e of events) {
    const g = e.gt_seg_class, p = e.pred_seg_class;
    if (!g) continue;
    labels.add(g); if (p) labels.add(p);
    inc(cell, `${g}||${p || '∅'}`);
    inc(gtPages, g); if (p) inc(predPages, p);
    pageTot++; if (g === p) { pageHit++; inc(correctPages, g); }
    // cls-acc@start: classification accuracy on the pages GT marks as a document start
    if (e.gt_tag === 'start') { startTot++; if (g === p) startHit++; }
    if (bucketsMapped) {
      const gb = bucketOf(g) || 'unmapped', pb = bucketOf(p) || 'unmapped';
      inc(bCell, `${gb}||${pb}`); inc(gtBk, gb); inc(predBk, pb); if (gb === pb) inc(correctBk, gb);
    }
  }

  // ---- §2 boundary errors by class + §7 error taxonomy ----
  const missedStartByClass = new Map(), falseStartByClass = new Map(), caughtStartByClass = new Map();
  const errorTypes = new Map();
  for (const e of events) {
    if (e.error_type) inc(errorTypes, e.error_type);
    if (e.gt_boundary) { if (e.error_type === 'missed_start') inc(missedStartByClass, e.gt_seg_class); else if (e.pred_boundary) inc(caughtStartByClass, e.gt_seg_class); }
    if (e.error_type === 'false_start') inc(falseStartByClass, e.pred_seg_class);
  }

  const confusionRow = (label) => {
    const row = {}; let best = null, bestN = 0;
    for (const [k, n] of cell) {
      const [g, p] = k.split('||'); if (g !== label) continue;
      row[p] = n; if (p !== label && p !== '∅' && n > bestN) { best = p; bestN = n; }
    }
    return { row, most_confused_with: best };
  };
  const classAnalysis = [...labels].filter((c) => gtPages.has(c)).map((c) => {
    const gp = gtPages.get(c) || 0, pp = predPages.get(c) || 0, cor = correctPages.get(c) || 0;
    const caught = caughtStartByClass.get(c) || 0, missed = missedStartByClass.get(c) || 0;
    return {
      class: c,
      page_precision: pp ? round(cor / pp) : 0,
      page_recall: gp ? round(cor / gp) : 0,
      page_f1: prf(cor, pp - cor, gp - cor).f1,
      boundary_recall: caught + missed ? round(caught / (caught + missed)) : null,
      missed_starts: missed,
      false_starts: falseStartByClass.get(c) || 0,
      gt_pages: gp,
      most_confused_with: confusionRow(c).most_confused_with,
    };
  }).sort((a, b) => (a.boundary_recall ?? 1) - (b.boundary_recall ?? 1)); // worst boundary recall first

  const bucketAnalysis = bucketsMapped ? [...gtBk.keys()].map((bk) => {
    const gp = gtBk.get(bk) || 0, pp = predBk.get(bk) || 0, cor = correctBk.get(bk) || 0;
    return { bucket: bk, page_precision: pp ? round(cor / pp) : 0, page_recall: gp ? round(cor / gp) : 0, gt_pages: gp };
  }) : [];

  // ---- §4 segment length + over/under-segmentation + §3 doc quality ----
  const gtLenByClass = new Map(), predLenByClass = new Map();
  const docs = [];
  for (const [doc_id, evs] of byDoc(events)) {
    const gSegs = segmentsOf(evs, 'gt'), pSegs = segmentsOf(evs, 'pred');
    for (const s of gSegs) { if (!gtLenByClass.has(s.class)) gtLenByClass.set(s.class, []); gtLenByClass.get(s.class).push(s.length); }
    for (const s of pSegs) { if (!predLenByClass.has(s.class)) predLenByClass.set(s.class, []); predLenByClass.get(s.class).push(s.length); }
    const missed = evs.filter((e) => e.error_type === 'missed_start').length;
    const falses = evs.filter((e) => e.error_type === 'false_start').length;
    // boundary displacement: for each GT boundary page, distance to nearest pred boundary page
    const gtB = evs.filter((e) => e.gt_boundary).map((e) => e.page);
    const prB = evs.filter((e) => e.pred_boundary).map((e) => e.page);
    const disps = gtB.map((g) => (prB.length ? Math.min(...prB.map((p) => Math.abs(p - g))) : g));
    docs.push({
      doc_id, n_pages: evs.length, gt_segments: gSegs.length, pred_segments: pSegs.length,
      missed_boundaries: missed, false_boundaries: falses,
      max_displacement: disps.length ? Math.max(...disps) : 0,
      seg_accuracy: gSegs.length ? round((gSegs.length - missed) / gSegs.length) : 0,
    });
  }
  const segLenLabels = new Set([...gtLenByClass.keys(), ...predLenByClass.keys()]);
  const segmentLength = [...segLenLabels].map((c) => ({
    class: c,
    gt_avg_pages: avg(gtLenByClass.get(c) || []),
    pred_avg_pages: avg(predLenByClass.get(c) || []),
    gt_count: (gtLenByClass.get(c) || []).length,
    pred_count: (predLenByClass.get(c) || []).length,
  })).sort((a, b) => (b.pred_avg_pages - b.gt_avg_pages) - (a.pred_avg_pages - a.gt_avg_pages));
  const overSeg = docs.filter((dd) => dd.pred_segments > dd.gt_segments).sort((a, b) => (b.pred_segments - b.gt_segments) - (a.pred_segments - a.gt_segments)).slice(0, 20);
  const underSeg = docs.filter((dd) => dd.pred_segments < dd.gt_segments).sort((a, b) => (a.pred_segments - a.gt_segments) - (b.pred_segments - b.gt_segments)).slice(0, 20);
  const worstDocs = [...docs].sort((a, b) => (b.missed_boundaries - a.missed_boundaries) || (b.max_displacement - a.max_displacement)).filter((dd) => dd.missed_boundaries || dd.false_boundaries).slice(0, 20);

  // ---- §8 transitions + representative examples ----
  const merges = pairsWithExamples('missed_start', events, (e) => `${e.prev_gt_class || 'unknown'}||${e.gt_seg_class || 'unknown'}`);
  const splits = pairsWithExamples('false_start', events, (e) => `${e.prev_gt_class || 'unknown'}||${e.gt_seg_class || 'unknown'}`);
  const classConfusion = [...cell.entries()].map(([k, count]) => { const [from, to] = k.split('||'); return { from, to, count }; }).filter((x) => x.from !== x.to && x.to !== '∅').sort(desc);
  const bucketMerges = bucketsMapped
    ? (() => { const m = new Map(); for (const e of events) if (e.error_type === 'missed_start') inc(m, `${bucketOf(e.prev_gt_class) || 'unmapped'}||${bucketOf(e.gt_seg_class) || 'unmapped'}`); return [...m.entries()].map(([k, count]) => { const [from, to] = k.split('||'); return { from, to, count }; }).sort(desc); })()
    : [];

  // ---- §9 confidence (only if the model emitted it) ----
  const withConf = events.filter((e) => e.confidence != null);
  let confidence = { available: false };
  if (withConf.length) {
    const band = (c) => (c >= 0.85 ? 'high' : c >= 0.6 ? 'medium' : 'low');
    const wrong = new Map(), all = new Map();
    for (const e of withConf) { inc(all, band(e.confidence)); if (e.error_type) inc(wrong, band(e.error_type ? e.confidence : 1)); }
    confidence = {
      available: true,
      confidently_wrong: wrong.get('high') || 0,
      bands: ['high', 'medium', 'low'].map((bd) => ({ band: bd, errors: wrong.get(bd) || 0, total: all.get(bd) || 0 })),
    };
  }

  // ---- §overview: a few honest, derived headline findings ----
  const findings = [];
  if (merges.length) findings.push(`Most-merged boundary: ${merges[0].from} → ${merges[0].to} (${merges[0].count}×).`);
  const worstClass = classAnalysis.find((c) => c.boundary_recall != null && c.gt_pages >= 2);
  if (worstClass && worstClass.boundary_recall < 0.9) findings.push(`Lowest boundary recall: "${worstClass.class}" at ${worstClass.boundary_recall}.`);
  const totalGtSeg = docs.reduce((s, dd) => s + dd.gt_segments, 0), totalPredSeg = docs.reduce((s, dd) => s + dd.pred_segments, 0);
  if (totalGtSeg && totalPredSeg < totalGtSeg) findings.push(`Tends to under-segment (merge docs): ${totalPredSeg} predicted vs ${totalGtSeg} true segments.`);
  else if (totalGtSeg && totalPredSeg > totalGtSeg) findings.push(`Tends to over-segment (split docs): ${totalPredSeg} predicted vs ${totalGtSeg} true segments.`);
  const lenGap = segmentLength.find((s) => s.gt_count >= 2 && s.pred_avg_pages > s.gt_avg_pages * 1.5);
  if (lenGap) findings.push(`"${lenGap.class}" segments run long: ${lenGap.pred_avg_pages}p predicted vs ${lenGap.gt_avg_pages}p true (merging in neighbours).`);

  // Coverage vs the master taxonomy. Support is DECLARED (opts.supportedClasses), never inferred;
  // `tested` is what this eval's GT exercised (score = boundary recall, falling back to page-F1).
  const tested = classAnalysis.map((c) => ({ code: c.class, support: c.gt_pages, score: c.boundary_recall ?? c.page_f1 }));
  const taxonomy_coverage = buildCoverage(opts.supportedClasses ?? null, tested, [...labels], opts.taxonomy);

  return {
    schema_version: 1,
    buckets_mapped: bucketsMapped,
    taxonomy_coverage,
    overview: { key_findings: findings, n_docs: docs.length, n_pages: pageTot },
    boundary: { recall: b.recall, precision: b.precision, f1: b.f1, tp, fp, fn, page_class_accuracy: pageTot ? round(pageHit / pageTot) : 0, cls_acc_at_start: startTot ? round(startHit / startTot) : null, n_gold_starts: startTot },
    error_types: [...errorTypes.entries()].map(([type, count]) => ({ type, count })).sort(desc),
    transitions: { merges, splits, class_confusion: classConfusion.slice(0, 50), bucket_merges: bucketMerges },
    confusion_matrix: { labels: [...labels].sort(), cells: Object.fromEntries([...cell.entries()].map(([k, v]) => [k, v])) },
    class_analysis: classAnalysis,
    bucket_analysis: bucketAnalysis,
    segment_length: segmentLength,
    over_under: { over_segmented: overSeg, under_segmented: underSeg },
    worst_docs: worstDocs,
    confidence,
    // keep the flat popular-misses for back-compat with the earlier UI/consumers
    popular_misses: { merges, splits, class_confusion: classConfusion.slice(0, 50), bucket_merges: bucketMerges },
  };
}

// Segmentation scorer — EVENT-SOURCED.
//
// FORMAT (chaitu, 2026-08-15): a bundle is a sequence of pages; each page is tagged
//   `start` | `continue` with its document `class` (grouped form of the per-page JSONL the
//   pipeline emits). A boundary = a `start` after the first page (an internal cut); missing one
//   MERGES two docs, so boundary RECALL is the headline (a missed start is the costly error).
//
// DESIGN: `extractEvents()` emits ONE atomic event per page (the durable record we persist to
// `analysis_events`). Every analysis view — confusion matrix, per-class/bucket, segment length,
// worst docs, transitions — is derived in seg_aggregate.js as a pure function of those events, so
// a new view later is a re-aggregation over stored events, never a re-score.
import { normalizeLabel, round } from './util.js';
import { aggregate } from './seg_aggregate.js';

const START_WORDS = new Set(['start', 's', 'begin', 'b', 'new', 'boundary', 'true', 'yes', '1']);
function isStart(row, idx) {
  if (idx === 0) return true; // first page of a bundle is always a segment start
  const t = normalizeLabel(row && (row.tag ?? row.boundary ?? row.seg ?? row.type));
  return t === '' ? false : START_WORDS.has(t); // no tag -> continue
}
function classOf(row) {
  const raw = row && (row.class ?? row.doc_class ?? row.doc_type ?? row.category);
  return raw == null ? '' : normalizeLabel(raw);
}
function confOf(row) {
  const c = row && (row.confidence ?? row.conf ?? row.prob ?? row.score);
  return c == null ? null : Number(c);
}
function pageNo(row, idx) {
  const p = row && (row.page ?? row.page_no ?? row.page_number);
  return p == null ? idx + 1 : p;
}
function pagesOf(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.pages)) return v.pages;
  return [];
}
// segment (doc) class per page = class declared at the most recent start at/before the page
function segClassByPage(pages) {
  const out = []; let cur = '';
  pages.forEach((row, i) => { if (isStart(row, i)) cur = classOf(row); out[i] = cur; });
  return out;
}
// per-page class = the row's own class, forward-filled when a continue omits it
function pageClassByPage(pages) {
  const out = []; let cur = '';
  pages.forEach((row, i) => { const c = classOf(row); if (c) cur = c; out[i] = cur; });
  return out;
}

// Emit one event per (bundle, page). `bucketFor(class)` maps a class -> coarse bucket (or null).
export function extractEvents(pred, gt, opts = {}) {
  const buckets = opts.classBuckets || {};
  const bucketFor = (c) => buckets[c] || null;
  const events = [];
  for (const doc_id of Object.keys(gt)) {
    const gp = pagesOf(gt[doc_id]);
    const pp = pagesOf(pred[doc_id]);
    const gSeg = segClassByPage(gp), gPage = pageClassByPage(gp);
    const pSeg = segClassByPage(pp), pPage = pageClassByPage(pp);
    for (let i = 0; i < gp.length; i++) {
      const gStart = isStart(gp[i], i);
      const hasPred = i < pp.length;
      const pStart = hasPred ? isStart(pp[i], i) : false; // missing pred page -> treated as continue
      const gtBoundary = i > 0 && gStart;
      const predBoundary = i > 0 && pStart;

      let error_type = null;
      if (gtBoundary && !predBoundary) error_type = 'missed_start';       // merge
      else if (predBoundary && !gtBoundary) error_type = 'false_start';   // split
      else if (gSeg[i] !== (pSeg[i] || '')) error_type = 'wrong_class';   // boundary agrees, class wrong

      events.push({
        doc_id, page: pageNo(gp[i], i),
        gt_tag: gStart ? 'start' : 'continue',
        pred_tag: hasPred ? (pStart ? 'start' : 'continue') : null,
        gt_class: gPage[i] || null,
        pred_class: hasPred ? (pPage[i] || null) : null,
        gt_seg_class: gSeg[i] || null,
        pred_seg_class: hasPred ? (pSeg[i] || null) : null,
        gt_bucket: bucketFor(gSeg[i]),
        pred_bucket: hasPred ? bucketFor(pSeg[i]) : null,
        gt_boundary: gtBoundary ? 1 : 0,
        pred_boundary: predBoundary ? 1 : 0,
        error_type,
        confidence: hasPred ? confOf(pp[i]) : null,
        prev_gt_class: i > 0 ? (gSeg[i - 1] || null) : null,
      });
    }
  }
  return events;
}

export function score(pred, gt, opts = {}) {
  const events = extractEvents(pred, gt, opts);
  const analysis = aggregate(events, opts);
  const bd = analysis.boundary;

  // per-doc item rows (drill-down / audit-vs-source)
  const byDoc = new Map();
  for (const e of events) { if (!byDoc.has(e.doc_id)) byDoc.set(e.doc_id, []); byDoc.get(e.doc_id).push(e); }
  const items = [];
  let exact = 0;
  for (const [doc_id, evs] of byDoc) {
    const missed = evs.filter((e) => e.error_type === 'missed_start').map((e) => e.page);
    const spurious = evs.filter((e) => e.error_type === 'false_start').map((e) => e.page);
    const isExact = missed.length === 0 && spurious.length === 0;
    if (isExact) exact++;
    items.push({
      doc_id,
      predicted_json: JSON.stringify(evs.filter((e) => e.pred_boundary).map((e) => e.page)),
      gold_json: JSON.stringify(evs.filter((e) => e.gt_boundary).map((e) => e.page)),
      correct: isExact ? 1 : 0,
      detail_json: JSON.stringify({ n_pages: evs.length, missed_pages: missed, spurious_pages: spurious }),
    });
  }
  const nBundles = byDoc.size;

  return {
    headline: { key: 'boundary_recall', value: bd.recall },
    metrics: [
      { key: 'boundary_recall', value: bd.recall, scope: 'overall' },
      { key: 'boundary_f1', value: bd.f1, scope: 'overall' },
      { key: 'boundary_precision', value: bd.precision, scope: 'overall' },
      { key: 'missed_boundaries', value: bd.fn, scope: 'overall' },
      { key: 'spurious_boundaries', value: bd.fp, scope: 'overall' },
      { key: 'page_class_accuracy', value: bd.page_class_accuracy, scope: 'overall' },
      { key: 'exact_match', value: nBundles ? round(exact / nBundles) : 0, scope: 'overall' },
      { key: 'n_bundles', value: nBundles, scope: 'overall' },
    ],
    items,
    analysis,
    events, // persisted to analysis_events by createRun() — the durable, re-aggregatable layer
  };
}

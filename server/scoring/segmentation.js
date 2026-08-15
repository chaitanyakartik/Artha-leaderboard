// Segmentation scorer.
//
// FORMAT (chaitu, 2026-08-15): a bundle is a sequence of pages. Each page is tagged
//   `start` | `continue` and carries its document `class`. In-app JSON shape:
//     bundleId -> [ { "page": 1, "tag": "start", "class": "aadhaar" },
//                   { "page": 2, "tag": "continue", "class": "aadhaar" }, ... ]
//   (This is the grouped form of the per-page JSONL the pipeline emits — one row per page.)
//
// A "boundary" = a `start` page after the first (an internal cut). Missing one MERGES two
// docs; a spurious one SPLITS a doc.
//
// HEADLINE = boundary RECALL: per chaitu, a missed start page is the failure that matters
// most (two docs silently merged), so recall is the primary number.
//
// DETAILED ANALYSIS (per run, surfaced as a drop-down): the "popular misses" — which
// class->class transitions get merged/split most, plus a class->bucket rollup. Buckets
// (KYC, PKYC, ITR, financial, property, rental, ...) come from the class taxonomy's
// `bucket` column; until that's populated the bucket fields are null (scaffold in place).
import { normalizeLabel, prf, round } from './util.js';

// Tolerant tag reading. First page of a bundle is always a segment start.
const START_WORDS = new Set(['start', 's', 'begin', 'b', 'new', 'boundary', 'true', 'yes', '1']);
function isStart(row, idx) {
  if (idx === 0) return true;
  const t = normalizeLabel(row && (row.tag ?? row.boundary ?? row.seg ?? row.type));
  return t === '' ? false : START_WORDS.has(t); // no tag -> continue
}
function classOf(row) {
  const raw = row && (row.class ?? row.doc_class ?? row.doc_type ?? row.category);
  return raw == null ? '' : normalizeLabel(raw);
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

// Internal starts only (idx > 0) — the meaningful boundaries.
function internalStarts(pages) {
  const s = new Set();
  pages.forEach((row, i) => { if (i > 0 && isStart(row, i)) s.add(i); });
  return s;
}
// Segment (doc) class per page = class declared at the most recent start at/before the page.
function segClassByPage(pages) {
  const out = []; let cur = '';
  pages.forEach((row, i) => { if (isStart(row, i)) cur = classOf(row); out[i] = cur; });
  return out;
}
// Per-page class = the row's own class, forward-filled when a continue row omits it.
function pageClassByPage(pages) {
  const out = []; let cur = '';
  pages.forEach((row, i) => { const c = classOf(row); if (c) cur = c; out[i] = cur; });
  return out;
}

const inc = (map, key) => map.set(key, (map.get(key) || 0) + 1);
function pairList(map, buckets) {
  return [...map.entries()]
    .map(([k, count]) => {
      const [from, to] = k.split('||');
      return { from, to, from_bucket: buckets[from] || null, to_bucket: buckets[to] || null, count };
    })
    .sort((a, b) => b.count - a.count);
}
function bucketPairList(map) {
  return [...map.entries()]
    .map(([k, count]) => { const [from, to] = k.split('||'); return { from, to, count }; })
    .sort((a, b) => b.count - a.count);
}

export function score(pred, gt, opts = {}) {
  const buckets = opts.classBuckets || {};
  const bkt = (c) => buckets[c] || null;

  let tp = 0, fp = 0, fn = 0, exact = 0, nBundles = 0, pageTot = 0, pageHit = 0;
  const merges = new Map();       // missed boundary  -> two docs wrongly MERGED (from->to class)
  const splits = new Map();       // spurious boundary -> a doc wrongly SPLIT
  const classConf = new Map();    // per-page class confusion (trueClass -> predClass)
  const bucketMerges = new Map(); // bucket-level rollup of merges (scaffold; null until buckets set)
  const items = [];

  for (const id of Object.keys(gt)) {
    const gp = pagesOf(gt[id]);
    const pp = pagesOf(pred[id]);
    const gStart = internalStarts(gp);
    const pStart = internalStarts(pp);
    const gSeg = segClassByPage(gp);
    const gPageCls = pageClassByPage(gp);
    const pPageCls = pageClassByPage(pp);

    let dtp = 0, dfp = 0, dfn = 0;
    const missedPages = [], spuriousPages = [];

    for (const i of gStart) {
      if (pStart.has(i)) { dtp++; continue; }
      dfn++; // missed start -> merge
      const from = gSeg[i - 1] || 'unknown', to = gSeg[i] || 'unknown';
      inc(merges, `${from}||${to}`);
      if (bkt(from) || bkt(to)) inc(bucketMerges, `${bkt(from) || '?'}||${bkt(to) || '?'}`);
      missedPages.push(pageNo(gp[i], i));
    }
    for (const i of pStart) {
      if (gStart.has(i)) continue;
      dfp++; // spurious start -> split
      const from = gSeg[i - 1] || 'unknown', to = gSeg[i] || 'unknown';
      inc(splits, `${from}||${to}`);
      spuriousPages.push(pageNo(pp[i], i));
    }
    tp += dtp; fp += dfp; fn += dfn;

    // Per-page class accuracy + confusion (aligned by page index up to the GT length).
    for (let i = 0; i < gp.length; i++) {
      const tc = gPageCls[i]; if (!tc) continue;
      const pc = pPageCls[i] || '';
      pageTot++;
      if (pc === tc) pageHit++;
      else inc(classConf, `${tc}||${pc || '∅'}`);
    }

    const isExact = dfp === 0 && dfn === 0;
    nBundles++; if (isExact) exact++;
    items.push({
      doc_id: id,
      predicted_json: JSON.stringify([...pStart]),
      gold_json: JSON.stringify([...gStart]),
      correct: isExact ? 1 : 0,
      detail_json: JSON.stringify({ tp: dtp, fp: dfp, fn: dfn, n_pages: gp.length, missed_pages: missedPages, spurious_pages: spuriousPages }),
    });
  }

  const { precision, recall, f1 } = prf(tp, fp, fn);
  const pageAcc = pageTot ? round(pageHit / pageTot) : 0;
  const exactRate = nBundles ? round(exact / nBundles) : 0;

  const analysis = {
    boundary: { recall, precision, f1, tp, fp, fn },
    class: { page_accuracy: pageAcc, pages_scored: pageTot },
    buckets_mapped: Object.keys(buckets).length > 0,
    // "popular misses" — what the drop-down shows, most-frequent first.
    popular_misses: {
      merges: pairList(merges, buckets),          // missed boundaries: docs wrongly merged (from->to)
      splits: pairList(splits, buckets),          // spurious boundaries: docs wrongly split
      class_confusion: pairList(classConf, buckets),
      bucket_merges: bucketPairList(bucketMerges), // empty until class->bucket map is populated
    },
  };

  return {
    headline: { key: 'boundary_recall', value: recall },
    metrics: [
      { key: 'boundary_recall', value: recall, scope: 'overall' },
      { key: 'boundary_f1', value: f1, scope: 'overall' },
      { key: 'boundary_precision', value: precision, scope: 'overall' },
      { key: 'missed_boundaries', value: fn, scope: 'overall' },
      { key: 'spurious_boundaries', value: fp, scope: 'overall' },
      { key: 'page_class_accuracy', value: pageAcc, scope: 'overall' },
      { key: 'exact_match', value: exactRate, scope: 'overall' },
      { key: 'n_bundles', value: nBundles, scope: 'overall' },
    ],
    items,
    analysis,
  };
}

// Classification aggregations — a PURE function of per-doc item rows (item_results shape).
//
// Same event-sourced principle as segmentation: the scorer stores one atomic row per doc
// (predicted_json = pred class, gold_json = true class); every view is derived here, so
// re-aggregation from the DB never re-scores.
import { prf, round } from './util.js';
import { buildCoverage } from './coverage.js';

const parse = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);

export function aggregate(items, opts = {}) {
  const scored = [], stats = new Map(), predCount = new Map();
  const cell = new Map(); // "gold||pred" -> count (confusion)
  let correct = 0;
  for (const it of items) {
    const gold = parse(it.gold_json), pred = parse(it.predicted_json);
    const g = gold == null ? null : String(gold), p = pred == null ? null : String(pred);
    if (g == null) continue;
    scored.push(it);
    const ok = it.correct != null ? !!it.correct : p === g;
    if (ok) correct++;
    if (!stats.has(g)) stats.set(g, { tp: 0, fp: 0, fn: 0 });
    if (p) inc(predCount, p);
    if (ok) stats.get(g).tp++;
    else { stats.get(g).fn++; if (p) { if (!stats.has(p)) stats.set(p, { tp: 0, fp: 0, fn: 0 }); stats.get(p).fp++; } }
    inc(cell, `${g}||${p || '∅'}`);
  }

  const n = scored.length;
  const accuracy = n ? round(correct / n) : 0;
  const perClass = [...stats.keys()].map((c) => {
    const s = stats.get(c);
    const r = prf(s.tp, s.fp, s.fn);
    return { class: c, precision: r.precision, recall: r.recall, f1: r.f1, support: s.tp + s.fn, n_pred: (s.tp + s.fp) || (predCount.get(c) || 0) };
  }).sort((a, b) => a.f1 - b.f1); // worst first
  const withSupport = perClass.filter((c) => c.support > 0);
  const macroF1 = withSupport.length ? round(withSupport.reduce((s, c) => s + c.f1, 0) / withSupport.length) : 0;

  const findings = [];
  const worst = withSupport.find((c) => c.f1 < 0.9);
  if (worst) findings.push(`Weakest class: "${worst.class}" F1 ${worst.f1} (support ${worst.support}).`);

  // Coverage against the master taxonomy: supported = GT support > 0 (score = F1).
  const supported = withSupport.map((c) => ({ code: c.class, support: c.support, score: c.f1 }));
  const seen = perClass.map((c) => c.class).filter((c) => c !== '__missed__');
  const taxonomy_coverage = buildCoverage(supported, seen, opts.taxonomy);

  return {
    schema_version: 2,
    overview: { key_findings: findings, n_scored: n },
    accuracy, macro_f1: macroF1,
    per_class: perClass,
    confusion_matrix: { labels: [...stats.keys()].sort(), cells: Object.fromEntries(cell) },
    taxonomy_coverage,
  };
}

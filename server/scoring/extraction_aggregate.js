// Extraction aggregations — a PURE function of per-doc item rows (item_results shape).
//
// detail_json per doc = { field: { pred, gold, ok } }. Because pred/gold are stored raw, new
// signals (char-similarity here) are DERIVED at aggregation time — no re-score. Same event-sourced
// principle as segmentation/classification.
//
// Metrics (chaitu): field-wise accuracy + SUPPORT count (a field may appear in only 5 of 20 docs),
// MACRO (mean of per-field accuracies, each field equal) vs MICRO (all field instances pooled), and
// character-similarity rate (normalized). opts.fieldSchema: [{name,type}] just orders/labels fields.
import { charSim, round } from './util.js';

const parse = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

export function aggregate(items, opts = {}) {
  const order = (opts.fieldSchema || []).map((f) => f.name);
  const stats = new Map(); // field -> { correct, support, simSum }
  const touch = (f) => { if (!stats.has(f)) stats.set(f, { correct: 0, support: 0, simSum: 0 }); return stats.get(f); };

  let docExact = 0, nDocs = 0;
  let microCorrect = 0, microTotal = 0, microSim = 0;
  for (const it of items) {
    const detail = parse(it.detail_json, {}) || {};
    nDocs++;
    if (it.correct === 1) docExact++;
    for (const [f, r] of Object.entries(detail)) {
      const s = touch(f);
      const sim = charSim(r.pred, r.gold);
      s.support++; s.simSum += sim; if (r.ok) s.correct++;
      microTotal++; microSim += sim; if (r.ok) microCorrect++;
    }
  }

  const perField = [...stats.entries()].map(([field, s]) => ({
    field,
    accuracy: s.support ? round(s.correct / s.support) : 0,
    support: s.support,
    char_sim: s.support ? round(s.simSum / s.support) : 0,
  }));
  // preserve schema order where known, then the rest by ascending accuracy (worst first)
  perField.sort((a, b) => {
    const ia = order.indexOf(a.field), ib = order.indexOf(b.field);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
    return a.accuracy - b.accuracy;
  });

  const nFields = perField.length;
  const microFieldAcc = microTotal ? round(microCorrect / microTotal) : 0;
  const macroFieldAcc = nFields ? round(perField.reduce((s, f) => s + f.accuracy, 0) / nFields) : 0;
  const microCharSim = microTotal ? round(microSim / microTotal) : 0;
  const macroCharSim = nFields ? round(perField.reduce((s, f) => s + f.char_sim, 0) / nFields) : 0;
  const docExactMatch = nDocs ? round(docExact / nDocs) : 0;

  const findings = [];
  const worst = [...perField].sort((a, b) => a.accuracy - b.accuracy)[0];
  if (worst) findings.push(`Weakest field: "${worst.field}" ${worst.accuracy} (support ${worst.support}).`);
  const sparse = perField.filter((f) => f.support < nDocs * 0.5);
  if (sparse.length) findings.push(`${sparse.length} field(s) present in <50% of docs — low support, read their numbers with care.`);
  if (Math.abs(macroFieldAcc - microFieldAcc) >= 0.05) findings.push(`Macro ${macroFieldAcc} vs micro ${microFieldAcc}: per-field difficulty is uneven.`);

  return {
    schema_version: 1,
    overview: { key_findings: findings, n_docs: nDocs, n_fields: nFields },
    field_accuracy: microFieldAcc,       // headline (micro)
    macro_field_accuracy: macroFieldAcc,
    micro_char_sim: microCharSim,
    macro_char_sim: macroCharSim,
    doc_exact_match: docExactMatch,
    per_field: perField,
  };
}

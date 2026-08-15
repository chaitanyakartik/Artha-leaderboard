// Shared scoring helpers: field-typed normalization + P/R/F1.

export function normalizeText(v) {
  return String(v ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s]+/g, ' ')
    .replace(/[.,;:!?"'`()\[\]{}]/g, '')
    .trim();
}

export function normalizeNumber(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Very loose date normalization -> YYYY-MM-DD when parseable, else normalized text.
export function normalizeDate(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})/);
  if (m) {
    let [_, a, b, c] = m;
    let year, month, day;
    if (a.length === 4) { year = a; month = b; day = c; }
    else { day = a; month = b; year = c.length === 2 ? '20' + c : c; }
    return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return normalizeText(s);
}

// Returns true if predicted matches gold under the field's type.
export function fieldMatch(pred, gold, type = 'string') {
  if (gold == null || gold === '') return pred == null || pred === ''; // empty gold: match empty pred
  switch (type) {
    case 'number':
    case 'amount': {
      const a = normalizeNumber(pred), b = normalizeNumber(gold);
      return a != null && b != null && a === b;
    }
    case 'date':
      return normalizeDate(pred) === normalizeDate(gold);
    default:
      return normalizeText(pred) === normalizeText(gold);
  }
}

export function prf(tp, fp, fn) {
  const p = tp + fp ? tp / (tp + fp) : 0;
  const r = tp + fn ? tp / (tp + fn) : 0;
  const f1 = p + r ? (2 * p * r) / (p + r) : 0;
  return { precision: round(p), recall: round(r), f1: round(f1) };
}

export const round = (x, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

// nC2
export const choose2 = (n) => (n * (n - 1)) / 2;

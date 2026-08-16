// Convert a per-window eval dump into the leaderboard's segmentation format.
// Input JSONL (one window per line), as produced on the GPU box:
//   {"window_id":"w0","gold":[{"tag":"start","class":"aadhar_card"}, ...7], "pred":[ ...7 ]}
// Output: a GT file (from `gold`) + a predictions file (from `pred`), both keyed by window_id.
// Usage: node scripts/import-seg-jsonl.js <in.jsonl> <gt-out.json> <pred-out.json>
//
// Tolerant to field-name drift: tag|boundary|is_start ; class|label|doc_type|pred_class.
// A window with null/empty pred (model output didn't parse) -> empty page list -> the app scores it
// as all-starts-missed / class-wrong (the honest 0, not a misleading 100%).
import fs from 'fs';

const [, , inPath, gtOut, predOut] = process.argv;
if (!inPath || !gtOut || !predOut) {
  console.error('usage: node scripts/import-seg-jsonl.js <in.jsonl> <gt-out.json> <pred-out.json>');
  process.exit(1);
}

const item = (x, i) => {
  if (x == null) return null;
  const tag = x.tag ?? x.boundary ?? (x.is_start === true ? 'start' : x.is_start === false ? 'continue' : undefined);
  const cls = x.class ?? x.label ?? x.doc_type ?? x.pred_class ?? null;
  return { page: x.page ?? i + 1, tag: tag ?? 'continue', class: cls };
};
const seq = (arr) => (Array.isArray(arr) ? arr.map(item) : []);

const gt = {}, pred = {};
let n = 0, empty = 0;
for (const line of fs.readFileSync(inPath, 'utf8').split('\n')) {
  const s = line.trim();
  if (!s) continue;
  const row = JSON.parse(s);
  const id = String(row.window_id ?? row.id ?? row.window ?? n);
  gt[id] = seq(row.gold);
  if (row.pred == null || (Array.isArray(row.pred) && row.pred.length === 0)) { pred[id] = []; empty++; }
  else pred[id] = seq(row.pred);
  n++;
}
fs.writeFileSync(gtOut, JSON.stringify({ gt }));
fs.writeFileSync(predOut, JSON.stringify({ predictions: pred }));
console.log(`${n} windows -> GT ${gtOut}, preds ${predOut}${empty ? ` (${empty} windows had no/empty pred → scored as full miss)` : ''}`);

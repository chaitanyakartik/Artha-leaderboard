// Derive a per-document CLASSIFICATION benchmark from a segmentation dump — no new model run.
// seg+cls share the same dataset, and every segmentation START page already carries the
// segment's class. So each GT start = one document to classify; its class is the label.
//
// Input JSONL (one sliding window per line, as produced on the GPU box + used by import-seg-jsonl.js):
//   {"window_id":"w0","gold":[{"tag":"start","class":"bank_statement"},{"tag":"continue",...}...7], "pred":[...7]}
// Output: a classification GT file {gt:{doc_id: class}} + a predictions file {predictions:{doc_id: class}},
// keyed by "<window_id>_p<page>" for every page that is a GT start.
//
// A GT start where the model predicted `continue` (missed the boundary → emitted no class) is scored
// as an honest miss: predicted class = "__missed__" (counts wrong, keeps coverage full, and shows up
// distinctly in the confusion matrix rather than silently vanishing).
//
// Usage: node scripts/derive-cls-from-seg.js <in.jsonl> <gt-out.json> <pred-out.json>
import fs from 'fs';

const [, , inPath, gtOut, predOut] = process.argv;
if (!inPath || !gtOut || !predOut) {
  console.error('usage: node scripts/derive-cls-from-seg.js <in.jsonl> <gt-out.json> <pred-out.json>');
  process.exit(1);
}

const MISSED = '__missed__';
const tagOf = (x) => x?.tag ?? x?.boundary ?? (x?.is_start === true ? 'start' : x?.is_start === false ? 'continue' : undefined);
const classOf = (x) => x?.class ?? x?.label ?? x?.doc_type ?? x?.pred_class ?? null;

const gt = {}, pred = {};
let windows = 0, docs = 0, missed = 0;
for (const line of fs.readFileSync(inPath, 'utf8').split('\n')) {
  const s = line.trim();
  if (!s) continue;
  const row = JSON.parse(s);
  const wid = String(row.window_id ?? row.id ?? row.window ?? windows);
  const gold = Array.isArray(row.gold) ? row.gold : [];
  const pr = Array.isArray(row.pred) ? row.pred : [];
  gold.forEach((g, i) => {
    if (tagOf(g) !== 'start') return;            // only GT starts are documents to classify
    const docId = `${wid}_p${i + 1}`;
    gt[docId] = classOf(g);
    const p = pr[i];
    if (p && tagOf(p) === 'start' && classOf(p) != null) pred[docId] = classOf(p);
    else { pred[docId] = MISSED; missed++; }     // model didn't detect this doc → honest miss
    docs++;
  });
  windows++;
}
fs.writeFileSync(gtOut, JSON.stringify({ gt }));
fs.writeFileSync(predOut, JSON.stringify({ predictions: pred }));
console.log(`${windows} windows → ${docs} docs → GT ${gtOut}, preds ${predOut}${missed ? ` (${missed} missed by model → scored as "${MISSED}")` : ''}`);

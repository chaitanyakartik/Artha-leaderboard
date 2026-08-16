// Populate the CLASSIFICATION leaderboard by reusing the SEGMENTATION data on the shared
// seg+cls dataset. For each seg dump we already have, derive a per-doc classification GT +
// predictions (scripts/derive-cls-from-seg.js), then: upload the GT once, and POST one
// classification run per model — no new model inference.
//
// Usage: node scripts/ingest-cls-from-seg.js [port] [only-file.jsonl ...]   (default port 6969)
// The GT is identical across dumps (same val set + slice), so it's uploaded once.
// Pass one or more dump filenames to restrict ingestion to those (re-run-safe: lets you add
// late-arriving models without re-posting — and thus duplicating — the ones already on the board).
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = process.argv[2] || '6969';
const ONLY = new Set(process.argv.slice(3)); // optional: restrict to these dump filenames
const BASE = `http://localhost:${PORT}`;
const DATASET_ID = 3; // seg-cls-v1 (seg + cls share this dataset)
const OUT = 'data/cls_from_seg';

// seg dump -> which model config / checkpoint it represents on the board.
const RUNS = [
  { file: 'chandra_ckpt1200.jsonl', model: 'chandra-4b-ft', checkpoint: 'ckpt-1200' },
  { file: 'gemma_v3_ckpt300.jsonl', model: 'gemma-12b', checkpoint: 'ckpt-300' },
  { file: 'gemma_v3_ckpt600.jsonl', model: 'gemma-12b', checkpoint: 'ckpt-600' },
  { file: 'gemma12b_base.jsonl', model: 'gemma-12b-base', checkpoint: null },
  { file: 'gemma31b_base.jsonl', model: 'gemma-31b-base', checkpoint: null },
  { file: 'gemini_seg.jsonl', model: 'gemini-only', checkpoint: null },
];

fs.mkdirSync(OUT, { recursive: true });

async function main() {
  // login (capture the session cookie for subsequent calls)
  const lr = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'chaitu', password: 'changeme-artha' }),
  });
  const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error(`login failed (status ${lr.status}) — is the server up on :${PORT}?`);
  const H = { 'content-type': 'application/json', cookie };

  let gtUploaded = false;
  for (const r of RUNS) {
    if (ONLY.size && !ONLY.has(r.file)) continue;
    const inPath = `data/seg_dumps/${r.file}`;
    if (!fs.existsSync(inPath)) { console.log(`skip ${r.file} (not present yet)`); continue; }
    const gtOut = `${OUT}/gt.${r.file}.json`, predOut = `${OUT}/pred.${r.file}.json`;
    console.log(execFileSync('node', ['scripts/derive-cls-from-seg.js', inPath, gtOut, predOut], { encoding: 'utf8' }).trim());

    // Upload classification GT once (identical across dumps).
    if (!gtUploaded) {
      const { gt } = JSON.parse(fs.readFileSync(gtOut, 'utf8'));
      const gr = await fetch(`${BASE}/api/datasets/${DATASET_ID}/gt`, {
        method: 'POST', headers: H, body: JSON.stringify({ task: 'classification', gt }),
      });
      const gb = await gr.json().catch(() => ({}));
      if (!gr.ok) throw new Error(`GT upload failed: ${gb.error || gr.statusText}`);
      console.log(`  GT: ${gb.gt_count} classification docs on dataset ${DATASET_ID}`);
      gtUploaded = true;
    }

    // POST the classification run for this model.
    const { predictions } = JSON.parse(fs.readFileSync(predOut, 'utf8'));
    const payload = { task: 'classification', dataset_id: DATASET_ID, model_config_id: r.model, predictions };
    if (r.checkpoint) payload.checkpoint = r.checkpoint;
    const rr = await fetch(`${BASE}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify(payload) });
    const rb = await rr.json().catch(() => ({}));
    if (!rr.ok) { console.log(`  ✗ run failed for ${r.model}${r.checkpoint ? '/' + r.checkpoint : ''}: ${rb.error || rr.statusText}`); continue; }
    console.log(`  ✓ ${r.model}${r.checkpoint ? '/' + r.checkpoint : ''}: accuracy=${rb.headline?.value} (run ${rb.run_id})`);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });

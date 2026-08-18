// Import the master class taxonomy into class_taxonomy (idempotent upsert).
// Usage: node scripts/import-classes.js <file.json> [--prune]
//
//   --prune  make the file the SOURCE OF TRUTH: delete any class whose code is
//            not in the file (full sync, not just append). Use for the master
//            taxonomy so removed/renamed classes actually disappear.
//
// Tolerant input (chaitu's taxonomy file format TBD — adjust the normalizer if needed):
//   [ { "code": "aadhaar", "label": "Aadhaar", "bucket": "KYC" }, ... ]     (array of objects)
//   [ "aadhaar", "pan", ... ]                                                 (bare codes)
//   { "aadhaar": "Aadhaar", ... }                                            (code -> label map)
//   { "classes": [ ... ] }                                                    (wrapped)
import fs from 'fs';
import { db } from '../server/db.js';

const args = process.argv.slice(2);
const prune = args.includes('--prune');
const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('usage: node scripts/import-classes.js <file.json> [--prune]'); process.exit(1); }
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const list = Array.isArray(raw) ? raw : Array.isArray(raw.classes) ? raw.classes
  : Object.entries(raw).map(([code, label]) => ({ code, label }));

const rows = list.map((c) => (typeof c === 'string'
  ? { code: c, label: c, bucket: null }
  : { code: c.code ?? c.id ?? c.name, label: c.label ?? c.name ?? c.code, bucket: c.bucket ?? null }))
  .filter((c) => c.code);

const d = db();
const up = d.prepare(
  `INSERT INTO class_taxonomy (code, label, bucket) VALUES (@code, @label, @bucket)
   ON CONFLICT(code) DO UPDATE SET label = excluded.label, bucket = COALESCE(excluded.bucket, class_taxonomy.bucket)`
);
const del = d.prepare('DELETE FROM class_taxonomy WHERE code = ?');
let pruned = [];
const tx = d.transaction((rs) => {
  rs.forEach((r) => up.run(r));
  if (prune) {
    const keep = new Set(rs.map((r) => r.code));
    pruned = d.prepare('SELECT code FROM class_taxonomy').all()
      .map((x) => x.code).filter((c) => !keep.has(c));
    pruned.forEach((c) => del.run(c));
  }
});
tx(rows);
const total = d.prepare('SELECT COUNT(*) c FROM class_taxonomy').get().c;
const withBucket = d.prepare('SELECT COUNT(*) c FROM class_taxonomy WHERE bucket IS NOT NULL').get().c;
if (prune && pruned.length) console.log(`Pruned ${pruned.length} stale classes: ${pruned.join(', ')}`);
console.log(`Imported ${rows.length} classes. Taxonomy now: ${total} classes (${withBucket} with a bucket).`);

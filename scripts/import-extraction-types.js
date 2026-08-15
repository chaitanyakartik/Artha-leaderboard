// Import extraction doc-type templates + their field schemas (idempotent upsert).
// Usage: node scripts/import-extraction-types.js <file.json>
//
// Tolerant input (extraction taxonomy file format TBD):
//   [ { "name": "rent_agreement",
//       "fields": [ { "name": "tenant", "type": "string" }, { "name": "rent", "type": "amount" } ] } ]
//   { "types": [ ... ] }                                  (wrapped)
//   fields may also be a { fieldName: type } map or a bare [ "a", "b" ] (defaults to string).
import fs from 'fs';
import { db } from '../server/db.js';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/import-extraction-types.js <file.json>'); process.exit(1); }
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const list = Array.isArray(raw) ? raw : Array.isArray(raw.types) ? raw.types : [];

const normFields = (f) => {
  if (!f) return [];
  if (Array.isArray(f)) return f.map((x) => (typeof x === 'string' ? { name: x, type: 'string' } : { name: x.name, type: x.type || 'string' }));
  return Object.entries(f).map(([name, type]) => ({ name, type: type || 'string' }));
};

const d = db();
const up = d.prepare(
  `INSERT INTO extraction_types (name, field_schema, notes) VALUES (@name, @field_schema, @notes)
   ON CONFLICT(name) DO UPDATE SET field_schema = excluded.field_schema, notes = excluded.notes`
);
let n = 0;
const tx = d.transaction((types) => {
  for (const t of types) {
    if (!t.name) continue;
    up.run({ name: t.name, field_schema: JSON.stringify(normFields(t.fields ?? t.field_schema)), notes: t.notes ?? null });
    n++;
  }
});
tx(list);
console.log(`Imported ${n} extraction type(s). Total: ${d.prepare('SELECT COUNT(*) c FROM extraction_types').get().c}.`);

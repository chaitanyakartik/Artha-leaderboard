// Apply schema, seed fixed tasks, and sync the model registry from /models.json.
// Idempotent: safe to run repeatedly.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, ROOT } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const d = db();
d.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
d.exec(fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8'));

// Sync model registry from the root models.json (the verified list of model ids).
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.json'), 'utf8'));
const upsert = d.prepare(
  `INSERT INTO model_configs (id, name, notes) VALUES (@id, @name, @notes)
   ON CONFLICT(id) DO UPDATE SET name = excluded.name, notes = excluded.notes`
);
const seen = new Set();
const syncModels = d.transaction((models) => {
  for (const m of models) {
    if (!m.id || !m.name) throw new Error(`models.json entry missing id/name: ${JSON.stringify(m)}`);
    if (seen.has(m.id)) throw new Error(`duplicate model id in models.json: ${m.id}`);
    seen.add(m.id);
    upsert.run({ id: m.id, name: m.name, notes: m.notes || '' });
  }
});
syncModels(registry.models);

const n = d.prepare('SELECT COUNT(*) c FROM model_configs').get().c;
console.log(`DB ready. tasks seeded, ${n} model configs synced from models.json.`);

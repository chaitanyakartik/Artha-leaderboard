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

// Migrations for DBs created before newer columns existed.
const ensureCol = (table, col, decl) => {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
};
ensureCol('model_configs', 'card_json', 'TEXT');
ensureCol('runs', 'run_key', 'TEXT');
ensureCol('runs', 'display_name', 'TEXT');
ensureCol('runs', 'origin', "TEXT NOT NULL DEFAULT 'ui'");
ensureCol('runs', 'external_ref', 'TEXT');
ensureCol('runs', 'gt_fingerprint', 'TEXT');
ensureCol('datasets', 'seg_window_mode', 'INTEGER NOT NULL DEFAULT 0');
ensureCol('runs', 'analysis_json', 'TEXT');
ensureCol('runs', 'prompt_id', 'INTEGER');
ensureCol('runs', 'enabled_classes_json', 'TEXT');
ensureCol('class_taxonomy', 'bucket', 'TEXT');
d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_external ON runs(origin, external_ref) WHERE external_ref IS NOT NULL`);

// Sync model registry from the root models.json (the verified list of model ids + cards).
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.json'), 'utf8'));
const upsert = d.prepare(
  `INSERT INTO model_configs (id, name, notes, card_json) VALUES (@id, @name, @notes, @card_json)
   ON CONFLICT(id) DO UPDATE SET name = excluded.name, notes = excluded.notes, card_json = excluded.card_json`
);
const seen = new Set();
const syncModels = d.transaction((models) => {
  for (const m of models) {
    if (!m.id || !m.name) throw new Error(`models.json entry missing id/name: ${JSON.stringify(m)}`);
    if (seen.has(m.id)) throw new Error(`duplicate model id in models.json: ${m.id}`);
    seen.add(m.id);
    const { id, name, notes, ...card } = m;
    upsert.run({ id, name, notes: notes || '', card_json: JSON.stringify({ id, name, notes: notes || '', ...card }) });
  }
});
syncModels(registry.models);

const n = d.prepare('SELECT COUNT(*) c FROM model_configs').get().c;
console.log(`DB ready. tasks seeded, ${n} model configs synced from models.json.`);

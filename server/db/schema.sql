-- Artha Leaderboard schema (SQLite)
-- The 4 tasks are fixed: segmentation | classification | extraction | segregation
-- `task` is stored as TEXT for readability; the tasks table exists for referential clarity + seeding.

CREATE TABLE IF NOT EXISTS tasks (
  slug        TEXT PRIMARY KEY,             -- segmentation | classification | extraction | segregation
  label       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS datasets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,       -- e.g. "V1"
  n_applicants    INTEGER,                    -- e.g. 5
  n_docs          INTEGER,                    -- e.g. 250
  source_manifest TEXT,                       -- path/URL to the S3-links JSON manifest
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS model_configs (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,               -- Qwen+Gemini, Chandra-only, ...
  notes  TEXT
);

-- The 140-class taxonomy for classification.
CREATE TABLE IF NOT EXISTS class_taxonomy (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  code   TEXT NOT NULL UNIQUE,               -- stable class id used in prediction/GT files
  label  TEXT NOT NULL
);

-- What a given classifier was trained for = a subset of the 140 classes.
CREATE TABLE IF NOT EXISTS classifier_profiles (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,
  notes  TEXT
);
CREATE TABLE IF NOT EXISTS profile_classes (
  profile_id INTEGER NOT NULL REFERENCES classifier_profiles(id) ON DELETE CASCADE,
  class_id   INTEGER NOT NULL REFERENCES class_taxonomy(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, class_id)
);

-- Extraction doc-type variants; each carries its own field schema.
CREATE TABLE IF NOT EXISTS extraction_types (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  field_schema TEXT,                         -- JSON: [{name, type}] used for field-typed scoring
  notes        TEXT
);

-- Ground truth, one row per (dataset, task, doc_id). The coverage gate reads these.
CREATE TABLE IF NOT EXISTS gt_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  task       TEXT NOT NULL REFERENCES tasks(slug),
  doc_id     TEXT NOT NULL,
  source_ref TEXT,                           -- S3 link / path to the real doc
  gold_json  TEXT NOT NULL,                  -- the ground-truth value (shape depends on task)
  UNIQUE (dataset_id, task, doc_id)
);

-- A scored submission = one leaderboard row.
CREATE TABLE IF NOT EXISTS runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  task                  TEXT NOT NULL REFERENCES tasks(slug),
  dataset_id            INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  model_config_id       INTEGER NOT NULL REFERENCES model_configs(id),
  extraction_type_id    INTEGER REFERENCES extraction_types(id),      -- extraction only
  classifier_profile_id INTEGER REFERENCES classifier_profiles(id),   -- classification only
  predictions_path      TEXT,                -- stored upload; NULL for manual-entry rows
  coverage_status       TEXT,                -- full | partial | manual
  coverage_missing      INTEGER DEFAULT 0,   -- # GT doc_ids not covered by predictions
  source                TEXT NOT NULL DEFAULT 'upload',   -- upload | manual
  notes                 TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Flexible per-run metrics (differs by task): accuracy, macro_f1, per-field acc, ...
CREATE TABLE IF NOT EXISTS run_metrics (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  key    TEXT NOT NULL,                      -- accuracy | macro_f1 | field:<name> | class:<code>:f1 ...
  value  REAL,
  scope  TEXT NOT NULL DEFAULT 'overall',    -- overall | per_class | per_field | per_doctype
  PRIMARY KEY (run_id, key)
);

-- Per-doc predicted-vs-gold, for error drill-down / audit-vs-source loop.
CREATE TABLE IF NOT EXISTS item_results (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  doc_id         TEXT NOT NULL,
  predicted_json TEXT,
  gold_json      TEXT,
  correct        INTEGER,                    -- 1/0; NULL if not a boolean-scored task
  detail_json    TEXT                        -- per-field breakdown etc.
);

CREATE INDEX IF NOT EXISTS idx_gt_dataset_task ON gt_items(dataset_id, task);
CREATE INDEX IF NOT EXISTS idx_runs_task_dataset ON runs(task, dataset_id);
CREATE INDEX IF NOT EXISTS idx_item_results_run ON item_results(run_id);

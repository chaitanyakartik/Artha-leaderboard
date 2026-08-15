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

-- Canonical model registry. Seeded from /models.json (the verified list of model ids in
-- the repo root). `id` is a stable slug; runs reference it, so names can't collide or dupe.
CREATE TABLE IF NOT EXISTS model_configs (
  id        TEXT PRIMARY KEY,                -- stable id from models.json, e.g. "qwen-gemini"
  name      TEXT NOT NULL UNIQUE,            -- display name, e.g. "Qwen+Gemini"
  notes     TEXT,
  card_json TEXT                             -- full model card (kind, components, base, tasks, ...)
);

-- The 140-class taxonomy for classification.
CREATE TABLE IF NOT EXISTS class_taxonomy (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  code   TEXT NOT NULL UNIQUE,               -- stable class id used in prediction/GT files
  label  TEXT NOT NULL,
  bucket TEXT                                -- coarse group: KYC | PKYC | ITR | financial | property | rental | ...
                                             -- feeds segmentation's bucket-level "popular misses"; NULL until the schema lands
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
  run_key               TEXT UNIQUE,         -- <semantic-slug>-<rand6>; dedup identity
  display_name          TEXT,                -- human name (defaults to semantic), renameable
  task                  TEXT NOT NULL REFERENCES tasks(slug),
  dataset_id            INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  model_config_id       TEXT NOT NULL REFERENCES model_configs(id),
  extraction_type_id    INTEGER REFERENCES extraction_types(id),      -- extraction only
  classifier_profile_id INTEGER REFERENCES classifier_profiles(id),   -- classification only
  predictions_path      TEXT,                -- stored upload; NULL for manual-entry rows
  coverage_status       TEXT,                -- full | partial | manual
  coverage_missing      INTEGER DEFAULT 0,   -- # GT doc_ids not covered by predictions
  source                TEXT NOT NULL DEFAULT 'upload',   -- upload | manual
  origin                TEXT NOT NULL DEFAULT 'ui',       -- ui | wandb | api (ingestion channel)
  external_ref          TEXT,                -- provenance + dedup for auto-ingest (e.g. wandb run path)
  gt_fingerprint        TEXT,                -- GT hash at scoring time (auto-ingest "GT matches" check)
  analysis_json         TEXT,                -- rich per-run analysis (e.g. segmentation "popular misses"); drives the run drill-down
  notes                 TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Same external run must not be auto-ingested twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_external ON runs(origin, external_ref) WHERE external_ref IS NOT NULL;

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

-- Atomic per-page error events (segmentation). The DURABLE layer: every analysis view
-- (confusion matrix, per-class, segment length, worst docs, ...) is a re-aggregation over
-- these, so a new view invented later never requires re-scoring. See scoring/seg_aggregate.js.
CREATE TABLE IF NOT EXISTS analysis_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  doc_id         TEXT NOT NULL,
  page           INTEGER,
  gt_tag         TEXT,           -- start | continue
  pred_tag       TEXT,
  gt_class       TEXT,
  pred_class     TEXT,
  gt_seg_class   TEXT,           -- class of the segment (doc) this page belongs to
  pred_seg_class TEXT,
  gt_bucket      TEXT,           -- coarse bucket (KYC/ITR/...) — NULL until the map is populated
  pred_bucket    TEXT,
  gt_boundary    INTEGER,        -- 1 if an internal GT start (a true boundary)
  pred_boundary  INTEGER,
  error_type     TEXT,           -- NULL | missed_start | false_start | wrong_class
  confidence     REAL,           -- model confidence for this page, if emitted
  prev_gt_class  TEXT            -- class of the preceding segment (for transition analysis)
);
CREATE INDEX IF NOT EXISTS idx_events_run ON analysis_events(run_id);

CREATE INDEX IF NOT EXISTS idx_gt_dataset_task ON gt_items(dataset_id, task);
CREATE INDEX IF NOT EXISTS idx_runs_task_dataset ON runs(task, dataset_id);
CREATE INDEX IF NOT EXISTS idx_item_results_run ON item_results(run_id);

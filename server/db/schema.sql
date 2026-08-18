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
  scope           TEXT NOT NULL DEFAULT 'seg-cls', -- which task-group owns this dataset:
                                              -- 'seg-cls' (segmentation+classification share) | 'extraction' | 'segregation'
  seg_window_mode INTEGER NOT NULL DEFAULT 0, -- 1 = segmentation bundles are sliding WINDOWS (stream slices):
                                              -- score literal start/continue at EVERY page (no forced first-page
                                              -- start), so boundary_recall == "START recall" over all gold starts
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

-- Human notes per (model config × task): a config's notes can differ per task
-- ("great at classification, weak at segmentation boundaries"). Replaces the single models.md blob.
CREATE TABLE IF NOT EXISTS config_task_notes (
  model_config_id TEXT NOT NULL REFERENCES model_configs(id) ON DELETE CASCADE,
  task            TEXT NOT NULL REFERENCES tasks(slug),
  text            TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (model_config_id, task)
);

-- The 140-class taxonomy for classification.
CREATE TABLE IF NOT EXISTS class_taxonomy (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  code   TEXT NOT NULL UNIQUE,               -- stable class id used in prediction/GT files
  label  TEXT NOT NULL,
  bucket TEXT                                -- coarse group: KYC | PKYC | ITR | financial | property | rental | ...
                                             -- feeds segmentation's bucket-level "popular misses"; NULL until the schema lands
);

-- Extraction doc-type variants; each carries its own field schema.
CREATE TABLE IF NOT EXISTS extraction_types (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  field_schema TEXT,                         -- JSON: [{name, type}] used for field-typed scoring
  notes        TEXT
);

-- Prompt library. classification/segmentation keep a list (extraction_type_id NULL); extraction
-- keeps a list per type (extraction_type_id set) or a single global one. Full text stored in-app +
-- versioned, so a leaderboard run can reference exactly the prompt it used.
CREATE TABLE IF NOT EXISTS prompts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task               TEXT NOT NULL REFERENCES tasks(slug),
  extraction_type_id INTEGER REFERENCES extraction_types(id) ON DELETE SET NULL, -- extraction only
  name               TEXT NOT NULL,
  version            TEXT,                    -- free-form (e.g. "v3", "2026-08-15")
  text               TEXT NOT NULL,           -- the actual prompt
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prompts_task ON prompts(task, extraction_type_id);

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
  predictions_path      TEXT,                -- stored upload; NULL for manual-entry rows
  coverage_status       TEXT,                -- full | partial | manual
  coverage_missing      INTEGER DEFAULT 0,   -- # GT doc_ids not covered by predictions
  source                TEXT NOT NULL DEFAULT 'upload',   -- upload | manual
  origin                TEXT NOT NULL DEFAULT 'ui',       -- ui | wandb | api (ingestion channel)
  external_ref          TEXT,                -- provenance + dedup for auto-ingest (e.g. wandb run path)
  gt_fingerprint        TEXT,                -- GT hash at scoring time (auto-ingest "GT matches" check)
  analysis_json         TEXT,                -- rich per-run analysis (e.g. segmentation "popular misses"); drives the run drill-down
  prompt_id             INTEGER REFERENCES prompts(id),        -- the prompt this run used
  supported_classes_json TEXT,               -- DECLARED (not inferred) file types this run's model supports; frozen at ingest. NULL = undeclared (e.g. zero-shot)
  checkpoint            TEXT,                -- which training artifact of the model_config (e.g. "ckpt-1200"); per-run, not in the id
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

-- ---- Analyzers (judge-scored, ingest-only) ------------------------------------

CREATE TABLE IF NOT EXISTS analyzers (
  slug            TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  prod_model      TEXT,
  thinking        TEXT,
  output_type     TEXT,                       -- 'json' | 'text'
  schema_enforced INTEGER NOT NULL DEFAULT 0,
  prompt_source   TEXT,                        -- 'local' | 'langfuse'
  notes           TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0
);

-- THE DATASET (neat GT, normalized from the .txt captures)
CREATE TABLE IF NOT EXISTS analyzer_captures (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id           INTEGER NOT NULL,
  analyzer_slug        TEXT NOT NULL,
  doc_id               TEXT NOT NULL,
  application          TEXT,
  product_type         TEXT,
  input_json           TEXT,               -- parsed INPUT ({"json":...} or {"text":...})
  reference_output_json TEXT,              -- parsed OUTPUT = the real Gemini prod output
  source_ref           TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(dataset_id, analyzer_slug, doc_id)
);

-- A RUN = one model (gemma) submission over a dataset
CREATE TABLE IF NOT EXISTS analyzer_runs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id           INTEGER NOT NULL,
  model_config_id      TEXT NOT NULL,      -- e.g. gemma-4-31b
  ref_model_config_id  TEXT,               -- the reference the judge compared against (gemini-*)
  display_name         TEXT,
  judge_model          TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  notes                TEXT,
  UNIQUE(dataset_id, model_config_id, display_name)
);

-- Per-doc judged result within a run
CREATE TABLE IF NOT EXISTS analyzer_run_items (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                   INTEGER NOT NULL,
  analyzer_slug            TEXT NOT NULL,
  doc_id                   TEXT NOT NULL,
  output_json              TEXT,                   -- gemma output ({"json":...}|{"text":...})
  overall_goodness         REAL,
  faithfulness             REAL,
  completeness             REAL,
  score_rationale_json     TEXT,
  hallucinations_json      TEXT,
  omissions_json           TEXT,
  factual_errors_json      TEXT,
  winner                   TEXT,                   -- 'model' | 'reference' | 'tie'
  comparison_summary       TEXT,
  agreements               TEXT,
  -- reference (gemini) side captured from the judge, for the diff baseline:
  ref_goodness             REAL,
  ref_faithfulness         REAL,
  ref_completeness         REAL,
  ref_score_rationale_json TEXT,
  ref_hallucinations_json  TEXT,
  ref_omissions_json       TEXT,
  ref_factual_errors_json  TEXT,
  UNIQUE(run_id, analyzer_slug, doc_id)
);

CREATE INDEX IF NOT EXISTS idx_analyzer_captures_dataset ON analyzer_captures(dataset_id, analyzer_slug);
CREATE INDEX IF NOT EXISTS idx_analyzer_run_items_run ON analyzer_run_items(run_id, analyzer_slug);

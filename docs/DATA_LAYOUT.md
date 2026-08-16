# Data layout — Hugging Face (JSON only) + S3 (the actual documents)

The documents are large, so **Hugging Face holds only JSON** — ground truth, predictions, and a
map of **S3 URIs** ("bucket links"). The app downloads the JSON and scores; the S3 URIs are just
provenance/audit links (open the real page when drilling into an error). Nothing binary in HF.

Everything is keyed by a **`doc_id`** you define (for segmentation, `doc_id` = `window_id`). The same
`doc_id` must appear in the GT, the predictions, and the sources file — it's the join key and what the
coverage gate checks. All shapes below match what the app already ingests (see `SCHEMAS.md`), so a file
downloaded from HF uploads to the leaderboard as-is.

## HF dataset repo layout

```
artha-eval-data/                        # HF dataset repo (JSON only)
├── README.md
├── models.json                         # model registry (mirror of the app's) — source of truth for model IDs
├── taxonomies/
│   ├── classes.json                    # master class taxonomy: [{code,label,bucket}]
│   └── extraction-types.json           # field schemas per template
├── prompts/
│   ├── classification.json             # [{name,version,text,...}]
│   ├── segmentation.json
│   └── extraction.json                 # per-template prompts
└── datasets/
    └── seg-cls-v1/
        ├── dataset.json                # manifest (name, tasks, counts, seg_window_mode, s3_root)
        ├── sources.json                # doc_id -> S3 URI(s)   ← the "bucket links"
        ├── ground_truth/
        │   ├── segmentation.json
        │   ├── classification.json
        │   ├── extraction.json
        │   └── segregation.json
        └── predictions/
            └── segmentation/
                ├── chandra-4b-ft.ckpt-1200.json    # <model_config_id>.<checkpoint>.json
                └── gemma-12b.v3-ckpt600.json
```

Filename convention for predictions: **`<model_config_id>.<checkpoint>.json`** — the two facts that
identify a benchmark row. The same facts are also inside the file's `meta` block (below), so the file is
self-describing even if renamed.

## The three JSON kinds (templates)

### 1. Sources — the "bucket links" (`sources.json`)
Instead of uploading documents, upload their S3 URIs. Per-doc value is a string (single doc) or a list
(a segmentation window's page images). See `examples/sources.example.json`.
```jsonc
{ "schema": "artha.sources/1", "dataset": "seg-cls-v1", "s3_root": "s3://artha-docs/seg-cls-v1/",
  "docs": {
    "w0": ["s3://artha-docs/seg-cls-v1/appl12/page_001.jpg", "... page_011.jpg"],   // a window's 11 images
    "appl12_doc03": "s3://artha-docs/seg-cls-v1/appl12/doc03.pdf"                    // a single document
  } }
```

### 2. Ground truth (`ground_truth/<task>.json`)
Keyed by `doc_id`; gold shape is per task (same as `SCHEMAS.md §3`). `source_refs` optional here — the app
merges `sources.json` at upload. See `examples/ground_truth.segmentation.example.json`.
```jsonc
{ "schema": "artha.gt/1", "dataset": "seg-cls-v1", "task": "segmentation",
  "gt": { "w0": [ {"page":1,"tag":"start","class":"aadhar_card"}, ... ] } }
```

### 3. Predictions (`predictions/<task>/<model>.<ckpt>.json`)
A **`meta`** header identifies the model + prompt + checkpoint; `predictions` is keyed by `doc_id`, same
shape as GT. See `examples/predictions.segmentation.example.json`.
```jsonc
{ "schema": "artha.pred/1",
  "meta": {
    "model_config_id": "chandra-4b-ft",        // ← the model ID (a stable models.json slug)
    "checkpoint": "full-ft-ckpt-1200",         // which artifact of that config (a per-run attribute)
    "task": "segmentation", "dataset": "seg-cls-v1",
    "prompt": { "name": "unified_seg_cls", "version": "v2" },
    "generated_at": "2026-08-16",
    "env": { "SEGCLS_TRIM_LEAK": 1 },
    "slice": "first-24-start-windows",
    "notes": ""
  },
  "predictions": { "w0": [ {"page":1,"tag":"start","class":"aadhar_card"}, ... ] } }
```
If a doc's model output didn't parse, set its value to `[]` / `null` — the app scores it as a full miss
(the honest 0), not a skip.

## Model IDs (the convention these files rely on)

- **`model_config_id`** — a stable kebab-case slug in `models.json`; the identity every prediction/run
  references. Never renamed or reused; unique (DB PK + sync dedup); carries a model card. It names a
  **model+size+recipe** (e.g. `chandra-4b-ft`, `gemma-12b`, `gemma-31b`), *not* a checkpoint.
- **checkpoint** — a **per-run attribute** (`meta.checkpoint`), so `ckpt-300` and `ckpt-600` of the same
  model are separate rows without polluting the registry.
- **run identity** (assigned by the app on ingest) — `run_key = <task>-<dataset>-<model>-<time>-<rand6>`
  (unique), plus a renameable `display_name` and an optional `external_ref` (unique) for dedup.

## Round-trip
`HF (JSON) → download → app`: upload `ground_truth/<task>.json` (+ `sources.json` as source_refs) once
per dataset+task; upload each `predictions/**.json` as a scored run. The `meta.model_config_id`,
`meta.checkpoint`, and `meta.prompt` populate the run. Taxonomies/prompts import via the `scripts/`.

# Artha Leaderboard / Playground

One place to answer: **"which model config wins, on which task, on which dataset."**
Part of the Artha/DocAI validation revamp. Source dump: `raw/2026-08-14-validation-revamp-jiocare-artha-dump.md`.

## What it is

The app is the **scorer**, not a passive display. You give it a **predictions file** for a model
config; it already holds the **ground-truth (GT)** for that dataset+task, and it **computes the
metrics itself** and stores the leaderboard row.

Two ways to add a row:
- **Upload a predictions file** → app scores it against stored GT (primary path)
- **Manual entry** → type a number directly (external / already-computed results)

## The four tasks

`segmentation · classification · extraction · segregation` — one tab each.

## Core flow

```
1. Create dataset            e.g. "V1"  (5 applicants x 50 docs)
2. Upload GT per (dataset, task)         real data + ground truth, keyed by doc_id
3. Upload predictions file for a model config
      -> COVERAGE GATE: every GT doc_id present in the predictions file?
             missing -> flag + list the missing ids, block scoring (override: score covered subset)
             all present -> score against GT -> store metrics -> row appears on the board
```

## Model configs (seeded, extensible)

`Qwen+Gemini · Qwen+Gemma · Gemma-only · Gemini-only · Chandra-only`

## Per-task extras

- **Extraction** — has **types** (per doc-type variants, each with its own field schema).
- **Classification** — track **which subset of the 140-class list** each classifier was trained
  for (`classifier_profile`). Metrics are scoped to that subset.

## Predictions / GT file contract (keyed by `doc_id`)

| Task           | Predictions                         | GT                         |
|----------------|-------------------------------------|----------------------------|
| classification | `doc_id -> predicted_class (+conf)` | `doc_id -> true_class`     |
| extraction     | `doc_id -> {field: value}`          | `doc_id -> {field: value}` |
| segmentation   | `doc_id -> [segment boundaries]`    | true boundaries            |
| segregation    | `doc_id -> group/applicant_id`      | true grouping              |

## Scoring (metrics per task) — DRAFT, confirm seg/segregation semantics

| Task           | Metrics                                                                    |
|----------------|----------------------------------------------------------------------------|
| classification | accuracy, macro/micro-F1, per-class P/R/F1, confusion — scoped to subset   |
| extraction     | field-typed match (normalize dates/amounts/names), per-field & per-doctype, overall "real accuracy" |
| segmentation   | exact-boundary match rate, per-doc segment F1 / page-range IoU  (TBD)      |
| segregation    | grouping accuracy: Adjusted Rand / purity / exact-group-match   (TBD)      |

## Stack

- **Backend:** Node + Fastify + `better-sqlite3`. Scoring in `server/scoring/<task>.js`.
- **Frontend:** Vite + React + Tailwind (Impeccable-friendly for later UI refinement).
- **DB:** SQLite file.
- **Deploy:** one process on the VM, reached over Tailscale -> drivable from the phone.

## Phasing

- **P1 (scaffold, current):** repo + schema + seed + API + GT upload + coverage gate +
  **classification scorer end-to-end** + minimal 4-tab UI. Prove the loop on the phone.
- **P2:** extraction scorer (reuse field-typed methodology) + per-doc error drill-down.
- **P3:** segmentation + segregation scorers + extraction-types / classifier-profile UI.
- **P4:** auto-ingestion (Madhav's val pipeline POSTs results) -> W&B auto-log on training runs.
- **P5:** UI refinement with Impeccable.

## Data model (SQLite)

```
tasks               fixed 4
datasets            {name, n_applicants, n_docs, source_manifest, notes}
model_configs       {name}  (seeded 5, extensible)
class_taxonomy      the 140-class list
classifier_profiles {name}  + profile_classes(profile_id, class_id)   (classification)
extraction_types    {name, field_schema}                              (extraction)
gt_items            {dataset_id, task, doc_id, source_ref, gold_json}  <- coverage gate reads these
runs                {task, dataset_id, model_config_id, extraction_type_id?, classifier_profile_id?,
                     predictions_path, coverage_status, created_at, notes}
run_metrics         {run_id, key, value, scope}
item_results        {run_id, doc_id, predicted_json, gold_json, correct, detail_json}  <- drill-down
```

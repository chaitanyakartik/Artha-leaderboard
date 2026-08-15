# artha_leaderboard — project guide

Validation leaderboard for Artha / DocAI. **The app is the scorer**: you upload a predictions
JSON for a model config, it scores against stored ground truth, and the row lands on the board.
One place to answer *"which model config wins, on which task, on which dataset."*

- Origin: Second Brain `raw/2026-08-14-validation-revamp-jiocare-artha-dump.md`; tracked in
  `work/artha/artha-validation.md`. Part of chaitu's "deployment" track of the validation revamp.
- Companion docs in this repo: **`PLAN.md`** (design + phasing), **`SCHEMAS.md`** (file contracts).
  This file is the authoritative status + architecture + decisions doc — start here.

---

## 1. Status at a glance

| Area | State |
|---|---|
| Backend API (Fastify + SQLite) | ✅ working |
| Login gate (scrypt + signed cookie) | ✅ working |
| Coverage gate (GT-completeness before scoring) | ✅ working |
| Classification scorer | ✅ solid (normalized labels) |
| Extraction scorer (field-typed) | ✅ solid |
| Segmentation scorer | ✅ per-page start/continue+class; **event-sourced** (one event/page) |
| Segmentation analysis views | ✅ boundary, confusion matrix, per-class/bucket, segment-length, over/under, worst-docs, error taxonomy, transitions+examples, confidence |
| Per-run drill-down UI | ✅ structured, collapsible sections; re-aggregate button |
| Re-aggregate from stored events (no re-score) | ✅ `POST /api/runs/:id/reaggregate` — new views/buckets apply to old runs |
| Class→bucket rollup | 🟡 scaffolded (`class_taxonomy.bucket`); fill it + re-aggregate to light up bucket views |
| Run-to-run regression comparison | ❌ not built (event store makes it a thin add) |
| Segregation scorer | 🟡 works; applicant-grouping confirmed, metrics are standard |
| Run identity (semantic name + random dedup id) | ✅ working |
| Model registry + model cards | ✅ working |
| W&B auto-ingest | 🔴 scaffolded, gated OFF, unimplemented |
| Frontend (4-tab board, upload, manual) | ✅ working, no-build vanilla JS |
| Deploy on the VM / phone access | ❌ not done — runs on localhost only |
| Per-doc error drill-down UI | 🟡 segmentation has a row drop-down (analysis + offenders); other tasks show items only |
| classifier-profile / extraction-type CRUD UI | ❌ not built (tables + scoring hooks exist; seed via SQL) |
| Separate "runs" tab | ❌ deferred by chaitu ("we'll see later") |
| Tests | ❌ none (only `samples/smoke.sh`) |

### Done
- Full REST API; SQLite schema + idempotent init/migrations; model registry synced from `models.json`.
- Four task scorers, coverage gate, upload + manual entry, leaderboard read, per-run detail API.
- Auth: single credential in `.env`, scrypt-hashed password, HMAC-signed session cookie, login page.
- Run identity/dedup, model cards, unified `createRun()` core, W&B scaffold.

### Pending / next
- **Deploy on the VM + reach it from the phone over Tailscale** — the remaining half of the
  original "tonight" target; highest real-world value.
- Confirm the **segmentation schema** (chaitu to supply) and re-check segregation semantics on real data.
- Per-doc **error drill-down** UI (the audit-vs-source loop); CRUD for classifier profiles / extraction types.
- Enable **W&B auto-ingest** when the training→eval loop is ready.
- Tests; the React + "Impeccable" UI pass (P5).

---

## 2. Run it

```bash
npm install
npm run db:init                          # apply schema, seed 4 tasks, sync models.json -> DB
node scripts/set-password.js <user> <pw> # set the login credential (writes .env)
npm run dev                              # http://0.0.0.0:5173  (PORT=xxxx to override)
bash samples/smoke.sh <port>             # end-to-end sanity check
```
- DB is a SQLite file at `data/artha.sqlite` (gitignored, WAL mode). `db:init` is idempotent and
  runs column migrations for older DBs.
- If **no credential is set**, the app runs **open** (dev convenience). Set one to enable the gate.

---

## 3. Architecture

```
models.json            canonical model registry + model cards (verified ids)
server/
  index.js             Fastify app: auth gate, all routes, serves public/
  config.js            tiny .env loader (no dep) + config flags
  auth.js              scrypt password hash/verify + HMAC session cookie
  db.js                sqlite handle, paths (data/, uploads/)
  naming.js            semantic run name + random dedup id (run_key)
  runs.js              createRun(): the ONE run-creation core (upload | manual | ingest)
  ingest/wandb.js      W&B auto-ingest scaffold (gated off)
  db/
    schema.sql         full data model
    seed.sql           the 4 fixed tasks
    init.js            apply schema/seed + migrations + sync models.json
  scoring/
    index.js           dispatch + checkCoverage() (the coverage gate)
    util.js            normalizers (text/label/number/date) + P/R/F1 helpers
    classification.js  accuracy, macro-F1, per-class F1, profile-subset scoping
    extraction.js      field-typed match, per-field + per-doc accuracy
    segmentation.js    per-page scorer: emits atomic EVENTS (one/page) + headline recall
    seg_aggregate.js   PURE aggregator: events -> all analysis views (re-runnable from DB)
    segregation.js     Adjusted Rand Index + purity (partition agreement)
public/                no-build vanilla-JS UI: index.html, app.js, style.css, login.html
scripts/set-password.js  set/reset the login credential
samples/               example GT + prediction files, smoke.sh
```

**Request path:** `onRequest` auth hook → route → (for runs) `createRun()` → per-task scorer →
SQLite. Everything that creates a leaderboard row goes through `createRun()`, so identity, dedup,
coverage and scoring are consistent across the UI, manual entry, and future W&B ingest.

---

## 4. Data model (SQLite — `server/db/schema.sql`)

- `tasks` — the 4 fixed tasks (segmentation, classification, extraction, segregation).
- `datasets` — `{name, n_applicants, n_docs, source_manifest, notes}`; e.g. V1 = 5 applicants × 50 docs.
- `model_configs` — registry; **`id` is a stable slug (PK)**, `card_json` holds the model card.
- `class_taxonomy` (the 140 classes), `classifier_profiles` + `profile_classes` — which subset a
  classifier was trained for (classification scoping).
- `extraction_types` — per-doc-type variants + `field_schema` (drives field-typed scoring).
- `gt_items` — **one row per (dataset, task, doc_id)**; the coverage gate reads these.
- `runs` — one leaderboard row. Identity: `run_key` (UNIQUE, `<semantic>-<rand6>`), renameable
  `display_name`. Provenance: `origin` (ui|wandb|api), `external_ref` (+UNIQUE index → no double
  ingest), `gt_fingerprint`. Coverage: `coverage_status` (full|partial|manual), `coverage_missing`.
- `run_metrics` — flexible `{run_id, key, value, scope}` (metrics differ per task).
- `item_results` — per-doc predicted-vs-gold for drill-down.
- `analysis_events` — **the durable atomic layer** (segmentation): one row per page per run
  (`gt_tag/pred_tag`, classes, `gt_boundary/pred_boundary`, `error_type`, `confidence`, `prev_gt_class`).
  Every analysis view is a re-aggregation over these — a new view (or a newly-populated bucket map)
  applies to historical runs without re-scoring. `runs.analysis_json` is just the cached aggregate.

---

## 5. Metrics per task (and normalization)

Normalizers live in `server/scoring/util.js`:
- **`normalizeText`** — lowercase, NFKC, collapse whitespace, strip punctuation. For free-text fields.
- **`normalizeLabel`** — lowercase, NFKC, collapse whitespace, trim, **no punctuation stripping**.
  For controlled vocab (class codes, group ids) so `bank_statement` / `form-16` survive intact.
- **`normalizeNumber`** — strip non-numeric → numeric compare (`"Rs 12,500"` == `12500`).
- **`normalizeDate`** — parse to `YYYY-MM-DD` (`"12/05/1990"` == `"1990-05-12"`).

| Task | Headline | Also | Notes |
|---|---|---|---|
| classification | `accuracy` | macro-F1, per-class P/R/F1, out-of-scope count | labels normalized via `normalizeLabel`; profile scopes to a class subset |
| extraction | `field_accuracy` | `doc_exact_match`, per-field acc | field-typed via `extraction_types.field_schema`; falls back to string if none |
| segmentation | `boundary_recall` | F1, precision, `missed_boundaries`, `spurious_boundaries`, `page_class_accuracy`, exact-match | per-page `start`/`continue`+`class`; **recall-first: a missed start = two docs merged** (chaitu). Event-sourced → the row drop-down renders confusion matrix, per-class/bucket, segment-length, over/under-seg, worst-docs, error taxonomy, transitions w/ examples, confidence |
| segregation | `ari` | purity, #groups | partition agreement (label values don't need to match, only co-membership) |

---

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/login` · `/api/logout` | session in/out; `GET /api/me` returns current user + auth-configured |
| GET | `/api/tasks` · `/api/models` | reference data; models include their card |
| GET/POST | `/api/datasets` | list / create datasets |
| POST/GET | `/api/datasets/:id/gt` | upload GT per task / get per-task GT counts |
| POST | `/api/runs` | **score a predictions file** (coverage gate; 422 + missing list, `override` to score subset) |
| POST | `/api/runs/manual` | add a row by typing metrics (no scoring) |
| PATCH | `/api/runs/:id` | rename a run's `display_name` |
| GET | `/api/leaderboard?task=&dataset_id=` | the board rows + overall metrics |
| GET/DELETE | `/api/runs/:id` | full run detail (incl. `analysis` + item_results) / delete |
| GET | `/api/runs/:id/events` | raw per-page events (the re-aggregatable layer) |
| POST | `/api/runs/:id/reaggregate` | re-derive `analysis` from stored events (apply new views/buckets, no re-score) |
| POST | `/api/ingest/wandb` | W&B auto-ingest — **501 until `ARTHA_WANDB_INGEST=on`** |

Failure codes map to HTTP via `CODE_STATUS` in `index.js` (e.g. `coverage_incomplete`→422,
`duplicate_external`→409, `gt_mismatch`→409).

---

## 7. Design decisions (and why)

- **The app scores; it isn't a passive display.** Upload predictions → it computes metrics against
  stored GT. This is the core inversion vs a spreadsheet of numbers someone else produced.
- **Coverage gate is mandatory.** No fair cross-config comparison unless every config covered the
  same GT docs. Incomplete files are blocked (422 + the missing list); `override` scores the covered
  subset and flags the row `partial` — never silently.
- **Backend is Node, single language** (chaitu's pick) — over reusing the existing Python scoring.
  Metrics are plain JS; no heavy deps. Whole backend: Fastify + `better-sqlite3`.
- **`models.json` is the canonical registry.** Runs reference `model_configs.id` (a stable slug),
  so model names can't collide or duplicate — dedup enforced at PK + a `seen`-check on sync.
- **One `createRun()` core** for UI upload / manual / ingest. Keeps identity, dedup, coverage and
  scoring identical everywhere and makes the W&B scaffold thin.
- **Run identity = semantic name + random suffix.** `run_key` is `<task-dataset-model-time>-<rand6>`
  (UNIQUE) so repeated scorings never clash; `display_name` is renameable. `external_ref` has a
  UNIQUE index so an auto-ingested source run can't be logged twice.
- **`normalizeLabel` (not full `normalizeText`) for class codes** — lowercasing/trim fixes real
  casing/whitespace mismatches without mangling controlled codes.
- **Segmentation is per-page + recall-first.** A bundle is an ordered page list, each page tagged
  `start`/`continue` with its `class` (grouped form of the pipeline's per-page JSONL). A boundary is
  an internal `start`; missing one silently **merges** two docs → recall is the headline.
- **Segmentation analysis is event-sourced** (the load-bearing decision). The scorer emits one atomic
  event per page to `analysis_events`; **every analysis view is a pure re-aggregation** over those
  events (`seg_aggregate.js`), never baked into the scorer. So a new view invented later — or a
  newly-populated `class_taxonomy.bucket` map — applies to *historical* runs via
  `POST /api/runs/:id/reaggregate`, with **no re-scoring and no re-upload**. `analysis_json` is only a
  cache of the current aggregate. Buckets are **derived at aggregation time** from class (not stored on
  the event), which is what makes the map retroactive.
- **Auth is deliberately minimal** — one credential in `.env`, scrypt-hashed, HMAC-signed cookie,
  no user table, no dependency. Enough to gate a phone-reachable internal tool; not a multi-user system.
- **No-build frontend on purpose** — vanilla JS so it runs on the VM/phone immediately. The React +
  "Impeccable" UI pass is deferred (P5) and shouldn't block the scoring loop.

---

## 8. Roadmap / phasing

- **P1 (done)** — API, 4 scorers, coverage gate, minimal UI, login, run identity, model cards.
- **P2 (next)** — deploy on the VM + phone access; per-doc error drill-down; profile/type CRUD UI.
- **P3** — lock segmentation/segregation semantics on real data; extraction field-schema editor.
- **P4** — **W&B auto-log**: training run finishes → final eval POSTed → GT-fingerprint match →
  auto-create run (`origin:wandb`, renameable). Scaffold is in `server/ingest/wandb.js`.
- **P5** — React + Impeccable UI refinement.

---

## 9. Gotchas / notes for future edits

- **Add a metric** → edit only that task's `scoring/<task>.js`; `run_metrics` is schema-flexible, so
  no migration needed. The UI renders whatever `overall`-scope keys come back.
- **Add a model** → edit `models.json`, re-run `npm run db:init` (upserts; never delete an `id` that
  runs reference).
- **doc_id must be identical** across GT and every predictions file for a dataset — it's the join key
  and what the coverage gate checks. chaitu defines the doc_id scheme.
- **Starter credential** used in dev/smoke: `chaitu` / `changeme-artha` — change it before deploying.
- `.env` is gitignored; only `.env.example` is tracked. `data/` (DB + uploads) is fully gitignored.
- **Add a new segmentation analysis view** → add a derivation to `seg_aggregate.js::aggregate()`
  (pure function of events) and render it in `app.js::renderDetail`. Old runs pick it up via
  `POST /api/runs/:id/reaggregate` — no re-scoring, because the events are already stored.
- **Populate segmentation buckets** → fill `class_taxonomy.bucket` (KYC/PKYC/ITR/financial/property/
  rental/…), then `reaggregate` existing runs (new runs get it automatically). Buckets are derived
  from class at aggregation time, so the map is fully retroactive; no code change needed.
- **Regression comparison (§10, not built)** is deliberately cheap now: diff two runs' aggregates (or
  re-aggregate both from `analysis_events`); the atomic events are the shared substrate.
- **Segregation** still carries a `[semantics DRAFT]` header in-file — confirm what a "group" means on
  real data before trusting ARI/purity. Segmentation's format is locked.

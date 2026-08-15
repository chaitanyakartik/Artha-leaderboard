# artha_leaderboard — repo notes

Validation leaderboard for Artha/DocAI. **The app is the scorer**: upload a predictions JSON for
a model config, it scores against stored ground truth and puts the row on the board. Full design:
`PLAN.md`. Origin dump: Second Brain `raw/2026-08-14-validation-revamp-jiocare-artha-dump.md`.

## Run it
```
npm install
npm run db:init        # apply schema, seed 4 tasks, sync models.json -> DB
npm run dev            # http://0.0.0.0:5173  (PORT=xxxx to override)
```
DB is a SQLite file at `data/artha.sqlite` (gitignored). `npm run db:init` is idempotent.

## Shape
- `server/index.js` — Fastify API + serves `public/`.
- `server/scoring/<task>.js` — one scorer per task; `scoring/index.js` dispatches + holds the
  **coverage gate** (`checkCoverage`). Add a task-metric by editing its scorer only.
- `server/db/schema.sql` + `seed.sql`, `server/db/init.js` — schema/seed/registry sync.
- `models.json` (root) — **canonical model registry**. Add configs here, re-run `db:init`. Runs
  reference `model_configs.id` (a stable slug), so names can't collide.
- `public/` — no-build vanilla-JS UI (4 tabs). P5 replaces this with React + Impeccable.
- `samples/` — example GT + prediction files to exercise the loop.

## Core rule: the coverage gate
Every GT `doc_id` for a `(dataset, task)` must have a prediction, or `POST /api/runs` returns 422
with the missing list. Pass `override:true` to score the covered subset (row flagged `partial`).

## Status / not done yet
- **Classification + extraction scorers are solid.** **Segmentation + segregation metrics are
  DRAFT** — semantics (what a "segment" / "group" is) unconfirmed; see the `[semantics DRAFT]`
  headers in those files.
- No auth, no tests yet. classifier_profiles / extraction_types have tables + scoring hooks but
  no CRUD UI (create via SQL for now).
- Deploy target: one node process on the VM, reached over Tailscale (phone-drivable).
- Next: P2 per-doc error drill-down; P4 auto-ingest from Madhav's val pipeline + W&B auto-log.

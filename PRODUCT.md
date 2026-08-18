# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing codebase, not greenfield. Backend: Fastify + better-sqlite3 (Node, single language).
Frontend: **no-build vanilla JS** (plain `index.html` + `app.js` + `style.css` served from
`public/`) — a deliberate constraint so the app runs on the VM and is reachable from a phone
over Tailscale immediately, with no build step. The redesign preserves this: no framework, no
bundler. A React/"Impeccable" UI pass was explicitly deferred (P5) and must not block the tool.

## Users

Internal tool for the Artha / DocAI ML team. In practice **one operator** (chaitu) manages and
reads it, and it will be **hosted** (VM, reachable from desktop and phone over Tailscale). The
reader is an expert: they know the tasks, the taxonomy, and what the metrics mean. No onboarding
or hand-holding is needed — the audience wants density, precision, and fast answers, not
explanation. Occasionally the board answers "which config wins" at a glance for the operator.

## Product Purpose

One place to answer **"which model config wins, on which task, on which dataset."** The app is
**the scorer, not a passive display**: you upload a predictions JSON for a model config, it scores
that against stored ground truth, and the row lands on the leaderboard. Success = the operator can
upload a run, trust the number, and drill from a headline metric down to the exact documents and
error patterns that explain it — without leaving the tool or running a separate script.

## Positioning

The core inversion vs. a spreadsheet of numbers someone else computed: **the app computes the
metrics itself against a shared, coverage-gated ground truth**, so cross-config comparison is fair
by construction (no config is scored unless it covered the same GT docs). Its second distinction is
an **event-sourced analysis layer** for segmentation — one atomic event per page — so any new
analysis view or taxonomy-bucket map re-aggregates over historical runs with no re-scoring.

## Operating Context

The operator's loop: pick a **task** (segmentation · classification · extraction · segregation)
and a **dataset**, confirm ground truth is loaded (coverage gate), **upload a predictions file**
for a model config, read the headline metric on the board, then **drill down** — model config →
its runs → a per-run analysis drawer. Analysis surfaces are genuinely dense: per-class P/R/F1 +
support, confusion matrices, field-typed extraction tables, segmentation boundary/transition/
over-under/worst-doc views, and per-run taxonomy **coverage** (which file types a run declares
support for, vs. what the eval tested). Also in scope: a **master taxonomy** viewer (140 classes
grouped by bucket) and an editable **models.md** home doc. Runs carry provenance: dataset, prompt
(versioned), template, coverage status, checkpoint, timestamp.

## Capabilities and Constraints

- Four fixed **tasks**, each with its own headline metric: classification (`accuracy`),
  extraction (`field_accuracy` micro), segmentation (`boundary_recall`), segregation (`ari`).
- **Coverage gate** is mandatory: incomplete predictions are blocked (or scored as a flagged
  `partial` subset), never silently compared.
- Board = one row per **model config** (best or latest run's numbers, operator-toggleable),
  expandable to its runs, each run expandable to its analysis drawer.
- Metrics storage is schema-flexible (`run_metrics` key/value/scope); the UI renders whatever
  overall-scope keys a scorer returns — so new metrics need no migration and the layout must
  tolerate a **variable set of metric columns** per task.
- Reference data: datasets (scoped per task-group), prompts library, extraction templates,
  classifier profiles, the class taxonomy with buckets.
- Auth is deliberately minimal: one credential in `.env`, scrypt-hashed, HMAC-signed cookie, a
  standalone login page. Runs open (no gate) if no credential is set.
- **Redesign constraint (from the operator): keep all four task tabs + Taxonomy + Home, and lose
  no existing functionality — the *format* in which information is displayed may change freely, and
  additive improvements are welcome.**

## Brand Commitments

Name: **Artha Leaderboard** (part of the Artha / DocAI validation revamp). No logo or brand kit
supplied. Operator preference recorded as binding: the result must read **neat, legible, and
clean** above visual flash, and must **not** use the neon-green-on-black "coder/terminal" palette.
Dark-vs-light and any committed palette are otherwise open.

## Evidence on Hand

Real working product with real data: SQLite schema, four live scorers, sample GT + prediction
files under `samples/`, a seeded model registry (`models.json`), and a 140-class taxonomy. All
metrics shown are computed by the app from uploaded predictions vs. stored GT — no numbers are
fabricated. No external testimonials, customers, benchmarks, or press exist and none should be
invented; illustrative leaderboard rows used in design mockups are synthetic and must be labeled
as such until real runs replace them.

## Product Principles

- **The app scores; it is not a scoreboard someone else fills in.** Every leaderboard row is a
  computed result against shared ground truth.
- **Fair comparison or none.** The coverage gate is load-bearing; the design must make coverage
  status legible, never hide a `partial`/`manual` row as if it were `full`.
- **Density is a feature, not a failure.** Expert users want to see everything — the redesign
  organizes and paces dense analysis for scanability, it does not thin it out.
- **Drill-down is the point.** Headline → runs → per-doc/per-class/per-field evidence is the core
  path; the layout must keep that descent fast and legible.
- **Runs immediately, everywhere.** No-build, hostable, phone-reachable — craft lives in restraint
  and precision, not in heavy dependencies.

## Accessibility & Inclusion

No formal standard mandated. Practical requirement: long reading sessions on dense numeric tables,
on both a large desktop screen and a phone — so legible type at small sizes, tabular-aligned
numbers, sufficient contrast, and a layout that reflows to a narrow viewport without losing the
metric columns are real needs.

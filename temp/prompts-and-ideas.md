# Artha Leaderboard — every prompt you sent + a feature tracker

Two parts: **Part A** is a checklist of every idea/feature across all your messages (so you can see
what's built vs pending). **Part B** is your prompts, verbatim, in order.

Generated 2026-08-16.

---

## Part A — Feature / idea tracker

Legend: ✅ done · 🟡 partial / built-but-waiting-on-input · ⏸️ deferred by you · ❌ not started

### Segmentation (from the seg dump + the 10-section analysis dump)
- ✅ Per-page format: JSONL, one row/page, `start`/`continue` + `class`; window = bundle
- ✅ Buckets (KYC / PKYC / ITR / financial / property / rental …) — class→bucket map, retroactive
- ✅ Popular segment misses — `class→class` merges (missed) & splits (spurious)
- ✅ Detailed per-run drill-down (the dropdown)
- ✅ §1 Confusion / transition matrix
- ✅ §2 Boundary analysis — precision/recall/F1, missed / false / (displacement) by class & bucket
- ✅ §3 Document-level quality — worst docs, missed boundaries, boundary displacement
- ✅ §4 Segment-length analysis — GT-vs-pred avg length, over/under-segmentation
- ✅ §5 Class-wise performance
- ✅ §6 Bucket-level performance (first-class, not just an aggregation)
- 🟡 §7 Error severity — error **taxonomy** done (missed_start / false_start / wrong_class; shift = displacement); explicit **severity weighting** not yet
- ✅ §8 Representative error examples (attached to each merge/split)
- 🟡 §9 Confidence analysis (confidently-wrong) — built; **auto-activates only if the model emits per-page confidence** (these runs didn't)
- ❌ §10 Run-to-run **regression comparison** (A→B diff) — deferred; the event store makes it a thin add
- ✅ "Store the underlying error events, not just aggregates" — event-sourced (`analysis_events` / `item_results`); every view re-aggregates, `reaggregate` applies new views/buckets to old runs with no re-score
- ✅ cls-acc@start + **window mode** (page 0 is a real start decision, not forced)

### Classification
- ✅ Master class set (the full taxonomy) — imported (60 labels / 10 buckets)
- ✅ Enabled vs NOT-enabled classes per run — frozen **snapshot** so a grown master list is fair to old runs
- ✅ Which classes are bad — per-class P/R/F1 + support, worst-first
- ✅ Confusion matrix
- ⏸️ Active/inactive bucket split — you said "ignore for now"

### Extraction
- ✅ Templates pickable to view results (selector + board filter)
- ✅ Field-wise accuracy
- ✅ Field **presence / support count** (a field in only k of N docs)
- ✅ **Macro** vs **micro** accuracy/average
- ✅ Character-similarity rate (normalized Levenshtein)
- 🟡 Extraction **taxonomy file** (per-type field schemas) — importer built; awaiting your file

### Prompts store
- ✅ Prompt library per task (classification list, segmentation list, extraction per-type)
- ✅ Full text, **versioned**, stored in-app
- ✅ Each run references its prompt + dataset; shown on the leaderboard row

### Data / infra / model IDs
- ✅ Model-ID convention recollected + documented: `model_config_id` = stable slug (model+size+recipe); **checkpoint = per-run attribute**; `run_key` = semantic+random
- ✅ Hugging Face (JSON only) + S3 (docs) layout — `docs/DATA_LAYOUT.md` + `docs/examples/` (sources / GT / predictions / dataset); predictions carry a self-describing `meta` block
- 🟡 Registry slugs — `chandra-4b-ft` added with a real card; `gemma-12b` / `gemma-31b` proposed, not added
- ❌ Self-describing ingest (app reads `meta` from the prediction file to auto-fill) — proposed, not built
- ⏸️ W&B auto-ingest — scaffolded, gated OFF (from before this stretch)
- ❌ VM deploy + phone access over Tailscale — still pending (the original "tonight" other half)
- ✅ Login gate (username/password, encrypted)

### This session's benchmark run
- ✅ `seg-cls-v1` dataset (window mode) + taxonomy loaded
- ✅ **Chandra-4B full-FT ckpt-1200** scored — reproduced the headline exactly: **START recall 0.9394 (31/33), cls-acc@start 0.8788 (29/33)**, 2 missed / 0 spurious
- ⏸️ Gemma-4-12B v3 (ckpt-600 / ckpt-300) — you said skip (model-load env issue on 147)
- ❌ Gemma-4-31B (via box-237 tunnel) — not run
- ⚠️ Note: model predictions were **never saved to disk** by the original evals — they had to be regenerated (Chandra done; the dumps live in `data/seg_dumps/`)

---

## Part B — your prompts, verbatim (in order)

### 1. Segmentation refinement
> Let's start refining each part of it. Now, first, segments. There can be popular segments that we miss often, as in, class A to class B, or class bucket A to bucket B. So, I'll explain the situation. We have different classes of documents, and each of them lie in different buckets like KYC, PKYC, ITR files, financial documents, property documents, rental documents, etc. I will give the schema to you later. For now, just build the format. That in segmentation, when all the metrics are also calculated, we want a detailed analysis of each run as well, or each prediction file as such. And in the detailed analysis, which will be kind of like a drop-down from the model run itself, we also want to see what the popular misses are in segments. And the segmentation file will look like this. It's a JSONL file, each row pointing towards one page, and each of them is classified as a start or a continue, along with its class. Does that make sense?

### 2. "Anything of importance in this dump?" — the 10-section analysis
> you see anything of importance in this dump?? Yeah. If this is meant to become a useful debugging/analysis view for every model run, I'd add a few things beyond popular segment misses.
> 1. Confusion / transition matrix — not just "A → B missed 23 times" but a full matrix (Actual Next × Predicted Next).
> 2. Boundary-level analysis — per actual boundary (GT start/class vs prediction), then aggregate: boundary precision/recall, false starts, missed starts, extra starts, errors by class/bucket transition.
> 3. Document-level segmentation quality — per input doc: pages, GT vs predicted segments, segment-level accuracy, boundaries missed, boundary displacement; rank worst docs.
> 4. Segment length analysis — GT vs predicted avg pages per class; over/under-segmentation; e.g. "merges 1–2 page docs."
> 5. Class-wise performance — precision/recall/F1, boundary recall, false/missed starts, most confused with, common transition errors.
> 6. Bucket-level performance — make bucket analysis first-class (incoming/outgoing transition errors, most confused classes).
> 7. Error severity — classify errors (boundary missed / inserted / shifted / wrong class+correct boundary / correct class+wrong boundary / completely wrong) and assign severity later.
> 8. Error examples / representative samples — keep a few actual examples per major error pattern; clickable later.
> 9. Confidence analysis — if model gives probabilities, bucket missed boundaries by confidence (confidently wrong vs uncertain).
> 10. Regression analysis between runs — Run A → Run B diffs of misses and boundary recall; "what improved/regressed."
> [+ the proposed dropdown structure: Overview / Boundary / Transitions / Class / Bucket / Segment / Worst Cases / Confidence / Run Comparison]
> One thing I'd particularly recommend: don't make the detailed analysis just a bunch of precomputed metrics. **Store the underlying error events too.** Then you can generate new aggregations later without re-running the entire evaluation.

### 3. Classification + Extraction + Prompts store
> Next, refining classification, we will have to, probably under each training set … one master set for all the different types of classes … in each run or each model … show how many we have enabled for that model to predict on / trained the model to predict for, and which ones are not enabled. Because later on if we keep adding more types, those may not exist in the previous benchmarks. … breakdown of which classes are bad.
> And now coming to extraction. All of the templates we showed before should be an option we can pick in extraction to see the results. There'll be multiple fields, so we should see field-wise accuracy. Also, sometimes all fields won't be present in all documents … so for 20 documents a field may appear only 5 times, another 15 times — that count as well. Then macro accuracy/average, micro accuracy/average, character similarity rate (strip/normalize first). The important key point is that it refers to that taxonomy file we shared … which I'll share with you later.
> So we'll have a record of all the prompts as well. … one DB to store the prompts. Classification one list of prompts, segmentation one list, extraction for each type a list or a single prompt. And for the benchmark/run displayed on the leaderboard, we'll reference that it used this prompt, this dataset.

### 4. Plan-mode answers (build decisions)
> Enabled classes: **Named profile, snapshotted.** · Prompts: **Full text, versioned in-app.** · Scope: **one at a time but automate it — build all three and then test all three one by one.**

### 5.
> launch on 6969 port for me to test

### 6.
> ok tell me what all data do you need from   *(message cut off)*

### 7. Taxonomy + first benchmark data drop
> ignore the active/inactive for now, this is the full taxonomy list  *(pasted the full `BUCKET_LABELS` taxonomy — now stored at `taxonomies/classes.json`)*
> per benchmark lets start with dropping in some segmentation data i had, make it v-1 set or something idk how to name it can you help.
> Val set: `/data/chaitanya/data/financial_data/manifests/unified_seg_cls_val_s7.jsonl` — 307 windows (stride-7, 11-image sliding window, 7-item target). Headline on first 24 start-containing windows = 33 gold start-boundaries.
> Prompt: `.../unified_seg_cls/prompts_v2.py` → `UNIFIED_PROMPT`, rendered by `render_prompt()` with `SEGCLS_TRIM_LEAK=1`.
> *(+ the numbers table: Chandra-4B full-FT ckpt-1200 = 93.9% START recall / 87.9% cls-acc@start, best; Gemma-12B v3 ckpt-600 93.9/81.8, ckpt-300 90.9/84.8; Gemma-31B zero-shot 93.9/63.6; etc.)*
> *(+ box-147 session transcript: predictions were **never saved to disk**; can regenerate per-window {window_id, gold, pred}; both H200s free; local = Chandra ckpt-1200 + Gemma-12B v3, 31B needs the 237 tunnel.)*
> and im not sure if the preds are in the correct format tell me

### 8.
> yea fine. 1 is ok, 2 go ahead and use the gpu to generate the numbers.

### 9. Hugging Face + S3 storage structure
> Trying to store all the ground truth in a neat formatted way in Hugging Face. Thing is Hugging Face cannot take that much size, so I want to structure the data as JSON files for predictions, for ground truth, as well as for bucket links — S3 URIs instead of actually sending the documents. Tell me how we can structure this. Give a basic template on the JSON file structure to adhere to. Also store the example JSON structure of the prediction files in the repository under docs or something. And that JSON file also should have some information about the model ID and stuff. But oh wait, I don't remember, we discussed this on how we want to structure the model IDs. Can you help me recollect?

### 10.
> oh okok go on then please

### 11.
> wait i dont get it why are you running again didnt i send you the prediciiotn files as well for those models

### 12.
> bro why. OK leave that i dont care about that skip that. Just use chandras

### 13.
> go

### 14. (this request)
> can You do something. There were a lot and lot of ideas and features i told you about to try to implement but i havent been keeping track. So i want to see all the prompts i sent. Can you store them all under artha-leaderboard/temp in a .md file and ill see it

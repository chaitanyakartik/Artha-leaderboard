# Standard schemas — predictions, ground truth, model cards

The one contract every file must follow so the scorer can read it and the board stays
self-documenting. All files are **JSON**, all doc maps are **keyed by `doc_id`** (you define the
`doc_id`; it must be identical across the GT and every predictions file for the same dataset).

---

## 1. Ground-truth file (uploaded per dataset + task)

```jsonc
{
  "gt": { "<doc_id>": <gold>, ... },       // required
  "source_refs": { "<doc_id>": "s3://..." } // optional: link to the real doc
}
```
A bare `{ "<doc_id>": <gold> }` map is also accepted (treated as `gt`). `<gold>` shape is per task
(below).

## 2. Predictions file (uploaded per model config + task)

```jsonc
{ "<doc_id>": <prediction>, ... }
```
A wrapped `{ "predictions": { ... } }` is also accepted. **Coverage gate:** every `doc_id` in the
GT must be present here, or the run is rejected (422 + missing list) unless `override` is set.

## 3. Per-task value shapes

| Task | `<gold>` / `<prediction>` | Scored by |
|---|---|---|
| **classification** | class code string, or `{ "class": "...", "confidence": 0.9 }` | label match (lowercase+trim); scoped to the run's **enabled** classes (a profile); per-class P/R/F1 + confusion |
| **extraction** | `{ "<field>": <value>, ... }` | field-typed match; per-field **support** + accuracy, **macro & micro** averages, **char-similarity**, doc-exact |
| **segmentation** | ordered page list: `[{ "page":n, "tag":"start"\|"continue", "class":"..." }, ...]` | boundary **recall** (headline), F1, precision, page-class acc + **popular-misses** analysis |
| **segregation** | group id (applicant id) string/number | partition agreement — ARI + purity |

### Examples

Classification GT / prediction:
```json
{ "appl1_doc01": "aadhaar", "appl1_doc02": { "class": "pan", "confidence": 0.98 } }
```
Extraction GT / prediction:
```json
{ "d1": { "name": "Ravi Kumar", "dob": "1990-05-12", "amount": "12500" } }
```
Segmentation GT / prediction — a bundle is a sequence of pages, each tagged `start`/`continue`
with its document `class`. This is the grouped form of the per-page **JSONL** the pipeline emits
(one row = one page); the app keys it by bundle id:
```json
{
  "bundle1": [
    { "page": 1, "tag": "start",    "class": "aadhaar" },
    { "page": 2, "tag": "continue", "class": "aadhaar" },
    { "page": 3, "tag": "start",    "class": "pan" },
    { "page": 4, "tag": "start",    "class": "bank_statement" }
  ]
}
```
- A **boundary** is a `start` after the first page (an internal cut). The first page is always a start
  — **unless the dataset is `seg_window_mode`** (bundles are sliding-window stream slices, e.g. the
  `unified_seg_cls` windows): then page 0 is a real start/continue decision, every gold `start` counts,
  and `boundary_recall` == the eval's **START recall**. Set `seg_window_mode:true` when creating the dataset.
- Tag aliases accepted: `boundary`; values `s`/`c`, `begin`, `true`/`false`. Class aliases: `doc_type`,
  `doc_class`, `category`. Missing tag ⇒ treated as `continue`.
- **Metrics:** boundary **recall** is the headline (a missed start silently merges two docs — the
  costly error), plus precision/F1, `missed_boundaries`, `spurious_boundaries`, `page_class_accuracy`,
  **`cls_acc_at_start`** (classification accuracy on gold-start pages — the eval's cls-acc@start),
  `exact_match`.
- Optional per-page `confidence` (aliases: `conf`, `prob`, `score`) feeds the confidence analysis.
- **Detailed analysis** (per run, the row drop-down) is **event-sourced**: the scorer stores one
  atomic event per page (`analysis_events`), and every view is a re-aggregation over them —
  boundary metrics, confusion matrix, per-class & per-bucket performance, segment-length (GT vs
  predicted), over/under-segmentation, worst documents, error taxonomy (`missed_start` /
  `false_start` / `wrong_class`), `class→class` merges/splits **with example docs**, and confidence.
  Because views derive from stored events, a new view — or a newly-filled `class_taxonomy.bucket`
  map (KYC / PKYC / ITR / financial / property / rental / …) — is applied to old runs via
  `POST /api/runs/:id/reaggregate`, **no re-scoring**. Buckets are `NULL` until the map is populated.
Segregation GT / prediction (each doc -> its applicant):
```json
{ "doc_a": "appl1", "doc_b": "appl1", "doc_c": "appl2" }
```

### Extraction field types
When an **extraction type** is registered with a `field_schema`, each field is matched by its type:
- `string` — normalized text (lowercase, NFKC, whitespace-collapsed, punctuation-stripped)
- `number` / `amount` — numeric equality after stripping non-numeric (`"Rs 12,500"` == `12500`)
- `date` — parsed to `YYYY-MM-DD` (`"12/05/1990"` == `"1990-05-12"`)

Without a registered schema, all fields fall back to `string` matching. Register schemas to get
true "real accuracy" on dates/amounts.

**Support & macro/micro.** A field is only scored on docs where it's present in the GT — its
**support** is that count (a field may appear in 5 of 20 docs). **Micro** field-accuracy pools all
field instances (frequent fields dominate); **macro** averages the per-field accuracies (each field
equal). They diverge when per-field difficulty is uneven — read both. **Char-similarity** is
`1 − levenshtein(normText(pred), normText(gold)) / maxlen`, reported micro + macro — a "how close"
signal distinct from the typed match.

### Classification enabled classes
A run is scored against the **enabled** classes of the classifier **profile** you attach (a named
subset of the master taxonomy). GT docs whose true class is outside the profile are counted as
out-of-scope, not wrong. The enabled set is **snapshotted onto the run**, so as the master list grows
the drill-down still shows this run's `enabled N / master M` and the disabled remainder.

## Prompt & taxonomy files (stored in-app / imported)

**Prompt** (stored via `POST /api/prompts`, full text kept in-app):
```jsonc
{ "task": "classification", "extraction_type_id": null,   // set for extraction (per-template)
  "name": "cls-v3", "version": "2026-08-15", "text": "You are a document classifier. ..." }
```
A run references one prompt (`prompt_id`); the leaderboard row shows its name + version.

**Master class taxonomy** (`node scripts/import-classes.js <file>`) — tolerant input:
```jsonc
[ { "code": "aadhaar", "label": "Aadhaar", "bucket": "KYC" }, ... ]  // or ["aadhaar", ...] or {code:label}
```
**Extraction taxonomy** (`node scripts/import-extraction-types.js <file>`):
```jsonc
[ { "name": "rent_agreement",
    "fields": [ { "name": "tenant_name", "type": "string" }, { "name": "monthly_rent", "type": "amount" } ] } ]
```

---

## 4. Model card (in `models.json`, one per config)

```jsonc
{
  "id": "chandra-only",          // stable slug; runs reference this — never reuse/rename
  "name": "Chandra-only",        // display name
  "kind": "single",              // "single" | "combo"
  "components": ["Chandra-OCR"], // the actual model(s) in the config
  "base": "Chandra-OCR (CPT base)", // finetune base, or null
  "tasks": ["classification", "extraction"], // which of the 4 tasks it targets
  "released": null,              // ISO date or null
  "notes": ""
}
```
Add a model here, run `npm run db:init`, and it appears in the registry. The card is served at
`GET /api/models` so the UI can show what each row's model actually is.

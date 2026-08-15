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
| **classification** | class code string, or `{ "class": "...", "confidence": 0.9 }` | label match (lowercase+trim, codes kept intact) |
| **extraction** | `{ "<field>": <value>, ... }` | field-typed match (string/number/amount/date) |
| **segmentation** | `[[start,end], ...]` or `[{ "start":n, "end":n }, ...]` (page ranges) | boundary **recall** (headline), F1, precision, exact-match |
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
Segmentation GT / prediction (bundle split into page ranges):
```json
{ "bundle1": [[1,3],[4,4],[5,9]] }
```
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

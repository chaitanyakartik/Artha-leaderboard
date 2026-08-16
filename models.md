# Models

Human notes on the model configs being benchmarked. Free-form — edit from the Home page.
(The machine-readable registry the app scores against is `models.json`; this file is for notes.)

## Configs

| id (model_config_id) | what it is | notes |
|---|---|---|
| `chandra-4b-ft` | Chandra-4B full fine-tune (Qwen3.5 backbone) | in-house; unified seg+cls. Checkpoints per-run (e.g. ckpt-1200). |
| `gemma-12b` | Gemma-4 12B | (to add to models.json) |
| `gemma-31b` | Gemma-4 31B | closed baseline; served on box 237 |
| `chandra-only` | Chandra-OCR (CPT base + LoRA) | provisional seed |
| `gemini-only` | Gemini | closed baseline |
| `gemma-only` | Gemma | provisional seed |
| `qwen-gemini` | Qwen OCR + Gemini reasoning | provisional seed |
| `qwen-gemma` | Qwen OCR + Gemma reasoning | provisional seed |

## Conventions
- `model_config_id` = stable slug (model + size + recipe). Never renamed/reused.
- checkpoint is a **per-run** attribute (not part of the id).

## Scratch / TODO
- 

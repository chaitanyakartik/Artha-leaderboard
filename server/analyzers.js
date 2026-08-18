// Shared ingest module for analyzer captures and runs.
// Used by routes in index.js and the importer scripts.
// ES module, 2-space indent, better-sqlite3 via the shared handle.

/**
 * Ensure a model_config row exists, creating it if missing.
 * @param {import('better-sqlite3').Database} d
 * @param {string} id  - stable slug (model_config PK)
 * @param {string} name - display name
 */
export function ensureModelConfig(d, id, name) {
  const exists = d.prepare('SELECT 1 FROM model_configs WHERE id = ?').get(id);
  if (!exists) {
    d.prepare(
      `INSERT OR IGNORE INTO model_configs (id, name, card_json)
       VALUES (?, ?, ?)`
    ).run(id, name || id, JSON.stringify({ kind: 'analyzer-prod' }));
  }
}

/**
 * Encode a value as {"json": x} if it's an object/array, {"text": x} if string, null if nullish.
 */
function encodeValue(v) {
  if (v == null) return null;
  if (typeof v === 'string') return JSON.stringify({ text: v });
  return JSON.stringify({ json: v });
}

/**
 * Ingest an array of capture objects into analyzer_captures.
 * Each capture: { analyzer, doc_id, application?, product_type?, input?, reference_output?, source_ref? }
 *
 * @param {import('better-sqlite3').Database} d
 * @param {number} datasetId
 * @param {object[]} captures
 * @returns {number} count of upserted rows
 */
export function ingestAnalyzerCaptures(d, datasetId, captures) {
  if (!Array.isArray(captures) || captures.length === 0) {
    throw new Error('captures must be a non-empty array');
  }

  const upsert = d.prepare(`
    INSERT INTO analyzer_captures
      (dataset_id, analyzer_slug, doc_id, application, product_type, input_json, reference_output_json, source_ref)
    VALUES
      (@dataset_id, @analyzer_slug, @doc_id, @application, @product_type, @input_json, @reference_output_json, @source_ref)
    ON CONFLICT(dataset_id, analyzer_slug, doc_id) DO UPDATE SET
      application           = excluded.application,
      product_type          = excluded.product_type,
      input_json            = excluded.input_json,
      reference_output_json = excluded.reference_output_json,
      source_ref            = excluded.source_ref
  `);

  let upserted = 0;
  const tx = d.transaction(() => {
    for (const cap of captures) {
      if (!cap.analyzer || typeof cap.analyzer !== 'string') {
        throw new Error('capture missing required field "analyzer"');
      }
      if (!cap.doc_id || typeof cap.doc_id !== 'string') {
        throw new Error(`capture missing required field "doc_id" (analyzer=${cap.analyzer})`);
      }
      // Validate that the analyzer slug is known.
      const analyzerRow = d.prepare('SELECT slug FROM analyzers WHERE slug = ?').get(cap.analyzer);
      if (!analyzerRow) {
        throw new Error(`unknown analyzer slug "${cap.analyzer}" — must be one of the roster slugs`);
      }

      upsert.run({
        dataset_id: datasetId,
        analyzer_slug: cap.analyzer,
        doc_id: cap.doc_id,
        application: cap.application ?? null,
        product_type: cap.product_type ?? null,
        input_json: encodeValue(cap.input),
        reference_output_json: encodeValue(cap.reference_output),
        source_ref: cap.source_ref ?? null,
      });
      upserted++;
    }
  });

  tx();
  return upserted;
}

/**
 * Ingest a run (one model over a dataset) into analyzer_runs + analyzer_run_items.
 * Find-or-create the run row; upsert per-doc items.
 *
 * @param {import('better-sqlite3').Database} d
 * @param {number} datasetId
 * @param {object} opts
 * @param {string} opts.model          - model_config id for the run (e.g. gemma-4-31b)
 * @param {string} [opts.ref_model]    - reference model id (e.g. gemini-3-1-pro)
 * @param {string} [opts.display_name]
 * @param {string} [opts.judge_model]
 * @param {string} [opts.notes]
 * @param {object[]} opts.items        - per-doc results
 * @returns {{ run_id: number, upserted: number }}
 */
export function ingestAnalyzerRun(d, datasetId, { model, ref_model, display_name, judge_model, notes, items }) {
  if (!model || typeof model !== 'string') throw new Error('model (model_config id) is required');
  if (!Array.isArray(items)) throw new Error('items must be an array');

  // Ensure model_configs exist.
  ensureModelConfig(d, model, model);
  if (ref_model) ensureModelConfig(d, ref_model, ref_model);

  // Find or create the run row.
  const resolvedName = display_name || null;
  let run = d.prepare(
    'SELECT id FROM analyzer_runs WHERE dataset_id = ? AND model_config_id = ? AND display_name IS ?'
  ).get(datasetId, model, resolvedName);

  if (!run) {
    const info = d.prepare(`
      INSERT INTO analyzer_runs (dataset_id, model_config_id, ref_model_config_id, display_name, judge_model, notes)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(dataset_id, model_config_id, display_name) DO UPDATE SET
        ref_model_config_id = excluded.ref_model_config_id,
        judge_model         = excluded.judge_model,
        notes               = excluded.notes
    `).run(datasetId, model, ref_model ?? null, resolvedName, judge_model ?? null, notes ?? null);
    run = { id: info.lastInsertRowid };
  } else if (judge_model || ref_model || notes) {
    // Update metadata if already exists.
    d.prepare(
      `UPDATE analyzer_runs SET
         ref_model_config_id = COALESCE(?, ref_model_config_id),
         judge_model         = COALESCE(?, judge_model),
         notes               = COALESCE(?, notes)
       WHERE id = ?`
    ).run(ref_model ?? null, judge_model ?? null, notes ?? null, run.id);
  }

  const runId = run.id;

  const upsert = d.prepare(`
    INSERT INTO analyzer_run_items
      (run_id, analyzer_slug, doc_id, output_json,
       overall_goodness, faithfulness, completeness,
       score_rationale_json, hallucinations_json, omissions_json, factual_errors_json,
       winner, comparison_summary, agreements,
       ref_goodness, ref_faithfulness, ref_completeness,
       ref_score_rationale_json, ref_hallucinations_json, ref_omissions_json, ref_factual_errors_json)
    VALUES
      (@run_id, @analyzer_slug, @doc_id, @output_json,
       @overall_goodness, @faithfulness, @completeness,
       @score_rationale_json, @hallucinations_json, @omissions_json, @factual_errors_json,
       @winner, @comparison_summary, @agreements,
       @ref_goodness, @ref_faithfulness, @ref_completeness,
       @ref_score_rationale_json, @ref_hallucinations_json, @ref_omissions_json, @ref_factual_errors_json)
    ON CONFLICT(run_id, analyzer_slug, doc_id) DO UPDATE SET
      output_json              = excluded.output_json,
      overall_goodness         = excluded.overall_goodness,
      faithfulness             = excluded.faithfulness,
      completeness             = excluded.completeness,
      score_rationale_json     = excluded.score_rationale_json,
      hallucinations_json      = excluded.hallucinations_json,
      omissions_json           = excluded.omissions_json,
      factual_errors_json      = excluded.factual_errors_json,
      winner                   = excluded.winner,
      comparison_summary       = excluded.comparison_summary,
      agreements               = excluded.agreements,
      ref_goodness             = excluded.ref_goodness,
      ref_faithfulness         = excluded.ref_faithfulness,
      ref_completeness         = excluded.ref_completeness,
      ref_score_rationale_json = excluded.ref_score_rationale_json,
      ref_hallucinations_json  = excluded.ref_hallucinations_json,
      ref_omissions_json       = excluded.ref_omissions_json,
      ref_factual_errors_json  = excluded.ref_factual_errors_json
  `);

  let upserted = 0;
  const tx = d.transaction(() => {
    for (const item of items) {
      if (!item.analyzer || typeof item.analyzer !== 'string') {
        throw new Error('item missing required field "analyzer"');
      }
      if (!item.doc_id || typeof item.doc_id !== 'string') {
        throw new Error(`item missing required field "doc_id" (analyzer=${item.analyzer})`);
      }

      const j = item.judge || {};
      const rj = item.reference_judge || {};

      upsert.run({
        run_id: runId,
        analyzer_slug: item.analyzer,
        doc_id: item.doc_id,
        output_json: encodeValue(item.output),
        overall_goodness: j.overall_goodness ?? null,
        faithfulness: j.faithfulness ?? null,
        completeness: j.completeness ?? null,
        score_rationale_json: j.score_rationale != null ? JSON.stringify(j.score_rationale) : null,
        hallucinations_json: j.hallucinations != null ? JSON.stringify(j.hallucinations) : null,
        omissions_json: j.omissions != null ? JSON.stringify(j.omissions) : null,
        factual_errors_json: j.factual_errors != null ? JSON.stringify(j.factual_errors) : null,
        winner: item.winner ?? null,
        comparison_summary: item.comparison_summary ?? null,
        agreements: item.agreements ?? null,
        ref_goodness: rj.overall_goodness ?? null,
        ref_faithfulness: rj.faithfulness ?? null,
        ref_completeness: rj.completeness ?? null,
        ref_score_rationale_json: rj.score_rationale != null ? JSON.stringify(rj.score_rationale) : null,
        ref_hallucinations_json: rj.hallucinations != null ? JSON.stringify(rj.hallucinations) : null,
        ref_omissions_json: rj.omissions != null ? JSON.stringify(rj.omissions) : null,
        ref_factual_errors_json: rj.factual_errors != null ? JSON.stringify(rj.factual_errors) : null,
      });
      upserted++;
    }
  });

  tx();
  return { run_id: runId, upserted };
}

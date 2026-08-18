#!/usr/bin/env node
// Import a gemma evaluation run (results + judge) into analyzer_runs + analyzer_run_items.
// Usage:
//   node scripts/import-analyzer-run.js <resultsDir> <judgementsDir> [datasetName=v4]
//     [modelId=gemma-4-31b] [refModelId=gemini-3-1-pro] [runName]
//
// For each <resultsDir>/*_v4_*.json:
//   - doc_id = stem before _v4_
//   - analyzer slug = looked up from analyzer_captures by doc_id (fallback: strip short code)
//   - Load matching <judgementsDir>/<stem>.judge.json
// Accumulates all items into ONE run, then calls ingestAnalyzerRun once. Idempotent.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../server/db.js';
import { ingestAnalyzerRun } from '../server/analyzers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [,, resultsDir, judgementsDir, datasetName = 'v4', modelId = 'gemma-4-31b', refModelId = 'gemini-3-1-pro', runName] = process.argv;

if (!resultsDir || !judgementsDir) {
  console.error('Usage: node scripts/import-analyzer-run.js <resultsDir> <judgementsDir> [datasetName=v4] [modelId=gemma-4-31b] [refModelId=gemini-3-1-pro] [runName]');
  process.exit(1);
}

const d = db();

// Look up dataset.
const dataset = d.prepare("SELECT id FROM datasets WHERE name = ?").get(datasetName);
if (!dataset) {
  console.error(`Dataset "${datasetName}" not found. Run import-analyzer-gt.js first.`);
  process.exit(1);
}
const datasetId = dataset.id;
console.log(`Using dataset "${datasetName}" (id=${datasetId})`);

const displayName = runName || `${modelId} · ${datasetName}`;
console.log(`Run display_name: "${displayName}"`);

/**
 * Look up the analyzer slug for a doc_id from analyzer_captures.
 * Falls back to matching doc_id prefix against roster slugs if not found in DB.
 */
function resolveAnalyzerSlug(docId) {
  const row = d.prepare(
    'SELECT analyzer_slug FROM analyzer_captures WHERE dataset_id = ? AND doc_id = ? LIMIT 1'
  ).get(datasetId, docId);
  if (row) return row.analyzer_slug;
  return null;
}

// Walk results directory for *_v4_*.json files.
const resultFiles = fs.readdirSync(resultsDir)
  .filter((f) => f.endsWith('.json') && f.includes('_v4_'))
  .sort();

console.log(`\nFound ${resultFiles.length} result file(s) in ${resultsDir}`);

const items = [];
let skipped = 0;
const perAnalyzer = {}; // { slug: { gemma: [goodness...], gemini: [goodness...] } }

for (const f of resultFiles) {
  const stem = f.replace(/\.json$/, '');
  // Split on _v4_ to get doc_id and the short analyzer token.
  const v4Idx = stem.indexOf('_v4_');
  if (v4Idx === -1) continue;
  const docId = stem.slice(0, v4Idx);
  // The short token (bs, ss, 5c, etc.) is just for naming; we look up the real slug from DB.

  // Load result file.
  let result;
  try {
    result = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
  } catch (e) {
    console.warn(`  [WARN] ${f}: failed to parse result JSON — ${e.message}`);
    skipped++;
    continue;
  }

  // Resolve analyzer slug via captures table.
  const analyzerSlug = resolveAnalyzerSlug(docId);
  if (!analyzerSlug) {
    console.warn(`  [WARN] ${f}: doc_id "${docId}" not found in analyzer_captures — skipping. Did you run import-analyzer-gt.js?`);
    skipped++;
    continue;
  }

  // Load matching judge file.
  const judgeFile = path.join(judgementsDir, `${stem}.judge.json`);
  let judge;
  if (!fs.existsSync(judgeFile)) {
    console.warn(`  [WARN] ${f}: no matching judge file at ${judgeFile} — skipping`);
    skipped++;
    continue;
  }
  try {
    judge = JSON.parse(fs.readFileSync(judgeFile, 'utf8'));
  } catch (e) {
    console.warn(`  [WARN] ${f}: failed to parse judge JSON — ${e.message}`);
    skipped++;
    continue;
  }

  // Gemma output: result.gemma, or entire result minus gemini if gemma is empty.
  let output = result.gemma;
  if (output == null || (typeof output === 'object' && Object.keys(output).length === 0)) {
    const { gemini, ...rest } = result;
    output = rest;
  }

  // Map judge fields for gemma side (faithfulness_score -> faithfulness, completeness_score -> completeness).
  const gemmaJudge = judge.gemma || {};
  const geminiJudge = judge.gemini || {};

  const mapScores = (side) => ({
    overall_goodness: side.overall_goodness ?? null,
    faithfulness: side.faithfulness_score ?? side.faithfulness ?? null,
    completeness: side.completeness_score ?? side.completeness ?? null,
    score_rationale: side.score_rationale ?? null,
    hallucinations: side.hallucinations ?? null,
    omissions: side.omissions ?? null,
    factual_errors: side.factual_errors ?? null,
  });

  // Map winner: judge.winner='gemma'->'model', 'gemini'->'reference', else 'tie'.
  let winner;
  const rawWinner = judge.winner;
  if (rawWinner === 'gemma') winner = 'model';
  else if (rawWinner === 'gemini') winner = 'reference';
  else winner = 'tie';

  const item = {
    analyzer: analyzerSlug,
    doc_id: docId,
    output,
    judge: mapScores(gemmaJudge),
    reference_judge: mapScores(geminiJudge),
    winner,
    comparison_summary: judge.comparison_summary ?? null,
    agreements: judge.agreements ?? null,
  };

  items.push(item);

  // Accumulate per-analyzer stats.
  if (!perAnalyzer[analyzerSlug]) perAnalyzer[analyzerSlug] = { gemma: [], gemini: [] };
  if (gemmaJudge.overall_goodness != null) perAnalyzer[analyzerSlug].gemma.push(gemmaJudge.overall_goodness);
  if (geminiJudge.overall_goodness != null) perAnalyzer[analyzerSlug].gemini.push(geminiJudge.overall_goodness);
}

if (items.length === 0) {
  console.log('No valid items to ingest.');
  process.exit(0);
}

// Determine judge_model from first judge file that has it.
let judgeModel = null;
for (const f of resultFiles.slice(0, 5)) {
  const stem = f.replace(/\.json$/, '');
  const judgeFile = path.join(judgementsDir, `${stem}.judge.json`);
  if (fs.existsSync(judgeFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(judgeFile, 'utf8'));
      if (j.judge_model) { judgeModel = j.judge_model; break; }
    } catch {}
  }
}

console.log(`\nIngesting ${items.length} items (${skipped} skipped)...`);
console.log(`  model: ${modelId}, ref_model: ${refModelId}, judge_model: ${judgeModel || 'unknown'}`);

let result;
try {
  result = ingestAnalyzerRun(d, datasetId, {
    model: modelId,
    ref_model: refModelId,
    display_name: displayName,
    judge_model: judgeModel,
    items,
  });
} catch (e) {
  console.error('Ingest failed:', e.message);
  process.exit(1);
}

console.log(`\nRun id=${result.run_id}, upserted ${result.upserted} item(s)`);

// Print per-analyzer gemma vs gemini avg goodness.
console.log('\nPer-analyzer goodness (gemma vs gemini):');
const avg = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 'n/a';
for (const [slug, s] of Object.entries(perAnalyzer).sort()) {
  console.log(`  ${slug.padEnd(20)} gemma=${avg(s.gemma).padStart(5)}  gemini=${avg(s.gemini).padStart(5)}  (n=${s.gemma.length})`);
}

// DB counts for confirmation.
const runCount = d.prepare('SELECT COUNT(*) c FROM analyzer_runs WHERE dataset_id = ?').get(datasetId).c;
const itemCount = d.prepare(
  'SELECT COUNT(*) c FROM analyzer_run_items ari JOIN analyzer_runs ar ON ar.id = ari.run_id WHERE ar.dataset_id = ?'
).get(datasetId).c;
console.log(`\nDB totals for dataset "${datasetName}": analyzer_runs=${runCount}, analyzer_run_items=${itemCount}`);

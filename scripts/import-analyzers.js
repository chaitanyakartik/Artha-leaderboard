// Import analyzer results into the artha_leaderboard DB. Idempotent (upserts).
//
// Usage:
//   node scripts/import-analyzers.js <path> [datasetName]
//
// Two modes, auto-detected:
//   v4 pile  — path is a dir of *.txt files (skip _excluded/); each file = one unscored gemini run.
//   bundles  — path is a dir containing 3_judge.json (or parent of such dirs).
//
// Prints a summary: files parsed, bundles built, rows upserted, per-analyzer counts.

import fs from 'fs';
import path from 'path';
import { db } from '../server/db.js';
import { ingestAnalyzerResults, ensureModelConfig } from '../server/analyzers.js';

// ---- Roster map: slug -> prod_model id (for v4 mode) ----------------------
const PROD_MODEL = {
  overview:         'gemini-3-1-pro',
  application:      'gemini-3-1-pro',
  cibil:            'gemini-3-0-flash',
  bank_statement:   'gemini-3-0-flash',
  financial:        'gemini-3-1-pro',
  gst:              'gemini-3-1-pro',
  rental:           'gemini-3-1-pro',
  five_c_credit:    'gemini-3-0-flash',
  income:           'gemini-3-1-pro',
  policy_deviation: 'gemini-3-5-flash',
};

const PROD_MODEL_NAME = {
  'gemini-3-1-pro':   'Gemini 3.1 Pro',
  'gemini-3-0-flash': 'Gemini 3.0 Flash',
  'gemini-3-5-flash': 'Gemini 3.5 Flash',
};

const GEMMA_MODEL_ID = 'gemma-4-31b';
const GEMMA_MODEL_NAME = 'Gemma-4 31B (dev-artha)';

// ---- Helpers ---------------------------------------------------------------

function slugFromFilename(name) {
  // e.g. "bank_statement_185836_006_ce2c88" → "bank_statement"
  // Match any known slug as a prefix.
  for (const slug of Object.keys(PROD_MODEL)) {
    if (name.startsWith(slug + '_') || name === slug) return slug;
  }
  return null;
}

function getOrCreateDataset(d, name) {
  const existing = d.prepare('SELECT id FROM datasets WHERE name = ?').get(name);
  if (existing) return existing.id;
  const info = d.prepare(
    `INSERT INTO datasets (name, scope) VALUES (?, 'analyzers')`
  ).run(name);
  return info.lastInsertRowid;
}

// ---- v4 pile parser --------------------------------------------------------

function parseV4File(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');

  // Parse header block (before the INPUT delimiter).
  const header = {};
  const inputDelimRe = /^-+\s+INPUT\s+-+$/i;
  const outputDelimRe = /^-+\s+OUTPUT\s+-+$/i;

  let inputStart = -1;
  let outputStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inputDelimRe.test(line.trim())) { inputStart = i + 1; continue; }
    if (outputDelimRe.test(line.trim())) { outputStart = i + 1; continue; }
    // Parse header key: value pairs (before INPUT section)
    if (inputStart === -1) {
      const m = line.match(/^([A-Z_]+)\s*:\s*(.*)$/);
      if (m) header[m[1].trim()] = m[2].trim();
    }
  }

  if (outputStart === -1) throw new Error('no OUTPUT section found');

  const outputText = lines.slice(outputStart).join('\n').trim();
  let output;
  try {
    output = JSON.parse(outputText);
  } catch {
    output = outputText;
  }

  return { header, output };
}

function runV4Mode(d, inputPath, datasetName) {
  const dsName = datasetName || 'v4';
  const datasetId = getOrCreateDataset(d, dsName);

  // Ensure prod model configs exist.
  for (const [id, name] of Object.entries(PROD_MODEL_NAME)) {
    ensureModelConfig(d, id, name);
  }

  const files = fs.readdirSync(inputPath).filter((f) => {
    if (!f.endsWith('.txt')) return false;
    // Skip anything inside _excluded
    return true;
  });

  let parsed = 0;
  let skipped = 0;
  let totalUpserted = 0;
  const perAnalyzer = {};

  for (const filename of files) {
    const filePath = path.join(inputPath, filename);
    // Skip if inside _excluded subdirectory (files directly in _excluded dir)
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
    } catch { continue; }

    const stem = filename.replace(/\.txt$/, '');
    const analyzerSlug = slugFromFilename(stem);
    if (!analyzerSlug) {
      console.warn(`  [skip] ${filename}: cannot map to analyzer slug`);
      skipped++;
      continue;
    }

    let output;
    try {
      const result = parseV4File(filePath);
      const { header } = result;
      output = result.output;

      // application from APPLICATION header field
      const application = (header.APPLICATION && header.APPLICATION !== '-' && header.APPLICATION !== '—')
        ? header.APPLICATION : null;
      // product_type from PRODUCT header field
      const rawProduct = header.PRODUCT || header['PRODUCT TYPE'] || null;
      const product_type = (rawProduct && rawProduct !== '-' && rawProduct !== '—')
        ? rawProduct : null;

      const bundle = {
        analyzer: analyzerSlug,
        doc_id: stem,
        application,
        product_type,
        runs: [{ model: PROD_MODEL[analyzerSlug], output }],
        // no judge
      };

      const n = ingestAnalyzerResults(d, datasetId, [bundle]);
      totalUpserted += n;
      perAnalyzer[analyzerSlug] = (perAnalyzer[analyzerSlug] || 0) + n;
      parsed++;
    } catch (e) {
      console.warn(`  [warn] ${filename}: ${e.message}`);
      skipped++;
    }
  }

  console.log(`\nv4 import complete.`);
  console.log(`  Dataset: "${dsName}" (id=${datasetId})`);
  console.log(`  Files: ${parsed} parsed, ${skipped} skipped`);
  console.log(`  Rows upserted: ${totalUpserted}`);
  console.log(`  Per-analyzer:`);
  for (const [slug, cnt] of Object.entries(perAnalyzer).sort()) {
    console.log(`    ${slug}: ${cnt}`);
  }
  return totalUpserted;
}

// ---- bundle folder parser --------------------------------------------------

function isBundleDir(dirPath) {
  // A bundle dir contains a 3_judge.json directly inside.
  try {
    return fs.existsSync(path.join(dirPath, '3_judge.json'));
  } catch { return false; }
}

function findBundleDirs(rootPath) {
  // If rootPath itself is a bundle dir, return just that.
  if (isBundleDir(rootPath)) return [rootPath];
  // Otherwise walk one level of subdirs.
  const dirs = [];
  for (const entry of fs.readdirSync(rootPath)) {
    const full = path.join(rootPath, entry);
    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory() && isBundleDir(full)) dirs.push(full);
    } catch { /* skip */ }
  }
  return dirs;
}

function parseBundle(bundleDir) {
  const judgeData = JSON.parse(fs.readFileSync(path.join(bundleDir, '3_judge.json'), 'utf8'));

  // Find the 2_*_run.json file.
  const runFile = fs.readdirSync(bundleDir).find((f) => /^2_.*_run\.json$/.test(f));
  if (!runFile) throw new Error('no 2_*_run.json found');
  const runData = JSON.parse(fs.readFileSync(path.join(bundleDir, runFile), 'utf8'));

  // Infer analyzer slug from dir name (e.g. "bank_statement_185836_006_ce2c88_v2" → "bank_statement")
  const dirName = path.basename(bundleDir);
  // Strip trailing _v\d+ suffix, then match slug prefix
  const stemForSlug = dirName.replace(/_v\d+$/, '');
  const analyzerSlug = slugFromFilename(stemForSlug);
  if (!analyzerSlug) throw new Error(`cannot infer analyzer slug from dir name "${dirName}"`);

  // doc_id = dirName stem with trailing _v\d+ stripped
  const doc_id = dirName.replace(/_v\d+$/, '');

  // shared findings from runData
  const findings = runData.findings || {};
  const product_type = (runData.product_type && runData.product_type !== '-' && runData.product_type !== '—')
    ? runData.product_type : null;

  // Determine sides from blinding
  const sideA = judgeData.blinding?.analysis_a || 'gemini';
  const sideB = judgeData.blinding?.analysis_b || 'gemma';
  const sides = [...new Set([sideA, sideB])];

  // Map side name → model_config_id
  function sideToModelId(side) {
    if (side === 'gemma') return GEMMA_MODEL_ID;
    // gemini → that analyzer's prod model
    return PROD_MODEL[analyzerSlug];
  }

  // Judge winner: map side name → model_config_id
  const winnerSide = judgeData.winner || null;
  const winnerModelId = winnerSide ? sideToModelId(winnerSide) : null;

  const runs = sides.map((side) => {
    const modelId = sideToModelId(side);
    // Output = merge findings with per-model output
    const sideOutput = runData[side] || {};
    const output = { ...findings, ...sideOutput };

    // Judge scores for this side
    const judgeScores = judgeData[side];
    let judge = null;
    if (judgeScores) {
      judge = {
        overall_goodness: judgeScores.overall_goodness ?? null,
        faithfulness: judgeScores.faithfulness_score ?? null,
        completeness: judgeScores.completeness_score ?? null,
        score_rationale: judgeScores.score_rationale ?? null,
        hallucinations: judgeScores.hallucinations ?? null,
        omissions: judgeScores.omissions ?? null,
        factual_errors: judgeScores.factual_errors ?? null,
      };
    }

    return { model: modelId, output, judge };
  });

  const bundle = {
    analyzer: analyzerSlug,
    doc_id,
    product_type,
    runs,
    judge_meta: {
      judge_model: judgeData.judge_model || null,
      winner: winnerModelId,
      comparison_summary: judgeData.comparison_summary || null,
      agreements: judgeData.agreements || null,
    },
  };

  return bundle;
}

function runBundleMode(d, inputPath, datasetName) {
  const dsName = datasetName || 'bundles';
  const datasetId = getOrCreateDataset(d, dsName);

  // Ensure model configs.
  for (const [id, name] of Object.entries(PROD_MODEL_NAME)) {
    ensureModelConfig(d, id, name);
  }
  ensureModelConfig(d, GEMMA_MODEL_ID, GEMMA_MODEL_NAME);

  const bundleDirs = findBundleDirs(inputPath);

  let parsed = 0;
  let skipped = 0;
  let totalUpserted = 0;
  const perAnalyzer = {};

  for (const bundleDir of bundleDirs) {
    try {
      const bundle = parseBundle(bundleDir);
      const n = ingestAnalyzerResults(d, datasetId, [bundle]);
      totalUpserted += n;
      perAnalyzer[bundle.analyzer] = (perAnalyzer[bundle.analyzer] || 0) + n;
      parsed++;
    } catch (e) {
      console.warn(`  [warn] ${path.basename(bundleDir)}: ${e.message}`);
      skipped++;
    }
  }

  console.log(`\nBundle import complete.`);
  console.log(`  Dataset: "${dsName}" (id=${datasetId})`);
  console.log(`  Bundle dirs: ${parsed} parsed, ${skipped} skipped`);
  console.log(`  Rows upserted: ${totalUpserted}`);
  console.log(`  Per-analyzer:`);
  for (const [slug, cnt] of Object.entries(perAnalyzer).sort()) {
    console.log(`    ${slug}: ${cnt}`);
  }
  return totalUpserted;
}

// ---- Main ------------------------------------------------------------------

const args = process.argv.slice(2);
const inputPath = args[0];
const datasetName = args[1] || null;

if (!inputPath) {
  console.error('usage: node scripts/import-analyzers.js <path> [datasetName]');
  process.exit(1);
}

if (!fs.existsSync(inputPath)) {
  console.error(`path not found: ${inputPath}`);
  process.exit(1);
}

const d = db();

// Auto-detect mode: bundle folder if it (or any direct subdir) has a 3_judge.json.
const isBundle = isBundleDir(inputPath) ||
  fs.readdirSync(inputPath).some((e) => {
    try { return fs.statSync(path.join(inputPath, e)).isDirectory() && isBundleDir(path.join(inputPath, e)); }
    catch { return false; }
  });

if (isBundle) {
  console.log(`Detected bundle mode. Path: ${inputPath}`);
  runBundleMode(d, inputPath, datasetName);
} else {
  console.log(`Detected v4 pile mode. Path: ${inputPath}`);
  runV4Mode(d, inputPath, datasetName);
}

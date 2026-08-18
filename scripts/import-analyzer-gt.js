#!/usr/bin/env node
// Import GT captures from a v4 .txt capture pile into analyzer_captures.
// Usage: node scripts/import-analyzer-gt.js <v4dir> [datasetName=v4]
//
// Each *.txt file (excluding _excluded prefix) is parsed:
//   - Header block between ==== lines: ANALYZER, APPLICATION, PRODUCT, ...
//   - ---- INPUT ---- section: raw JSON (or text fallback)
//   - ---- OUTPUT ---- section: raw JSON (or text fallback) = Gemini prod reference output
// Idempotent (upsert by dataset+analyzer+doc_id). Creates the dataset if missing.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../server/db.js';
import { ingestAnalyzerCaptures } from '../server/analyzers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [,, v4dir, datasetName = 'v4'] = process.argv;
if (!v4dir) {
  console.error('Usage: node scripts/import-analyzer-gt.js <v4dir> [datasetName=v4]');
  process.exit(1);
}

const d = db();

// Find or create the dataset with scope='analyzers'.
let dataset = d.prepare("SELECT id FROM datasets WHERE name = ?").get(datasetName);
if (!dataset) {
  const info = d.prepare(
    "INSERT INTO datasets (name, scope, notes) VALUES (?, 'analyzers', ?)"
  ).run(datasetName, `Auto-created by import-analyzer-gt.js from ${v4dir}`);
  dataset = { id: info.lastInsertRowid };
  console.log(`Created dataset "${datasetName}" (id=${dataset.id}, scope=analyzers)`);
} else {
  console.log(`Using existing dataset "${datasetName}" (id=${dataset.id})`);
}

/**
 * Parse a v4 .txt capture file.
 * Returns { analyzer, doc_id, application, product_type, input, reference_output }
 * or null if the file can't be parsed.
 */
function parseCaptureFile(filePath) {
  const stem = path.basename(filePath, '.txt');
  const raw = fs.readFileSync(filePath, 'utf8');

  // Split on ==== divider lines (a line of 80+ = chars).
  const parts = raw.split(/^={40,}\s*$/m);
  // parts[0] = before first ====, parts[1] = header block, parts[2] = body after second ====
  if (parts.length < 3) {
    console.warn(`  [WARN] ${stem}: could not split on ==== dividers — skipping`);
    return null;
  }

  const headerBlock = parts[1];
  const body = parts.slice(2).join('====');

  // Parse header fields: "KEY : value"
  const header = {};
  for (const line of headerBlock.split('\n')) {
    const m = line.match(/^([A-Z_]+)\s*:\s*(.+)$/);
    if (m) header[m[1].trim()] = m[2].trim();
  }

  const analyzer = (header['ANALYZER'] || '').toLowerCase().replace(/\s+/g, '_');
  if (!analyzer) {
    console.warn(`  [WARN] ${stem}: no ANALYZER header — skipping`);
    return null;
  }

  const application = header['APPLICATION'] || null;
  // PRODUCT '-' or '—' (em-dash) means null.
  let product_type = header['PRODUCT'] || null;
  if (product_type === '-' || product_type === '—' || product_type === '–' || product_type === '') {
    product_type = null;
  }

  // Split body on INPUT/OUTPUT section markers.
  // Markers: "-+ INPUT -+" or "---- INPUT ----" etc.
  const inputMatch = body.match(/^[-\s]*INPUT[-\s]*$/m);
  const outputMatch = body.match(/^[-\s]*OUTPUT[-\s]*$/m);

  let inputRaw = '';
  let outputRaw = '';

  if (inputMatch && outputMatch) {
    const inputStart = body.indexOf(inputMatch[0]) + inputMatch[0].length;
    const outputStart = body.indexOf(outputMatch[0]) + outputMatch[0].length;
    inputRaw = body.slice(inputStart, body.indexOf(outputMatch[0])).trim();
    outputRaw = body.slice(outputStart).trim();
  } else if (inputMatch) {
    const inputStart = body.indexOf(inputMatch[0]) + inputMatch[0].length;
    inputRaw = body.slice(inputStart).trim();
  } else {
    // Fallback: try entire body as output.
    outputRaw = body.trim();
  }

  const parseSection = (s) => {
    s = s.trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch { return s; }
  };

  return {
    analyzer,
    doc_id: stem,
    application,
    product_type,
    input: parseSection(inputRaw),
    reference_output: parseSection(outputRaw),
  };
}

// Walk the v4 directory.
const files = fs.readdirSync(v4dir)
  .filter((f) => f.endsWith('.txt') && !f.startsWith('_excluded'))
  .sort();

console.log(`\nFound ${files.length} .txt files in ${v4dir}`);

const captures = [];
const perAnalyzer = {};

for (const f of files) {
  const cap = parseCaptureFile(path.join(v4dir, f));
  if (!cap) continue;

  // Check if the analyzer slug is in the roster — warn but skip if not.
  const known = d.prepare('SELECT slug FROM analyzers WHERE slug = ?').get(cap.analyzer);
  if (!known) {
    console.warn(`  [WARN] ${f}: analyzer slug "${cap.analyzer}" not in roster — skipping`);
    continue;
  }

  captures.push(cap);
  perAnalyzer[cap.analyzer] = (perAnalyzer[cap.analyzer] || 0) + 1;
}

if (captures.length === 0) {
  console.log('No valid captures found — nothing to import.');
  process.exit(0);
}

try {
  const upserted = ingestAnalyzerCaptures(d, dataset.id, captures);
  console.log(`\nUpserted ${upserted} capture(s) into dataset "${datasetName}" (id=${dataset.id})`);
} catch (e) {
  console.error('Ingest failed:', e.message);
  process.exit(1);
}

console.log('\nPer-analyzer capture counts:');
for (const [slug, count] of Object.entries(perAnalyzer).sort()) {
  console.log(`  ${slug.padEnd(20)} ${count}`);
}

// Print DB total for confirmation.
const total = d.prepare('SELECT COUNT(*) c FROM analyzer_captures WHERE dataset_id = ?').get(dataset.id).c;
console.log(`\nTotal analyzer_captures for dataset "${datasetName}": ${total}`);

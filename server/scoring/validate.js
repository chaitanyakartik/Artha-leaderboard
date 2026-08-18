// Tolerant shape validator for uploaded predictions.
// validatePredictions(task, predictions) returns null if the payload looks OK,
// or { message, expected } describing the gross mismatch.
//
// Rules are LENIENT: we only reject obvious structural mismatches so we don't
// reject edge-case-valid files.  A few bad values in a mostly-correct map are
// tolerated; only a MAJORITY of sampled values must violate the shape to reject.

const SAMPLE_N = 20;

function sample(obj) {
  const keys = Object.keys(obj);
  const take = Math.min(keys.length, SAMPLE_N);
  const out = [];
  for (let i = 0; i < take; i++) out.push(obj[keys[i]]);
  return out;
}

// Returns true if the value is a plain (non-array, non-null) object.
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Check whether a majority (>50 %) of the sampled values satisfy the predicate.
function majorityFail(values, pred) {
  const failures = values.filter((v) => !pred(v)).length;
  return failures > values.length / 2;
}

export function validatePredictions(task, predictions) {
  // The outer container must be a plain object keyed by doc_id.
  if (Array.isArray(predictions) || predictions === null || typeof predictions !== 'object') {
    return {
      message: 'predictions must be a JSON object keyed by doc_id, not an array/other',
      expected: '{ "<doc_id>": <value>, ... }',
    };
  }

  const keys = Object.keys(predictions);
  if (keys.length === 0) {
    return {
      message: 'predictions object is empty — no doc_id keys found',
      expected: 'at least one { "<doc_id>": <value> } entry',
    };
  }

  const values = sample(predictions);

  if (task === 'classification') {
    // Each value should be a string (the predicted class label), OR a plain object
    // with a "class" or "label" key.
    const ok = (v) =>
      typeof v === 'string' ||
      (isPlainObject(v) && (v.class !== undefined || v.label !== undefined));
    if (majorityFail(values, ok)) {
      const seen = JSON.stringify(values[0]);
      return {
        message: `classification predictions must be a string class label or an object with a "class"/"label" key; got ${seen}`,
        expected: '"<class_label>" or { "class": "<class_label>", ... }',
      };
    }
  } else if (task === 'extraction') {
    // Each value should be a plain object (field → extracted value).
    const ok = (v) => isPlainObject(v);
    if (majorityFail(values, ok)) {
      const seen = JSON.stringify(values[0]);
      return {
        message: `extraction predictions must be plain objects mapping field names to extracted values; got ${seen}`,
        expected: '{ "<field_name>": "<extracted_value>", ... }',
      };
    }
  } else if (task === 'segmentation') {
    // Each value should be an array (ordered page list).
    const ok = (v) => Array.isArray(v);
    if (majorityFail(values, ok)) {
      const seen = JSON.stringify(values[0]);
      return {
        message: `segmentation predictions must be arrays (ordered page list); got ${seen}`,
        expected: '[{ "tag": "start"|"continue", "class": "<class_label>" }, ...]',
      };
    }
  } else if (task === 'segregation') {
    // Each value should be a string or number (a group id).
    const ok = (v) => typeof v === 'string' || typeof v === 'number';
    if (majorityFail(values, ok)) {
      const seen = JSON.stringify(values[0]);
      return {
        message: `segregation predictions must be string or number group ids; got ${seen}`,
        expected: '"<group_id>" or <number>',
      };
    }
  }
  // Unknown task: pass through (scorer will handle it).
  return null;
}

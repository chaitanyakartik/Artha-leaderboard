// Run identity: a human-readable semantic name + a random suffix for dedup.
// A run_key is `<semantic-slug>-<rand6>`; the random suffix guarantees uniqueness even if
// the same (task,dataset,model) is scored many times. display_name is renameable later.
import crypto from 'crypto';

export const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'x';

export const shortId = (n = 6) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);

// Semantic base name, e.g. "classification-v1-chandra-only-20260815-1042".
export function semanticName({ task, dataset, model, date = new Date() }) {
  const iso = date.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 16).replace(':', '')}`; // YYYYMMDD-HHMM
  return `${slug(task)}-${slug(dataset)}-${slug(model)}-${stamp}`;
}

// Full dedup key. Caller should retry on the (astronomically unlikely) UNIQUE collision.
export function makeRunKey(base) {
  return `${slug(base)}-${shortId(6)}`;
}

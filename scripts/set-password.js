// Set / reset the login credential. Writes ARTHA_USER, ARTHA_PASS_HASH (scrypt) and a
// random ARTHA_SECRET into /.env, preserving any other keys already there.
//
//   node scripts/set-password.js <username> <password>
//   node scripts/set-password.js            # interactive prompt
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { hashPassword } from '../server/auth.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(ROOT, '.env');

function upsertEnv(updates) {
  const lines = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8').split('\n') : [];
  const keys = Object.keys(updates);
  const seen = new Set();
  const out = lines.map((line) => {
    const k = keys.find((key) => line.startsWith(key + '='));
    if (k) { seen.add(k); return `${k}=${updates[k]}`; }
    return line;
  });
  for (const k of keys) if (!seen.has(k)) out.push(`${k}=${updates[k]}`);
  fs.writeFileSync(ENV, out.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n').replace(/\n*$/, '\n'));
}

function apply(user, pass) {
  if (!user || !pass) { console.error('username and password required'); process.exit(1); }
  const updates = { ARTHA_USER: user, ARTHA_PASS_HASH: hashPassword(pass) };
  // Only mint a session secret if one isn't already present.
  const existing = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  if (!/^ARTHA_SECRET=.+/m.test(existing)) updates.ARTHA_SECRET = crypto.randomBytes(32).toString('hex');
  upsertEnv(updates);
  console.log(`Credential set for user "${user}". Wrote ${ENV}`);
  console.log('Restart the server to apply.');
}

const [, , argUser, argPass] = process.argv;
if (argUser && argPass) {
  apply(argUser, argPass);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Username: ', (user) => {
    rl.question('Password: ', (pass) => { rl.close(); apply(user.trim(), pass); });
  });
}

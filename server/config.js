// Minimal .env loader (no dependency). Reads KEY=VALUE lines from /.env into process.env
// without overwriting anything already set in the real environment.
import fs from 'fs';
import path from 'path';
import { ROOT } from './db.js';

const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

export const config = {
  user: process.env.ARTHA_USER || '',
  passHash: process.env.ARTHA_PASS_HASH || '',
  secret: process.env.ARTHA_SECRET || '',
  port: Number(process.env.PORT || 5173),
  sessionHours: Number(process.env.ARTHA_SESSION_HOURS || 168), // 7 days
  wandbIngest: String(process.env.ARTHA_WANDB_INGEST || 'off').toLowerCase() === 'on', // future auto-log
};

export const authConfigured = () => Boolean(config.user && config.passHash && config.secret);

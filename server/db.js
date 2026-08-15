import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
export const DATA_DIR = process.env.ARTHA_DATA || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const DB_PATH = process.env.ARTHA_DB || path.join(DATA_DIR, 'artha.sqlite');

let _db;
export function db() {
  if (!_db) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

// Whole-DB export: every table as CSV (zipped) or a consistent .sqlite snapshot.
// Dependency-free — the DB is mostly small text, so we build CSVs in memory and
// pack them with a tiny store-only ZIP writer (no compression, correct CRC32).
import fs from 'fs';
import path from 'path';
import { DB_PATH, DATA_DIR } from './db.js';

// ---- table introspection --------------------------------------------------
// User tables only (skip sqlite internals and FTS shadow tables).
export function listTables(d) {
  return d
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((r) => r.name);
}

// ---- CSV ------------------------------------------------------------------
function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  if (Buffer.isBuffer(v)) v = v.toString('base64'); // BLOBs -> base64 so nothing is lost
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function tableToCsv(d, table) {
  const rows = d.prepare(`SELECT * FROM "${table}"`).all();
  const cols = d.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  const lines = [cols.map(csvCell).join(',')];
  for (const row of rows) lines.push(cols.map((c) => csvCell(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

// ---- minimal store-only ZIP (no deps) -------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, data: Buffer }]  -> a Buffer of a valid store-only .zip
export function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header sig
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method 0 = store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (fixed, arbitrary)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    chunks.push(local, name, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // central dir sig
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0x0800, 8); // flags: UTF-8
    cen.writeUInt16LE(0, 10); // method
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30); // extra len
    cen.writeUInt16LE(0, 32); // comment len
    cen.writeUInt16LE(0, 34); // disk number
    cen.writeUInt16LE(0, 36); // internal attrs
    cen.writeUInt32LE(0, 38); // external attrs
    cen.writeUInt32LE(offset, 42); // local header offset
    central.push(cen, name);

    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central dir sig
  end.writeUInt16LE(files.length, 8); // entries on this disk
  end.writeUInt16LE(files.length, 10); // total entries
  end.writeUInt32LE(centralBuf.length, 12); // central dir size
  end.writeUInt32LE(offset, 16); // central dir offset
  return Buffer.concat([...chunks, centralBuf, end]);
}

// Whole DB -> one zip with a CSV per table.
export function exportCsvZip(d) {
  const files = listTables(d).map((t) => ({ name: `${t}.csv`, data: Buffer.from(tableToCsv(d, t), 'utf8') }));
  return zipStore(files);
}

// ---- .sqlite snapshot -----------------------------------------------------
// VACUUM INTO gives a compact, WAL-collapsed, consistent copy in one file.
// Returns the temp path; caller streams it then unlinks.
export function snapshotSqlite(d) {
  const tmp = path.join(DATA_DIR, `export-${Date.now()}.sqlite`);
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp); // VACUUM INTO requires the target not exist
  d.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  return tmp;
}

export { DB_PATH };

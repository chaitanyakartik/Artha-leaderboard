// Auth primitives — scrypt password hashing + HMAC-signed session cookie. No dependencies.
import crypto from 'crypto';
import { config } from './config.js';

const COOKIE = 'artha_session';

// ---- password hashing (scrypt) -------------------------------------------
// Stored form: scrypt$<saltHex>$<hashHex>
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ---- signed session token -------------------------------------------------
// token = base64url(payloadJson).base64url(hmac)
function b64u(buf) { return Buffer.from(buf).toString('base64url'); }

export function issueToken(username) {
  const payload = JSON.stringify({ u: username, exp: nowSec() + config.sessionHours * 3600 });
  const body = b64u(payload);
  const sig = b64u(crypto.createHmac('sha256', config.secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = b64u(crypto.createHmac('sha256', config.secret).update(body).digest());
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < nowSec()) return null;
    return payload;
  } catch { return null; }
}

// ---- cookie helpers -------------------------------------------------------
export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token) {
  const maxAge = config.sessionHours * 3600;
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
export const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
export const COOKIE_NAME = COOKIE;

const nowSec = () => Math.floor(Date.now() / 1000);

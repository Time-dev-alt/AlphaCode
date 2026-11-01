/**
 * Platform cryptography: password hashing (scrypt), signed tokens, symmetric
 * encryption for BYOK keys / deploy tokens, and constant-time comparisons.
 *
 * Nothing in here depends on third-party packages so the bundle stays small and
 * auditable.
 */
import crypto from 'node:crypto';
import { loadSecret } from '../config.mjs';

const secret = loadSecret();
const encKey = crypto.createHash('sha256').update(Buffer.concat([secret, Buffer.from('alphacode:aes')])).digest();

export const b64u = {
  enc: (buf) => Buffer.from(buf).toString('base64url'),
  dec: (str) => Buffer.from(str, 'base64url'),
};

export function randomId(prefix = '', bytes = 16) {
  return prefix + crypto.randomBytes(bytes).toString('base64url');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** scrypt password hash: scrypt$N$r$p$salt$hash */
export function hashPassword(password) {
  const N = 16384,
    r = 8,
    p = 1;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N, r, p, maxmem: 96 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * 1024 * 1024,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function timingSafeEqual(a, b) {
  const A = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const B = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (A.length !== B.length) {
    // still do work to avoid trivial length oracle
    crypto.timingSafeEqual(A, A);
    return false;
  }
  return crypto.timingSafeEqual(A, B);
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest();
}

export function sign(value, purpose = 'generic', ttlMs = 0) {
  const exp = ttlMs ? Date.now() + ttlMs : 0;
  const payload = `${purpose}.${exp}.${value}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(value, 'utf8').toString('base64url')}.${exp}.${mac}`;
}

export function unsign(token, purpose = 'generic') {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [valB64, expStr, mac] = parts;
  let value;
  try {
    value = Buffer.from(valB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const exp = Number(expStr) || 0;
  if (exp && Date.now() > exp) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${purpose}.${exp}.${value}`).digest('base64url');
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return { value, exp };
}

/** AES-256-GCM envelope: v1.<iv>.<tag>.<ciphertext> */
export function encrypt(plaintext) {
  if (plaintext === undefined || plaintext === null || plaintext === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(blob) {
  if (!blob) return '';
  const [v, ivB64, tagB64, ctB64] = String(blob).split('.');
  if (v !== 'v1') return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function mask(secretValue) {
  if (!secretValue) return '';
  const s = String(secretValue);
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** Fingerprint used to dedupe secrets without storing them in clear. */
export function fingerprint(value) {
  return sha256(String(value)).toString('hex').slice(0, 16);
}

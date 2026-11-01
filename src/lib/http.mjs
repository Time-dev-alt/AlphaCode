/**
 * Minimal, hardened HTTP toolkit: routing, JSON bodies with hard limits,
 * cookie helpers, SSE writer, static file serving, and security headers.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.mjs';
import { log, redact } from './log.mjs';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || message;
  }
}
export const bad = (msg = 'Bad request', code) => new HttpError(400, msg, code);
export const unauthorized = (msg = 'Sign in required', code) => new HttpError(401, msg, code);
export const forbidden = (msg = 'Forbidden', code) => new HttpError(403, msg, code);
export const notFound = (msg = 'Not found', code) => new HttpError(404, msg, code);
export const tooMany = (msg = 'Rate limit reached', code) => new HttpError(429, msg, code);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
export const mimeFor = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

export function parseCookies(header = '') {
  const out = Object.create(null);
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (!k || k.length > 64) continue;
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.secure ?? config.security.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

export async function readBody(req, limit = config.security.maxBodyBytes) {
  const chunks = [];
  let size = 0;
  return new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Payload too large', 'payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit) {
  const ct = String(req.headers['content-type'] || '');
  if (!/application\/json/i.test(ct) && req.method !== 'GET' && req.method !== 'DELETE') {
    throw new HttpError(415, 'Expected application/json', 'unsupported_media_type');
  }
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  if (buf.length > (limit || config.security.maxBodyBytes)) throw new HttpError(413, 'Payload too large');
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw new HttpError(400, 'Invalid JSON body', 'invalid_json');
  }
}

export function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(String(text));
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    ...headers,
  });
  res.end(body);
}

export function redirect(res, location, status = 302, headers = {}) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

/** Server-Sent Events writer with heartbeat + backpressure guard. */
export function openSSE(req, res, extraHeaders = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'identity',
    ...extraHeaders,
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  let closed = false;
  const closeHandlers = new Set();
  const heartbeat = setInterval(() => {
    if (!closed) {
      try {
        res.write(': hb\n\n');
      } catch {
        closed = true;
      }
    }
  }, 15000);
  if (heartbeat.unref) heartbeat.unref();

  const sse = {
    get closed() {
      return closed;
    },
    send(event, data, id) {
      if (closed) return false;
      try {
        let frame = '';
        if (id !== undefined) frame += `id: ${id}\n`;
        frame += `event: ${event}\n`;
        frame += `data: ${JSON.stringify(data ?? null)}\n\n`;
        res.write(frame);
        return true;
      } catch (err) {
        log.debug('sse write failed', err.message);
        closed = true;
        return false;
      }
    },
    comment(text) {
      if (!closed) res.write(`: ${text}\n\n`);
    },
    onClose(fn) {
      closeHandlers.add(fn);
      return () => closeHandlers.delete(fn);
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const fn of closeHandlers) {
        try {
          fn();
        } catch {}
      }
      closeHandlers.clear();
      try {
        res.end();
      } catch {}
    },
  };
  req.on('close', () => {
    if (closed) {
      clearInterval(heartbeat);
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    for (const fn of closeHandlers) {
      try {
        fn();
      } catch {}
    }
    closeHandlers.clear();
  });
  return sse;
}

/** Tiny router with `:param` support and per-route method dispatch. */
export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler, opts = {}) {
    const segments = pattern.split('/').filter(Boolean);
    this.routes.push({ method, segments, handler, opts, pattern });
    return this;
  }
  get(p, h, o) {
    return this.add('GET', p, h, o);
  }
  post(p, h, o) {
    return this.add('POST', p, h, o);
  }
  put(p, h, o) {
    return this.add('PUT', p, h, o);
  }
  patch(p, h, o) {
    return this.add('PATCH', p, h, o);
  }
  delete(p, h, o) {
    return this.add('DELETE', p, h, o);
  }
  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method && !(route.method === 'GET' && method === 'HEAD')) continue;
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }
}

/** Serve a file with ETag + strong cache headers for hashed assets. */
export async function serveFile(req, res, filePath, headers = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const inm = req.headers['if-none-match'];
  const base = {
    'Content-Type': mimeFor(filePath),
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  };
  if (inm && inm === etag) {
    res.writeHead(304, { ETag: etag, ...base });
    res.end();
    return true;
  }
  const cache = /\/assets\/.*\.[0-9a-f]{8}\./i.test(filePath)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache, must-revalidate';
  res.writeHead(200, {
    'Content-Type': base['Content-Type'],
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': cache,
    ...headers,
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.end());
  stream.pipe(res);
  return true;
}

export function securityHeaders(req, res, extra = {}) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "media-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      `frame-ancestors ${config.security.frameAncestors}`,
    ].join('; '),
    ...extra,
  };
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
}

export function clientIp(req) {
  if (config.security.trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).split(',')[0].trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '0.0.0.0';
}

/** Sliding-window in-memory rate limiter (per key). */
export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    const cleanup = setInterval(() => this.sweep(), Math.max(30000, windowMs)).unref?.();
    if (cleanup) this.cleanup = cleanup;
  }
  sweep() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, list] of this.hits) {
      const kept = list.filter((t) => t > cutoff);
      if (!kept.length) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }
  hit(key, cost = 1) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (list.length + cost > this.max) {
      const retryAfter = Math.ceil((list[0] + this.windowMs - now) / 1000);
      this.hits.set(key, list);
      return { ok: false, retryAfter, remaining: 0 };
    }
    for (let i = 0; i < cost; i++) list.push(now);
    this.hits.set(key, list);
    return { ok: true, remaining: Math.max(0, this.max - list.length), retryAfter: 0 };
  }
}

export function etagFor(buf) {
  return 'W/"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"';
}

export function safeJson(res, status, data) {
  try {
    sendJson(res, status, redactObject(data));
  } catch (err) {
    log.error('failed to serialise response', err.message);
  }
}

function redactObject(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(password|passwordHash|token|apiKey|key|cookie|secret|authorization)$/i.test(k)) {
        out[k] = v ? '••••' : v;
      } else out[k] = redactObject(v);
    }
    return out;
  }
  return value;
}

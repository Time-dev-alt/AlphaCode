#!/usr/bin/env node
/**
 * Local preview of the *Pages* build: static server + a tiny shim for the
 * Pages Functions (OAuth endpoints), so `npm run dev` matches production.
 *
 *   node scripts/dev-pages.mjs [--port=3001]
 *
 * There is no app server here — the page is static and the agent runs in the
 * browser. This only exists so you can click around locally.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const arg = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const PORT = Number(arg('port', process.env.PORT || 3001));

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log('[dev] building first…');
  execFileSync(process.execPath, ['scripts/build-pages.mjs'], { cwd: ROOT, stdio: 'inherit' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const FUNCTIONS = path.join(ROOT, 'functions');

/**
 * Resolve a request path to a Pages Function, the way Pages does:
 * an exact file first, then a `[[path]]` catch-all in the nearest folder.
 *   /api/llm/kilo/chat/completions → functions/api/llm/[[path]].js  (path: kilo/chat/completions)
 *   /api/npm/ms                    → functions/api/npm/[[path]].js
 */
function resolveFunction(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (!parts.length || parts[0] !== 'api') return null;
  const direct = path.join(FUNCTIONS, `${parts.join('/')}.js`);
  if (fs.existsSync(direct)) return { file: direct, params: {} };
  for (let i = parts.length - 1; i >= 1; i--) {
    const catchAll = path.join(FUNCTIONS, ...parts.slice(0, i), '[[path]].js');
    if (fs.existsSync(catchAll)) return { file: catchAll, params: { path: parts.slice(i) } };
  }
  return null;
}

/** The headers `functions/_middleware.js` would add in production. */
function platformHeaders(req, extra = {}) {
  const isolated = String(req.headers.cookie || '')
    .split(';')
    .some((pair) => pair.trim().startsWith('nex_wc='));
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://cdn.tailwindcss.com https://unpkg.com https://esm.sh https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      // The relay and the providers both need HTTPS, and esm.sh serves the
      // compiler/container SDKs used by the opt-in runtimes.
      "connect-src 'self' blob: data: https:",
      "worker-src 'self' blob:",
      "frame-src 'self' blob: data: https:",
      "media-src 'self' blob: data:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': isolated ? 'same-origin' : 'same-origin-allow-popups',
    ...(isolated ? { 'Cross-Origin-Embedder-Policy': 'credentialless' } : {}),
    ...extra,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = resolveFunction(url.pathname);

  if (route) {
    try {
      const mod = await import(path.join(route.file));
      const handler = mod.onRequest || mod.onRequestGet || mod.default;
      if (typeof handler !== 'function') throw new Error(`${path.basename(route.file)} has no onRequest export`);
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const chunks = [];
      for await (const chunk of hasBody ? req : []) chunks.push(chunk);
      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      });
      const response = await handler({ request, env: process.env, params: route.params, next: async () => new Response('not found', { status: 404 }) });
      const headers = platformHeaders(req, Object.fromEntries(response.headers));
      res.writeHead(response.status, headers);
      if (response.body) {
        Readable.fromWeb(response.body).pipe(res);
      } else {
        res.end(Buffer.from(await response.arrayBuffer()));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Function failed: ${err.message}`);
    }
    return;
  }

  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) file = path.join(DIST, 'index.html');
  const body = await fsp.readFile(file);
  res.writeHead(
    200,
    platformHeaders(req, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': file.includes('/assets/') ? 'public, max-age=3600' : 'no-store',
    }),
  );
  res.end(body);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  AlphaCode (client-side build)\n  → http://localhost:${PORT}\n`);
  console.log('  The agent, files, shell and SQLite all run in the tab.');
  console.log('  GitHub OAuth needs GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET in the environment.\n');
});

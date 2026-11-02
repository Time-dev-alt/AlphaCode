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

const starts = new Map([
  ['/api/oauth/github/start', 'functions/api/oauth/github/start.js'],
  ['/api/oauth/github/callback', 'functions/api/oauth/github/callback.js'],
  ['/api/health', 'functions/api/health.js'],
]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = starts.get(url.pathname);

  if (route) {
    try {
      const mod = await import(path.join(ROOT, route));
      const handler = mod.onRequestGet || mod.onRequest;
      const response = await handler({
        request: new Request(url.toString(), { method: req.method, headers: req.headers }),
        env: process.env,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
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
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': file.includes('/assets/') ? 'public, max-age=3600' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  AlphaCode (client-side build)\n  → http://localhost:${PORT}\n`);
  console.log('  The agent, files, shell and SQLite all run in the tab.');
  console.log('  GitHub OAuth needs GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET in the environment.\n');
});

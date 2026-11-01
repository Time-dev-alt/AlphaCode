/**
 * Build-pipeline tests. These run the real build script and inspect its output,
 * because the failure mode they guard against (module imports pointing at
 * unhashed filenames that do not exist in dist/) is invisible to unit tests.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');

function build(extra = []) {
  return execFileSync(process.execPath, ['scripts/build.mjs', ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

before(() => {
  build();
});

const readIndex = () => fs.readFileSync(path.join(DIST, 'public', 'index.html'), 'utf8');

test('build emits hashed assets, SRI and a module-integrity import map', () => {
  const html = readIndex();
  const scripts = html.match(/<script type="module"[^>]+>/g) || [];
  assert.equal(scripts.length, 1, 'one module entry');
  assert.match(scripts[0], /src="\/assets\/app\.[0-9a-f]{8}\.js"/);
  assert.match(scripts[0], /integrity="sha384-[A-Za-z0-9+/=]{20,}"/);
  assert.match(scripts[0], /crossorigin="anonymous"/);
  assert.match(html, /<link rel="stylesheet" href="\/assets\/app\.[0-9a-f]{8}\.css"[^>]*integrity="sha384-/);
  assert.match(html, /<script type="importmap">\{"integrity":\{[^}]*"\/assets\/util\.[0-9a-f]{8}\.js"/);
});

test('the module graph inside dist/ is self-consistent', () => {
  const assets = fs.readdirSync(path.join(DIST, 'public', 'assets'));
  const appFile = assets.find((f) => f.startsWith('app.') && f.endsWith('.js'));
  const code = fs.readFileSync(path.join(DIST, 'public', 'assets', appFile), 'utf8');
  const imports = [...code.matchAll(/from\s*["'](\.\/[^"']+)["']/g)].map((m) => m[1].replace('./', ''));
  assert.ok(imports.length >= 2, `expected module imports, saw ${imports.length}`);
  for (const dep of imports) {
    assert.ok(assets.includes(dep), `app imports ./${dep}, missing from dist assets`);
  }
});

test('integrity manifest matches the bytes on disk', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'integrity.json'), 'utf8'));
  const crypto = await import('node:crypto');
  const names = Object.keys(manifest.assets);
  assert.ok(names.length >= 4);
  for (const name of names) {
    const bytes = fs.readFileSync(path.join(DIST, 'public', 'assets', name));
    const actual = 'sha384-' + crypto.createHash('sha384').update(bytes).digest('base64');
    assert.equal(manifest.assets[name], actual, `${name} hash drifted`);
  }
});

test('server bundle boots from dist/ and serves the built shell', async () => {
  const { spawn } = await import('node:child_process');
  const port = 3600 + Math.floor(Math.random() * 200);
  const logFile = path.join(ROOT, 'dist', `.boot-${port}.log`);
  const out = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'start.mjs'], {
    cwd: DIST,
    env: { ...process.env, PORT: String(port), ALPHACODE_PORT: String(port), ALPHACODE_HOST: '127.0.0.1', ALPHACODE_DATA_DIR: path.join(DIST, 'data-test'), ALPHACODE_MOCK: '1' },
    stdio: ['ignore', out, out],
  });
  try {
    let res = null;
    for (let i = 0; i < 60; i++) {
      try {
        res = await fetch(`http://127.0.0.1:${port}/`);
        if (res.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(res?.ok, 'dist server did not become healthy');
    const html = await res.text();
    assert.match(html, /AlphaCode/);
    const assetPath = html.match(/src="(\/assets\/app\.[0-9a-f]{8}\.js)"/)[1];
    const asset = await fetch(`http://127.0.0.1:${port}${assetPath}`);
    assert.equal(asset.status, 200, 'hashed entry script must be servable');
    assert.match(asset.headers.get('content-type') || '', /javascript/);
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(health.ok, true);
  } finally {
    child.kill('SIGKILL');
    fs.closeSync(out);
    fs.rmSync(logFile, { force: true });
  }
});

test('obfuscated build keeps the module graph intact', () => {
  build(['--obfuscate']);
  const html = readIndex();
  const assets = fs.readdirSync(path.join(DIST, 'public', 'assets'));
  const appFile = assets.find((f) => f.startsWith('app.') && f.endsWith('.js'));
  const code = fs.readFileSync(path.join(DIST, 'public', 'assets', appFile), 'utf8');
  const imports = [...code.matchAll(/["'](\.\/[a-z]+\.[0-9a-f]{8}\.js)["']/g)].map((m) => m[1].replace('./', ''));
  assert.ok(imports.length >= 2, 'obfuscation must not drop module imports');
  for (const dep of imports) assert.ok(assets.includes(dep), `missing ${dep}`);
  assert.match(html, /integrity="sha384-/, 'SRI survives obfuscation');
});

/**
 * WebContainer dependency cache + the router-health probe.
 *
 * Both are "make the second visit better" features, so the tests are about the
 * two ways they can go wrong: caching something that no longer matches the
 * manifest, and reporting a router as healthy when it is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectFingerprint,
  hashText,
  isCacheable,
  snapshotModules,
  saveContainerCache,
  loadContainerCache,
  CACHE_VERSION,
  DEFAULT_MAX_FILES,
} from '../web/engine/node/container-cache.js';
import { probeModels, describeProbe } from '../web/engine/agent/catalog.js';

const manifest = { 'package.json': '{"name":"app","dependencies":{"vite":"^5"}}' };

test('the fingerprint follows the manifest and nothing else', () => {
  const base = projectFingerprint(manifest);
  assert.match(base, new RegExp(`^${CACHE_VERSION}-[0-9a-f]{8}$`));
  // A source edit must not invalidate an install.
  assert.equal(projectFingerprint({ ...manifest, 'src/main.js': 'export {}' }), base);
  // A dependency edit must.
  assert.notEqual(projectFingerprint({ 'package.json': '{"dependencies":{"vite":"^6"}}' }), base);
  // A lockfile is part of the manifest set.
  assert.notEqual(projectFingerprint({ ...manifest, 'package-lock.json': '{"lockfileVersion":3}' }), base);
});

test('a project with no manifest is never cached', () => {
  assert.equal(projectFingerprint({ 'index.html': '<h1>x</h1>' }), '');
  assert.equal(projectFingerprint(), '');
});

test('the hash is stable and differs for different input', () => {
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('abd'));
  assert.match(hashText(''), /^[0-9a-f]{8}$/);
});

test('the cache refuses snapshots that would be worse than reinstalling', () => {
  assert.equal(isCacheable({ fileCount: 10, bytes: 1000 }), true);
  assert.equal(isCacheable({ fileCount: 0 }), false);
  assert.equal(isCacheable({ fileCount: DEFAULT_MAX_FILES + 1, bytes: 10 }), false);
  assert.equal(isCacheable({ fileCount: 2, bytes: 25 * 1024 * 1024 }), false);
});

/** A minimal container whose fs behaves like the SDK's. */
function fakeContainer(tree) {
  return {
    fs: {
      async readdir(dir) {
        const node = tree[dir];
        if (!node) throw new Error(`ENOENT ${dir}`);
        return Object.entries(node).map(([name, value]) => ({
          name,
          isDirectory: () => value && typeof value === 'object',
        }));
      },
      async readFile(path) {
        const value = lookup(tree, path);
        if (typeof value !== 'string') throw new Error(`EISDIR ${path}`);
        return value;
      },
    },
  };
}

function lookup(tree, path) {
  const parts = path.replace(/^\//, '').split('/');
  let node = tree[`/${parts[0]}`] || tree['/'];
  for (const part of parts.slice(1)) node = node?.[part];
  return node;
}

test('only text files are snapshotted, and the paths stay relative', async () => {
  const container = fakeContainer({
    '/node_modules': { dep: { 'index.js': 'module.exports = 1' }, 'binary.wasm': '\u0000asm' },
    '/node_modules/dep': { 'index.js': 'module.exports = 1' },
  });
  const snapshot = await snapshotModules(container);
  assert.equal(snapshot.files['node_modules/dep/index.js'], 'module.exports = 1');
  assert.equal('node_modules/binary.wasm' in snapshot.files, false, 'binary entries are skipped');
  assert.equal(snapshot.truncated, false);
});

test('a huge install is truncated rather than allowed to eat the quota', async () => {
  const container = fakeContainer({
    '/node_modules': { big: { 'a.js': 'x'.repeat(600) } },
    '/node_modules/big': { 'a.js': 'x'.repeat(600) },
  });
  const snapshot = await snapshotModules(container, { maxBytes: 100 });
  assert.equal(snapshot.truncated, true);
});

test('an unreadable container yields an empty snapshot, never a throw', async () => {
  const snapshot = await snapshotModules({ fs: { readdir: async () => { throw new Error('gone'); } } });
  assert.deepEqual(snapshot, { files: {}, bytes: 0, truncated: false });
});

test('without OPFS the cache is a no-op in both directions', async () => {
  // Node has no navigator.storage, which is the same situation as a hardened
  // browser: the feature must degrade to "install normally".
  assert.equal(await loadContainerCache('1-abc'), null);
  const saved = await saveContainerCache('1-abc', { files: { 'node_modules/x/index.js': 'x' }, bytes: 1 });
  assert.equal(saved.saved, false);
  assert.ok(saved.reason);
  assert.equal(await saveContainerCache('', { files: {} }).then((r) => r.saved), false);
});

/* ------------------------------------------------------- router health -- */

const ok = (models) => async () => ({ ok: true, status: 200, json: async () => ({ data: models }) });

test('a reachable router is reported live with its model count', async () => {
  const probe = await probeModels([{ id: 'kilo', baseUrl: 'https://api.kilo.ai/api/gateway' }], {
    fetchImpl: ok([{ id: 'kilo-auto/free' }, { id: 'x:free' }]),
  });
  assert.equal(probe.state, 'live');
  assert.equal(probe.liveCount, 2);
  assert.deepEqual(describeProbe(probe).tone, 'ok');
  assert.match(describeProbe(probe).label, /kilo/);
});

test('a blocked router says so instead of waiting for a failed prompt', async () => {
  const probe = await probeModels([{ id: 'kilo', baseUrl: 'https://api.kilo.ai/api/gateway' }], {
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.equal(probe.state, 'blocked');
  const report = describeProbe(probe);
  assert.equal(report.tone, 'err');
  assert.match(report.label, /offline/i);
  assert.match(report.detail, /kilo/);
});

test('answering only through the relay is a warning, not a failure', async () => {
  const probe = await probeModels([{ id: 'kilo', baseUrl: 'https://api.kilo.ai/api/gateway' }], {
    fetchImpl: async (url) => {
      if (String(url).includes('kilo.ai')) throw new TypeError('blocked');
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'kilo-auto/free' }] }) };
    },
  });
  assert.equal(probe.state, 'relay');
  assert.equal(describeProbe(probe).tone, 'warn');
  assert.match(describeProbe(probe).label, /relay/);
});

test('one live router among several is enough', async () => {
  const probe = await probeModels(
    [
      { id: 'kilo', baseUrl: 'https://api.kilo.ai/api/gateway' },
      { id: 'opencode', baseUrl: 'https://opencode.ai/zen/v1' },
    ],
    {
      fetchImpl: async (url) => {
        // Kilo is down both directly and through its relay; OpenCode answers.
        if (String(url).includes('kilo')) throw new TypeError('blocked');
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'big-pickle' }] }) };
      },
    },
  );
  assert.equal(probe.state, 'live');
  assert.equal(probe.providers.filter((row) => !row.ok).length, 1);
});

test('an empty probe is "unknown", not "healthy"', async () => {
  const probe = await probeModels([]);
  assert.equal(probe.state, 'unknown');
  assert.equal(describeProbe(probe).tone, 'warn');
  assert.equal(describeProbe(null).label, 'router unknown');
});

/**
 * In-browser native compilers (C, C++, Rust) and the WebContainers sandbox.
 *
 * Neither of these can be *executed* in CI — one downloads a WASIX toolchain
 * from a registry, the other needs a cross-origin-isolated Chromium. What is
 * testable, and what this file covers, is the contract around them:
 *
 *   • the switch gates everything, and the error explains how to fix it;
 *   • a compile endpoint is always preferred and its output is validated;
 *   • the file→tree conversion the container mount needs;
 *   • the diagnosis a Safari user gets instead of a hang.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileNative,
  compileWithEndpoint,
  toolchainStatus,
  languageFor,
  toolchainsEnabled,
  ToolchainError,
  TOOLCHAINS,
} from '../web/engine/wasm-toolchains.js';
import {
  toFileTree,
  readTree,
  webcontainerDiagnosis,
  webcontainerSupported,
  inspectSandbox,
  setIsolationCookie,
  ISOLATION_COOKIE,
  WEBCONTAINER_VERSION,
  bootWebContainer,
  SandboxUnavailable,
} from '../web/engine/node/webcontainer.js';

const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/* ------------------------------------------------------------- compilers -- */

test('languages are inferred from the file extension', () => {
  assert.equal(languageFor('main.c'), 'c');
  assert.equal(languageFor('src/main.cpp'), 'cpp');
  assert.equal(languageFor('lib/x.cc'), 'cpp');
  assert.equal(languageFor('src/main.rs'), 'rust');
  assert.equal(languageFor('index.html'), '');
  assert.equal(languageFor(''), '');
});

test('the toolchain switch is off by default', () => {
  assert.equal(toolchainsEnabled({}), false);
  assert.equal(toolchainsEnabled({ wasmCompilers: false }), false);
  assert.equal(toolchainsEnabled({ wasmCompilers: true }), true);
  assert.deepEqual(toolchainStatus({}).languages, []);
  assert.match(toolchainStatus({}).detail, /Off/);
  assert.deepEqual(toolchainStatus({ wasmCompilers: true }).languages.sort(), ['c', 'cpp', 'rust']);
  assert.match(toolchainStatus({ cCompilerEndpoint: 'https://c.example/compile' }).detail, /endpoint/);
});

test('every language has an image or a documented fallback', () => {
  for (const [language, spec] of Object.entries(TOOLCHAINS)) {
    assert.ok(spec.image, `${language} needs a registry image`);
    assert.equal(typeof spec.args, 'function');
    const args = spec.args('main.x', 'out.wasm');
    assert.ok(args.includes('out.wasm'), `${language} command writes the output file`);
  }
});

test('a compile endpoint is used when configured, even with the switch off', async () => {
  let seen;
  const result = await withFetch(
    async (url, init) => {
      seen = { url: String(url), body: JSON.parse(init.body) };
      return new Response(WASM_MAGIC, { status: 200 });
    },
    () => compileNative({ source: 'int main(){return 0;}', language: 'c', filename: 'main.c', settings: { cCompilerEndpoint: 'https://c.example/compile' } }),
  );
  assert.equal(seen.url, 'https://c.example/compile');
  assert.equal(seen.body.language, 'c');
  assert.equal(seen.body.target, 'wasm32-wasi');
  assert.equal(result.backend, 'endpoint');
  assert.equal(result.wasm[0], 0x00);
});

test('an endpoint that answers with HTML is rejected', async () => {
  await assert.rejects(
    () =>
      withFetch(
        async () => new Response('<html>nope</html>', { status: 200 }),
        () => compileWithEndpoint({ endpoint: 'https://c.example/compile', language: 'c', source: 'x', filename: 'main.c' }),
      ),
    (err) => err instanceof ToolchainError && /did not return a wasm module/.test(err.message),
  );
});

test('an endpoint failure carries the status', async () => {
  await assert.rejects(
    () =>
      withFetch(
        async () => new Response('{}', { status: 500 }),
        () => compileWithEndpoint({ endpoint: 'https://c.example/compile', language: 'rust', source: 'x', filename: 'main.rs' }),
      ),
    (err) => err instanceof ToolchainError && /500/.test(err.message),
  );
});

test('with no endpoint and the switch off, the error explains both fixes', async () => {
  await assert.rejects(
    () => compileNative({ source: 'int main(){}', language: 'c', filename: 'main.c', settings: {} }),
    (err) => err instanceof ToolchainError && /switched off/.test(err.message) && /Settings → Runtimes/.test(err.hint),
  );
});

/* ---------------------------------------------------------- webcontainer -- */

test('a flat project becomes the nested tree the mount API wants', () => {
  const tree = toFileTree({
    'index.html': '<h1>hi</h1>',
    'src/main.js': 'console.log(1)',
    'src/lib/util.js': 'export {}',
    'node_modules/x/index.js': 'should not be mounted',
    '.git/config': 'nope',
    'logo.png': new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual(tree['index.html'], { file: { contents: '<h1>hi</h1>' } });
  assert.deepEqual(Object.keys(tree.src.directory), ['main.js', 'lib']);
  assert.deepEqual(Object.keys(tree.src.directory.lib.directory), ['util.js']);
  assert.equal(tree.node_modules, undefined, 'node_modules stays inside the container');
  assert.equal(tree['.git'], undefined);
  assert.equal(tree['logo.png'], undefined, 'binary files are not sent as text');
});

test('an empty project mounts an empty tree, not a crash', () => {
  assert.deepEqual(toFileTree({}), {});
  assert.deepEqual(toFileTree(), {});
});

test('readTree flattens what the container wrote, skipping the usual noise', async () => {
  const files = {
    '/package.json': '{"name":"app"}',
    '/src/index.js': 'export default 1',
    '/node_modules/x/index.js': 'skip me',
    '/.git/HEAD': 'skip me',
  };
  const directories = { '/': ['package.json', 'src', 'node_modules', '.git'], '/src': ['index.js'] };
  const container = {
    fs: {
      readdir: async (dir) => {
        if (dir === '/node_modules') return [{ name: 'x', isDirectory: () => true }];
        if (dir === '/node_modules/x') return [{ name: 'index.js', isDirectory: () => false }];
        if (dir === '/.git') return [{ name: 'HEAD', isDirectory: () => false }];
        return (directories[dir] || []).map((name) => ({ name, isDirectory: () => name === 'src' }));
      },
      readFile: async (path) => {
        if (!(path in files)) throw new Error('ENOENT');
        return files[path];
      },
    },
  };
  const out = await readTree(container, '/');
  assert.deepEqual(out, { 'package.json': '{"name":"app"}', 'src/index.js': 'export default 1' });
});

test('readTree tolerates a container that cannot list a directory', async () => {
  const out = await readTree({ fs: { readdir: async () => { throw new Error('gone'); }, readFile: async () => '' } }, '/');
  assert.deepEqual(out, {});
});

test('the sandbox diagnosis is explicit outside a browser', () => {
  // Node has no `window`, so this is the "cannot run here" branch — which must
  // be a sentence, never a throw.
  assert.equal(webcontainerSupported(), false);
  const diagnosis = webcontainerDiagnosis();
  assert.equal(diagnosis.ok, false);
  assert.ok(diagnosis.reason.length > 4);
});

/* ------------------------------------------------- sandbox preflight -- */

/** A fake window with the flags the SDK reads. */
function fakeWindow({ isolated = true, sab = true, ua = 'Mozilla/5.0 (Macintosh) Chrome/141.0 Safari/537.36', framed = false, secure = true } = {}) {
  const win = {
    crossOriginIsolated: isolated,
    isSecureContext: secure,
    navigator: { userAgent: ua },
    location: { href: 'https://alphacode.example/app' },
    self: {},
  };
  win.top = framed ? {} : win.self;
  if (sab) win.SharedArrayBuffer = function SharedArrayBuffer() {};
  return win;
}

const headers = (map) => async () => ({ headers: { get: (name) => map[name.toLowerCase()] || null } });

test('a fully isolated Chromium tab passes every sandbox check', async () => {
  const report = await inspectSandbox({
    win: fakeWindow(),
    fetchImpl: headers({ 'cross-origin-embedder-policy': 'credentialless', 'cross-origin-opener-policy': 'same-origin' }),
  });
  assert.equal(report.ok, true, report.hint);
  assert.equal(report.coep, 'credentialless');
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.checks.map((c) => c.id), ['sdk', 'secure', 'sab', 'browser', 'coop', 'coep', 'isolated']);
});

test('a page without the isolation headers names both missing headers', async () => {
  const report = await inspectSandbox({
    win: fakeWindow({ isolated: false }),
    fetchImpl: headers({ 'cross-origin-opener-policy': 'same-origin-allow-popups' }),
  });
  assert.equal(report.ok, false);
  const failed = report.blockers.map((b) => b.id);
  assert.deepEqual(failed, ['coop', 'coep', 'isolated']);
  assert.match(report.hint, /Node sandbox/);
});

test('the boot is disabled with a reason for Safari', async () => {
  const report = await inspectSandbox({
    win: fakeWindow({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Version/18.0 Safari/605.1.15' }),
    fetchImpl: headers({ 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-opener-policy': 'same-origin' }),
  });
  assert.equal(report.ok, false);
  assert.ok(report.blockers.some((b) => b.id === 'browser'));
  assert.match(report.blockers.find((b) => b.id === 'browser').detail, /Safari/);
});

test('require-corp is accepted, and reported so boot can match it', async () => {
  const report = await inspectSandbox({
    win: fakeWindow(),
    fetchImpl: headers({ 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-opener-policy': 'same-origin' }),
  });
  assert.equal(report.ok, true);
  assert.equal(report.coep, 'require-corp');
});

test('an embedded tab that is not isolated is told to open its own tab', async () => {
  const report = await inspectSandbox({
    win: fakeWindow({ isolated: false, framed: true }),
    fetchImpl: headers({ 'cross-origin-opener-policy': 'same-origin-allow-popups' }),
  });
  assert.equal(report.framed, true);
  assert.equal(report.isolated, false);
  assert.match(report.hint, /own (browser )?tab/);
});

test('an unreachable header probe still reaches a verdict', async () => {
  const report = await inspectSandbox({
    win: fakeWindow(),
    fetchImpl: async () => {
      throw new TypeError('offline');
    },
  });
  assert.equal(report.ok, true, 'the crossOriginIsolated flag is the source of truth');
  assert.equal(report.coep, '');
});

test('the switch writes the cookie the middleware reads', () => {
  const doc = { cookie: '' };
  setIsolationCookie(true, doc);
  assert.match(doc.cookie, new RegExp(`^${ISOLATION_COOKIE}=1;`));
  setIsolationCookie(false, doc);
  assert.match(doc.cookie, new RegExp(`^${ISOLATION_COOKIE}=;`));
});

test('the SDK version is pinned', () => {
  assert.match(WEBCONTAINER_VERSION, /^\d+\.\d+\.\d+$/);
});

test('booting in a tab that is not isolated fails with the blockers, not an SDK stack', async () => {
  const inspect = await inspectSandbox({
    win: fakeWindow({ isolated: false }),
    fetchImpl: headers({ 'cross-origin-opener-policy': 'same-origin-allow-popups' }),
  });
  await assert.rejects(
    () => bootWebContainer({ files: { 'index.html': 'hi' }, inspect }),
    (err) => {
      assert.ok(err instanceof SandboxUnavailable);
      assert.match(err.message, /Cross-Origin-Embedder-Policy/);
      assert.ok(err.blockers.length >= 2);
      assert.match(err.hint, /Settings → Runtimes/);
      return true;
    },
  );
});

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
import { toFileTree, readTree, webcontainerDiagnosis, webcontainerSupported } from '../web/engine/node/webcontainer.js';

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

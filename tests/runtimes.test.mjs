/**
 * The runtimes that make AlphaCode a real environment rather than a mock:
 * the Node engine (CJS + ESM + node_modules), npm install through the edge
 * contract, background jobs, hooks, MCP over HTTP, and the WASI runner.
 *
 * Everything here runs with no network: the npm registry and the MCP server are
 * stubs shaped exactly like the real responses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'fflate';

const { esmToCjs, findModuleStatements, looksEsm } = await import('../web/engine/node/transform.js');
const { NodeRuntime } = await import('../web/engine/node/runtime.js');
const { NodeFS, fromBytes } = await import('../web/engine/node/vfs.js');
const { NodeSession } = await import('../web/engine/node/session.js');
const { untar, install, resolvePlan } = await import('../web/engine/node/npm.js');
const { FileSystem, MemoryFs } = await import('../web/engine/fs.js');
const { normalizeHooks, runHooks } = await import('../web/engine/hooks.js');
const { JobManager } = await import('../web/engine/jobs.js');
const { McpClient, connectAll, contentToText } = await import('../web/engine/mcp.js');
const { runWasi } = await import('../web/engine/native.js');
const { satisfies, maxSatisfying } = await import('../web/engine/semver.js');

/* --------------------------------------------------------------- helpers -- */

/** Build a real ustar archive, so `untar` is tested against real bytes. */
function tar(files) {
  const blocks = [];
  const encoder = new TextEncoder();
  for (const [path, content] of Object.entries(files)) {
    const data = encoder.encode(content);
    const header = new Uint8Array(512);
    const write = (text, offset, length) => header.set(encoder.encode(text).subarray(0, length), offset);
    write(path, 0, 100);
    write('0000644\0', 100, 8);
    write('0000000\0', 108, 8);
    write('0000000\0', 116, 8);
    write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    write('00000000000\0', 136, 12);
    write('        ', 148, 8);
    write('0', 156, 1);
    write('ustar\0', 257, 6);
    write('00', 263, 2);
    header.fill(32, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

const packument = (name, version, extra = {}) => ({
  name,
  'dist-tags': { latest: version },
  versions: {
    [version]: {
      name,
      version,
      main: 'index.js',
      dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` },
      ...extra,
    },
  },
});

/* ------------------------------------------------------------- transform -- */

test('ESM is rewritten to CommonJS without touching strings or templates', () => {
  const source = `import pad from 'left-pad';
import { a as b } from './lib.js';
const text = "import this is data";
const tpl = \`export \${text}\`;
export const one = 1, two = 2;
export function hi() { return pad('x', 3); }
export default class Thing {}
`;
  const { code, esm, exportsList } = esmToCjs(source, { filename: 'app.js' });
  assert.equal(esm, true);
  assert.match(code, /__require\("left-pad"\)/);
  assert.match(code, /const b = __mod1__esm\["a"\]/);
  assert.match(code, /const text = "import this is data"/);
  assert.match(code, /__exports\["one"\] = one/);
  assert.match(code, /__exports\.default = Thing/);
  assert.deepEqual(exportsList.sort(), ['default', 'hi', 'one', 'two'].sort());
  assert.equal(findModuleStatements(source).length, 5);
  assert.equal(looksEsm(source), true);
  assert.equal(looksEsm('const x = 1; // import\n'), false);
});

/* ---------------------------------------------------------------- node.js -- */

const projectFiles = {
  'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', type: 'commonjs' }),
  'index.js': `const { add } = require('./lib/math');
const path = require('path');
const fs = require('fs');
console.log('sum', add(2, 3));
console.log('join', path.join('a', 'b', '..', 'c'));
fs.writeFileSync('out.txt', 'hello from node');
console.log(fs.readFileSync('out.txt', 'utf8'));
console.log('env', process.env.MODE);
`,
  'lib/math.js': `exports.add = (a, b) => a + b;`,
  'esm-app.mjs': `import math from './lib/math.js';
import zlib from 'zlib';
const packed = zlib.gzipSync(Buffer.from('roundtrip'));
console.log('zlib', zlib.gunzipSync(packed).toString());
export const value = 42;
`,
  'crypto-test.js': `const crypto = require('crypto');
console.log(crypto.createHash('sha256').update('abc').digest('hex'));
console.log(crypto.createHash('md5').update('abc').digest('hex'));
`,
};

test('the Node runtime runs CommonJS with real fs, path and process', () => {
  const fs = new NodeFS({ cwd: '/app' });
  fs.hydrate(projectFiles);
  const lines = [];
  const runtime = new NodeRuntime({ fs, onStdout: (t) => lines.push(t), onStderr: (t) => lines.push(t), env: { MODE: 'test' } });
  runtime.run('index.js');
  const output = lines.join('');
  assert.match(output, /sum 5/);
  assert.match(output, /join a\/c/);
  assert.match(output, /hello from node/);
  assert.match(output, /env test/);
  assert.deepEqual(fs.pendingWrites(), ['/app/out.txt']);
});

test('the Node runtime handles ESM, Buffer and zlib', () => {
  const fs = new NodeFS({ cwd: '/app' });
  fs.hydrate(projectFiles);
  const lines = [];
  const runtime = new NodeRuntime({ fs, onStdout: (t) => lines.push(t), onStderr: (t) => lines.push(t) });
  runtime.run('esm-app.mjs');
  assert.match(lines.join(''), /zlib roundtrip/);
});

test('digests match the reference vectors', () => {
  const fs = new NodeFS({ cwd: '/app' });
  fs.hydrate(projectFiles);
  const lines = [];
  const runtime = new NodeRuntime({ fs, onStdout: (t) => lines.push(t), onStderr: (t) => lines.push(t) });
  runtime.run('crypto-test.js');
  const output = lines.join('').trim().split('\n');
  assert.equal(output[0], 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(output[1], '900150983cd24fb0d6963f7d28e17f72');
});

test('bare specifiers resolve through node_modules with exports maps', () => {
  const fs = new NodeFS({ cwd: '/app' });
  fs.hydrate({
    'package.json': JSON.stringify({ name: 'x' }),
    'index.js': `const lib = require('fancy');
const sub = require('fancy/extra');
const data = require('./data.json');
console.log(lib.hello(), sub, data.n);
`,
    'data.json': JSON.stringify({ n: 7 }),
    'node_modules/fancy/package.json': JSON.stringify({
      name: 'fancy',
      version: '1.0.0',
      exports: { '.': { browser: './browser.js', default: './node.js' }, './extra': './extra.js' },
    }),
    'node_modules/fancy/browser.js': `module.exports = { hello: () => 'from-browser-build' };`,
    'node_modules/fancy/node.js': `module.exports = { hello: () => 'from-node-build' };`,
    'node_modules/fancy/extra.js': `module.exports = 'extra-ok';`,
  });
  const lines = [];
  const runtime = new NodeRuntime({ fs, onStdout: (t) => lines.push(t), onStderr: (t) => lines.push(t) });
  runtime.run('index.js');
  const output = lines.join('');
  assert.match(output, /from-browser-build/);
  assert.match(output, /extra-ok/);
  assert.match(output, /7/);
});

test('a missing package produces an actionable MODULE_NOT_FOUND', () => {
  const fs = new NodeFS({ cwd: '/app' });
  fs.hydrate({ 'index.js': `require('not-installed');` });
  const runtime = new NodeRuntime({ fs, onStdout() {}, onStderr() {} });
  assert.throws(
    () => runtime.run('index.js'),
    (err) => /Cannot find module 'not-installed'/.test(err.message) && /npm install not-installed/.test(err.message),
  );
});

/* ------------------------------------------------------------------- npm -- */

test('untar reads a real ustar archive', () => {
  const archive = tar({ 'package/index.js': 'module.exports = 1;', 'package/package.json': '{"name":"p"}' });
  const files = untar(archive);
  assert.deepEqual(files.map((f) => f.path).sort(), ['package/index.js', 'package/package.json']);
  assert.equal(fromBytes(files.find((f) => f.path === 'package/index.js').data), 'module.exports = 1;');
});

test('npm install resolves, downloads and extracts into node_modules', async () => {
  const tarball = gzipSync(tar({
    'package/package.json': JSON.stringify({ name: 'fake-pkg', version: '1.2.3', main: 'index.js' }),
    'package/index.js': 'module.exports = { greet: () => "hello from fake-pkg" };',
  }));
  const registry = {
    'fake-pkg': packument('fake-pkg', '1.2.3', { dependencies: { 'fake-dep': '^2.0.0' } }),
    'fake-dep': packument('fake-dep', '2.1.0'),
  };
  const depTarball = gzipSync(tar({
    'package/package.json': JSON.stringify({ name: 'fake-dep', version: '2.1.0', main: 'index.js' }),
    'package/index.js': 'module.exports = "dep";',
  }));

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url.url || url);
    calls.push(target);
    if (target.endsWith('/api/npm/resolve')) {
      const body = JSON.parse(options.body);
      const plan = {
        packages: {
          'fake-pkg@1.2.3': { name: 'fake-pkg', version: '1.2.3', resolved: 'https://registry.npmjs.org/fake-pkg/-/fake-pkg-1.2.3.tgz', dependencies: { 'fake-dep': '^2.0.0' } },
          'fake-dep@2.1.0': { name: 'fake-dep', version: '2.1.0', resolved: 'https://registry.npmjs.org/fake-dep/-/fake-dep-2.1.0.tgz', dependencies: {} },
        },
        order: Object.keys(plan_packages(body)),
        warnings: [],
        cached: false,
        source: 'edge',
      };
      return new Response(JSON.stringify(plan), { headers: { 'Content-Type': 'application/json' } });
    }
    if (target.includes('fake-dep-2.1.0.tgz')) return new Response(depTarball);
    if (target.includes('fake-pkg-1.2.3.tgz')) return new Response(tarball);
    return new Response('{}', { status: 404 });
  };
  function plan_packages() {
    return { a: 1, b: 1 };
  }

  try {
    const fs = new NodeFS({ cwd: '/app' });
    fs.hydrate({ 'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: {} }) });
    const result = await install({
      packageJson: { name: 'demo', version: '1.0.0', dependencies: {} },
      add: ['fake-pkg'],
      edge: '/api/npm',
      onLog: () => {},
    });
    assert.equal(result.installed.length, 2);
    assert.equal(result.warnings.length, 0);
    assert.ok(result.packageJson.dependencies['fake-pkg']);
    assert.ok(result.lock.packages['']);
    assert.ok(calls.some((c) => c.includes('/api/npm/resolve')));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('client-side resolution falls back to the registry when the edge is absent', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url.url || url);
    if (target.includes('/api/npm/resolve')) return new Response('nope', { status: 404 });
    if (target.includes('registry.npmjs.org/lodash')) return new Response(JSON.stringify(packument('lodash', '4.17.21')));
    return new Response('{}', { status: 404 });
  };
  try {
    const plan = await resolvePlan({ lodash: '^4.17.0' }, { edge: '/api/npm' });
    assert.equal(plan.source, 'client');
    assert.ok(plan.packages['lodash@4.17.21']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a NodeSession hydrates a project, runs it, and flushes changes back', async () => {
  const fs = new FileSystem(new MemoryFs());
  await fs.write('p1', 'package.json', JSON.stringify({ name: 'demo', dependencies: {} }));
  await fs.write('p1', 'index.js', `require('fs').writeFileSync('made.txt', 'from the runtime');\nconsole.log('ran');\n`);
  const logs = [];
  const session = new NodeSession({ fs, projectId: 'p1', onStdout: (t) => logs.push(t) });
  const result = await session.runFile('index.js');
  assert.equal(result.code, 0);
  assert.match(logs.join(''), /ran/);
  assert.equal(await fs.readText('p1', 'made.txt'), 'from the runtime');
});

test('a NodeSession picks up files written after it started', async () => {
  const fs = new FileSystem(new MemoryFs());
  await fs.write('p2', 'package.json', JSON.stringify({ name: 'late' }));
  const logs = [];
  const session = new NodeSession({ fs, projectId: 'p2', onStdout: (t) => logs.push(t) });
  await session.hydrate();
  // the agent writes a file *after* the runtime was created
  await fs.write('p2', 'late.js', `console.log('picked up');`);
  const result = await session.runFile('late.js');
  assert.equal(result.code, 0);
  assert.match(logs.join(''), /picked up/);
});

/* ---------------------------------------------------------------- hooks --- */

test('hooks can block, rewrite arguments and annotate results', async () => {
  const hooks = normalizeHooks({
    pre_tool: [
      { match: 'bash', run: (ctx) => (/rm -rf/.test(ctx.args.command) ? { block: 'destructive' } : null) },
      { match: 'write', run: (ctx) => ({ args: { file_path: ctx.args.file_path, content: `${ctx.args.content}\n// formatted` } }) },
    ],
    post_tool: [{ match: 'write', run: () => ({ note: 'saved by hook' }) }],
  });
  const blocked = await runHooks(hooks, 'pre_tool', { tool: 'bash', args: { command: 'rm -rf /' } });
  assert.equal(blocked.blocked, 'destructive');

  const rewritten = await runHooks(hooks, 'pre_tool', { tool: 'write', args: { file_path: 'a.js', content: 'x' } });
  assert.match(rewritten.args.content, /formatted/);

  const annotated = await runHooks(hooks, 'post_tool', { tool: 'write', args: {} });
  assert.equal(annotated.note, 'saved by hook');

  const wildcard = normalizeHooks({ pre_run: [{ match: '*', run: () => ({ approve: true }) }] });
  assert.equal((await runHooks(wildcard, 'pre_run', { tool: 'x' })).approve, true);
});

/* ----------------------------------------------------------------- jobs --- */

test('background jobs stream output, keep a log, and can be killed', async () => {
  const workers = [];
  const manager = new JobManager({
    spawnWorker: () => {
      const worker = {
        onmessage: null,
        onerror: null,
        posted: null,
        terminated: false,
        postMessage(message) {
          this.posted = message;
          queueMicrotask(() => {
            this.onmessage({ data: { type: 'stdout', text: 'server listening on 3000\n' } });
            if (message.file === 'crash.js') this.onmessage({ data: { type: 'exit', code: 1, files: [] } });
          });
        },
        terminate() {
          this.terminated = true;
        },
      };
      workers.push(worker);
      return worker;
    },
    writeFile: async () => {},
  });

  const job = manager.start({ command: 'node server.js', file: 'server.js' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(job.status, 'running');
  assert.match(job.log, /listening/);
  assert.match(manager.render(), /server\.js/);
  assert.equal(manager.kill(job.id), true);
  assert.equal(job.status, 'killed');
  assert.equal(workers[0].terminated, true);

  const crashed = manager.start({ command: 'node crash.js', file: 'crash.js' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(crashed.status, 'failed');
  assert.equal(crashed.exitCode, 1);
});

/* ------------------------------------------------------------------ MCP --- */

test('MCP over HTTP: handshake, namespaced tools, calls and content flattening', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    seen.push(body);
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'Content-Type': 'application/json' } });
    if (body.method === 'initialize') return reply({ serverInfo: { name: 'gemini-mcp', version: '1.0.0' }, capabilities: { tools: {} } });
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (body.method === 'tools/list') {
      return reply({
        tools: [
          { name: 'search', description: 'Search the web', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
          { name: 'fetch', description: 'Fetch a URL', inputSchema: { type: 'object', properties: {} } },
        ],
      });
    }
    if (body.method === 'tools/call') {
      return reply({ content: [{ type: 'text', text: `result for ${body.params.arguments.q}` }] });
    }
    return reply({});
  };
  try {
    const client = new McpClient({ name: 'gemini', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer test' } });
    await client.connect();
    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['mcp__gemini__search', 'mcp__gemini__fetch']);
    const result = await client.callTool('search', { q: 'alpha' });
    assert.equal(contentToText(result.content), 'result for alpha');
    assert.ok(seen.some((m) => m.method === 'notifications/initialized'));

    const { clients, errors } = await connectAll([{ name: 'gemini', url: 'https://mcp.example.com/mcp' }]);
    assert.equal(clients.length, 1);
    assert.equal(errors.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a blocked MCP server is reported, not thrown', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  try {
    const { clients, errors } = await connectAll([{ name: 'blocked', url: 'https://mcp.example.com/mcp' }]);
    assert.equal(clients.length, 0);
    assert.match(errors[0].error, /CORS|relay|Failed to fetch/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ----------------------------------------------------------------- WASI --- */

test('the WASI runner executes a wasm module and honours proc_exit', async () => {
  // (module (memory (export "memory") 1) (func (export "_start")))
  const wasm = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00, //                    type: () -> ()
    0x03, 0x02, 0x01, 0x00, //                                func: one, type 0
    0x05, 0x03, 0x01, 0x00, 0x01, //                          memory: 1 page
    0x07, 0x13, 0x02, //                                      exports: 2
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, //   "memory" → memory 0
    0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00, //   "_start" → func 0
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b, //                    code: empty body
  ]);
  const result = await runWasi(wasm, { args: ['hello'] });
  assert.equal(result.code, 0);
  assert.ok(result.memoryPages >= 1);
});

/* ---------------------------------------------------------------- semver -- */

test('semver covers the ranges npm actually uses', () => {
  const cases = [
    ['1.2.3', '^1.0.0', true],
    ['2.0.0', '^1.0.0', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['1.3.0', '~1.2.0', false],
    ['1.2.9', '~1.2.0', true],
    ['3.1.0', '1.x || 3.x', true],
    ['1.0.0-beta', '^1.0.0', false],
    ['1.0.0-beta', '^1.0.0-beta', true],
    ['1.5.0', '>=1.0.0 <2', true],
    ['2.0.0', '1.2.3 - 2.0.0', true],
    ['2.0.1', '1.2.3 - 2.0.0', false],
  ];
  for (const [version, range, expected] of cases) {
    assert.equal(satisfies(version, range), expected, `${version} ${range}`);
  }
  assert.equal(maxSatisfying(['1.0.0', '1.9.9', '2.0.0'], '^1'), '1.9.9');
});

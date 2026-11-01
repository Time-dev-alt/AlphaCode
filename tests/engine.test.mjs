/**
 * Client engine tests — the parts that must work with no server at all:
 * store, filesystem, shell, SQLite, zip, provider plumbing and a full agent
 * turn that writes files, runs the shell and edits a database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { Store, MemoryBackend } = await import('../web/engine/store.js');
const { FileSystem, MemoryFs, IdbFs, globToRegExp, normPath, createFs, createFsAsync } = await import('../web/engine/fs.js');
const { Shell, parse, HELP } = await import('../web/engine/shell.js');
const { ProjectDatabase, splitStatements, rowsToObjects, openDatabase, loadEngine } = await import('../web/engine/db.js');
const { zipSync, crc32 } = await import('../web/engine/zip.js');
const { bundlePreview, importUrl, deployProject } = await import('../web/engine/deploy.js');
const { Harness } = await import('../web/engine/harness.js');
const { demoCompletion, planAttempts, modelForProvider, FREE_MODELS } = await import('../web/engine/providers.js');
const { buildTools, toolsForMode, toOpenAITools, unifiedDiff } = await import('../web/engine/tools.js');

const mkFs = () => new FileSystem(new MemoryFs());

/** Just enough IndexedDB for IdbFs: one store, sync ops, async tx completion. */
function installFakeIndexedDb() {
  const previous = globalThis.indexedDB;
  const tables = new Map();
  const request = (result) => {
    const req = { result, onsuccess: null, onerror: null };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  };
  const store = {
    put: (value, key) => (tables.set(key, value), request(key)),
    get: (key) => request(tables.has(key) ? structuredClone(tables.get(key)) : undefined),
    getAllKeys: () => request([...tables.keys()]),
    delete: (key) => (tables.delete(key), request(undefined)),
  };
  const db = {
    createObjectStore: () => store,
    transaction: () => {
      const tx = { objectStore: () => store, oncomplete: null, onerror: null, onabort: null, error: null };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
  globalThis.indexedDB = {
    open: () => {
      const req = { result: db, onsuccess: null, onupgradeneeded: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return () => {
    if (previous === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previous;
  };
}


/* ------------------------------------------------------------------ store -- */

test('store persists projects, threads, messages and settings', async () => {
  const store = new Store(new MemoryBackend());
  const { project, thread } = await store.createProject({ name: 'Demo' });
  assert.match(project.id, /^p_/);
  assert.equal((await store.projects())[0].name, 'Demo');
  await store.addMessage(thread.id, 'user', { text: 'hi' });
  await store.addMessage(thread.id, 'assistant', { text: 'hello' });
  const messages = await store.messages(thread.id);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
  assert.deepEqual(messages.map((m) => m.seq), [1, 2]);
  await store.saveSettings({ mode: 'plan', keys: { kilo: { key: 'k' } } });
  const settings = await store.settings();
  assert.equal(settings.mode, 'plan');
  assert.equal(settings.keys.kilo.key, 'k');
  await store.deleteProject(project.id);
  assert.equal((await store.projects()).length, 0);
  assert.equal((await store.messages(thread.id)).length, 0, 'messages cascade');
});

test('users are unique by email and store only hashes', async () => {
  const store = new Store(new MemoryBackend());
  const user = await store.createUser({ email: 'A@B.io', passwordHash: 'scrypt$…', salt: 's' });
  assert.equal(user.email, 'a@b.io');
  assert.ok(!('password' in user));
  assert.equal((await store.userByEmail('a@b.io')).id, user.id);
  assert.equal(await store.userByEmail('nobody@b.io'), null);
});

/* ------------------------------------------------------------- filesystem -- */

test('paths are normalised and cannot escape the project root', () => {
  assert.equal(normPath('/a/./b/../c.txt'), 'a/c.txt');
  assert.throws(() => normPath('../../etc/passwd'), /escapes/);
  assert.throws(() => normPath('a/../../x'), /escapes/);
});

test('filesystem writes, reads, lists, moves and deletes', async () => {
  const fsx = mkFs();
  await fsx.write('p1', 'index.html', '<h1>hi</h1>');
  await fsx.write('p1', 'src/app.js', 'console.log(1)');
  assert.equal(await fsx.readText('p1', 'index.html'), '<h1>hi</h1>');
  assert.equal((await fsx.list('p1')).length, 2);
  await fsx.move('p1', 'src/app.js', 'src/main.js');
  assert.deepEqual((await fsx.list('p1')).map((f) => f.path).sort(), ['index.html', 'src/main.js']);
  await fsx.remove('p1', 'src');
  assert.deepEqual((await fsx.list('p1')).map((f) => f.path), ['index.html']);
  assert.equal(await fsx.exists('p1', 'src/main.js'), false);
  await assert.rejects(() => fsx.readText('p1', 'nope.txt'), /ENOENT/);
});

test('projects are isolated from each other', async () => {
  const fsx = mkFs();
  await fsx.write('p1', 'a.txt', 'one');
  await fsx.write('p2', 'a.txt', 'two');
  assert.equal(await fsx.readText('p1', 'a.txt'), 'one');
  assert.equal(await fsx.readText('p2', 'a.txt'), 'two');
});

test('glob and grep behave like the server tools', async () => {
  const fsx = mkFs();
  await fsx.write('p', 'src/a.js', 'const alpha = 1;');
  await fsx.write('p', 'src/b.ts', 'const beta = 2;');
  await fsx.write('p', 'README.md', 'alpha docs');
  assert.deepEqual((await fsx.find('p', '**/*.js')).sort(), ['src/a.js']);
  assert.deepEqual((await fsx.find('p', 'src/*.{js,ts}')).sort(), ['src/a.js', 'src/b.ts']);
  const hits = await fsx.search('p', 'alpha');
  assert.deepEqual(hits.map((h) => h.path).sort(), ['README.md', 'src/a.js']);
  assert.equal(globToRegExp('*.md').test('docs/x.md'), false);
  assert.equal(globToRegExp('**/*.md').test('docs/x.md'), true);
});

test('createFs falls back to memory when OPFS is unavailable', () => {
  assert.equal(createFs().backend.constructor.name, 'MemoryFs');
});

test('createFsAsync only returns a backend it could actually write to', async () => {
  const fsx = await createFsAsync();
  await fsx.write('p1', 'a.txt', 'hello');
  assert.equal(await fsx.readText('p1', 'a.txt'), 'hello');
  assert.ok(['opfs', 'indexeddb', 'memory'].includes(fsx.mode));
});

test('the IndexedDB backend stores, lists, moves and deletes by path', async () => {
  const restore = installFakeIndexedDb();
  try {
    const fsx = await createFsAsync({ prefer: 'none' });
    assert.equal(fsx.mode, 'indexeddb');
    await fsx.write('p1', 'src/app.js', 'export const a = 1;');
    await fsx.write('p1', 'README.md', '# hi');
    await fsx.write('p2', 'other.txt', 'secret');
    assert.deepEqual((await fsx.list('p1')).map((f) => f.path), ['README.md', 'src/app.js']);
    assert.equal((await fsx.list('p2')).length, 1);
    // a fresh instance = a page reload
    const reloaded = await createFsAsync({ prefer: 'none' });
    assert.equal(await reloaded.readText('p1', 'src/app.js'), 'export const a = 1;');
    await reloaded.move('p1', 'README.md', 'docs/README.md');
    assert.deepEqual((await reloaded.list('p1')).map((f) => f.path), ['docs/README.md', 'src/app.js']);
    await reloaded.remove('p1', 'docs');
    assert.deepEqual((await reloaded.list('p1')).map((f) => f.path), ['src/app.js']);
    assert.equal((await fsx.list('p2')).length, 1, 'projects stay isolated');
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ shell -- */

test('shell parser understands quotes, pipes, operators and redirects', () => {
  const chains = parse('echo "a b" | cat && ls -la > out.txt');
  assert.equal(chains.length, 2);
  assert.deepEqual(chains[0].pipeline[0].argv, ['echo', 'a b']);
  assert.equal(chains[0].pipeline.length, 2);
  assert.equal(chains[1].op, '&&');
  assert.deepEqual(chains[1].pipeline[0].redirect, { mode: 'write', path: 'out.txt' });
});

const shellFor = async () => {
  const fsx = mkFs();
  const shell = new Shell({ fs: fsx, projectId: 'p' });
  return { fsx, shell };
};

test('shell runs the everyday commands a coding agent uses', async () => {
  const { fsx, shell } = await shellFor();
  assert.equal((await shell.run('mkdir -p src/components')).code, 0);
  await shell.run('echo "hello world" > src/a.txt');
  assert.equal(await fsx.readText('p', 'src/a.txt'), 'hello world\n');
  assert.match((await shell.run('cat src/a.txt')).output, /hello world/);
  assert.match((await shell.run('ls src')).output, /a\.txt/);
  assert.match((await shell.run('grep -n hello src/a.txt')).output, /1:hello world/);
  assert.equal((await shell.run('find **/*.txt')).output.trim(), 'src/a.txt');
  assert.equal((await shell.run('wc -l src/a.txt')).code, 0);
  assert.match((await shell.run('head -n 1 src/a.txt')).output, /hello world/);
  await shell.run('cp src/a.txt src/b.txt');
  assert.equal(await fsx.exists('p', 'src/b.txt'), true);
  await shell.run('mv src/b.txt src/c.txt');
  assert.equal(await fsx.exists('p', 'src/c.txt'), true);
  assert.equal((await shell.run('rm src/c.txt')).code, 0);
  assert.equal(await fsx.exists('p', 'src/c.txt'), false);
});

test('shell supports cd, pwd, pipes, && and exit codes', async () => {
  const { fsx, shell } = await shellFor();
  await fsx.write('p', 'src/deep/file.txt', 'needle');
  await shell.run('cd src/deep');
  assert.equal((await shell.run('pwd')).output.trim(), '/src/deep');
  assert.match((await shell.run('cat file.txt | grep needle')).output, /needle/);
  assert.equal((await shell.run('false && echo nope')).output.includes('nope'), false);
  assert.match((await shell.run('false || echo yes')).output, /yes/);
  assert.equal((await shell.run('definitely-not-a-command')).code, 127);
});

test('shell runs JavaScript files in a sandbox', async () => {
  const { fsx, shell } = await shellFor();
  await fsx.write('p', 'calc.js', 'const fs = require("fs"); console.log("2+2=", 2+2);');
  const out = await shell.run('node calc.js');
  assert.equal(out.code, 0);
  assert.match(out.output, /2\+2= 4/);
});

test('shell refuses destructive paths outside the project and unknown binaries', async () => {
  const { shell } = await shellFor();
  assert.equal((await shell.run('rm ../../etc/passwd')).code, 1);
  assert.equal((await shell.run('pip install x')).code, 127);
});

test('shell help documents the command set', async () => {
  const { shell } = await shellFor();
  assert.match(HELP, /sqlite3/);
  assert.match((await shell.run('help')).output, /commands:/);
});

/* --------------------------------------------------------------- sqlite ----- */

test('SQL statements split on semicolons outside strings and comments', () => {
  assert.equal(splitStatements("SELECT ';'; -- c;\nSELECT 2;").length, 2);
  assert.equal(splitStatements('CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END;').length, 1);
});

test('SQLite: schema, query, row edits and persistence round-trip', async () => {
  const SQL = await loadEngine();
  const db = new ProjectDatabase({ SQL });
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER);');
  db.insertRow('items', { name: 'bolt', qty: 3 });
  db.insertRow('items', { name: 'nut', qty: 7 });
  const schema = db.schema();
  assert.equal(schema[0].name, 'items');
  assert.equal(schema[0].count, 2);
  assert.deepEqual(schema[0].columns.map((c) => c.name), ['id', 'name', 'qty']);
  const rows = db.query('SELECT name FROM items ORDER BY id');
  assert.deepEqual(rows.rows.map((r) => r.name), ['bolt', 'nut']);
  db.updateRow('items', 1, { qty: 99 });
  assert.equal(rowsToObjects(db.db.exec('SELECT qty FROM items WHERE id=1')).columns[0], 'qty');
  assert.equal(db.query('SELECT qty FROM items WHERE id=1').rows[0].qty, 99);
  db.deleteRow('items', 2);
  assert.equal(db.schema()[0].count, 1);
  assert.throws(() => db.query('DELETE FROM items'), /read-only/);

  // Persist through the project filesystem and reopen.
  const fsx = mkFs();
  const { saveDatabase } = await import('../web/engine/db.js');
  await saveDatabase(fsx, 'p', db);
  const reopened = await openDatabase(fsx, 'p', 'db.sqlite');
  assert.equal(reopened.query('SELECT name FROM items').rows[0].name, 'bolt');
});

/* ------------------------------------------------------------------ zip ----- */

test('zip export produces a valid archive', () => {
  const archive = zipSync({ 'index.html': '<h1>hi</h1>', 'src/a.js': 'x()' });
  assert.equal(archive[0], 0x50);
  assert.equal(archive[1], 0x4b);
  assert.equal(crc32(new TextEncoder().encode('abc')).toString(16), '352441c2');
  const text = new TextDecoder('latin1').decode(archive);
  assert.match(text, /index\.html/);
  assert.match(text, /src\/a\.js/);
});

/* --------------------------------------------------------------- preview ---- */

test('preview bundling inlines css and js into one document', () => {
  const html = bundlePreview({
    'index.html': '<html><head><link rel="stylesheet" href="s.css"></head><body><script src="a.js"></script></body></html>',
    's.css': 'body{color:red}',
    'a.js': 'console.log(1)',
  });
  assert.match(html, /<style>\nbody\{color:red\}\n<\/style>/);
  assert.match(html, /<script>\nconsole\.log\(1\)\n<\/script>/);
  assert.doesNotMatch(html, /href="s\.css"/);
});

test('provider import URLs point at the right dashboards', () => {
  assert.match(importUrl('vercel', 'me/app'), /^https:\/\/vercel\.com\/new\/clone\?repository-url=https%3A%2F%2Fgithub\.com%2Fme%2Fapp/);
  assert.match(importUrl('netlify', 'me/app'), /^https:\/\/app\.netlify\.com\/start\/deploy\?repository=/);
  assert.match(importUrl('cloudflare', 'me/app'), /^https:\/\/deploy\.workers\.cloudflare\.com\/\?url=/);
});

test('deploy without a GitHub token produces a claimable local preview', async () => {
  const result = await deployProject({ target: 'vercel', files: { 'index.html': '<h1>x</h1>' }, githubToken: '' });
  assert.equal(result.provider, 'preview');
  assert.match(result.claimUrl, /#\/claim\//);
  assert.match(result.message, /not on the internet/);
  assert.match(result.previewHtml, /<h1>x<\/h1>/);
});

/* -------------------------------------------------------------- providers --- */

test('attempt planning prefers BYOK, then free routers, then demo', () => {
  const byok = planAttempts({ settings: { keys: { openai: { key: 'sk-1', model: 'gpt-4o-mini' } } } });
  assert.equal(byok[0].provider, 'openai');
  assert.equal(byok[0].via, 'byok');
  const free = planAttempts({ model: 'kilo-auto/free', settings: {} });
  assert.equal(free[0].provider, 'kilo');
  assert.equal(free[0].model, 'kilo-auto/free');
  assert.ok(free.some((a) => a.provider === 'opencode'));
  const demo = planAttempts({ settings: { demo: true } });
  assert.ok(demo.some((a) => a.provider === 'demo'));
});

test('model ids are remapped per provider and the catalogue is free-only', () => {
  assert.equal(modelForProvider('kilo', 'gemini-2.5-flash'), 'kilo-auto/free');
  assert.equal(modelForProvider('opencode', 'gemini-2.5-flash'), 'big-pickle');
  assert.equal(modelForProvider('kilo', 'kilo-auto/free'), 'kilo-auto/free');
  for (const models of Object.values(FREE_MODELS)) for (const m of models) assert.ok(m.id && m.name);
});

test('demo provider streams text and emits tool calls in the harness shape', async () => {
  const events = [];
  const result = await demoCompletion({
    messages: [{ role: 'user', content: 'build a page' }],
    tools: [{ type: 'function', function: { name: 'todo_write' } }],
    onEvent: (e) => events.push(e),
  });
  assert.ok(result.toolCalls.length === 1);
  assert.equal(result.toolCalls[0].name, 'todo_write');
  assert.ok(events.some((e) => e.type === 'text'));
});

/* ------------------------------------------------------------------ tools --- */

test('tool registry exposes the Claude-Code-shaped surface', () => {
  const tools = buildTools({
    fs: mkFs(),
    store: new Store(new MemoryBackend()),
    projectId: 'p',
    shell: null,
    getDb: async () => null,
    releaseDb: () => {},
    emit: () => {},
  });
  const names = tools.map((t) => t.name);
  for (const required of ['read', 'write', 'edit', 'multiedit', 'ls', 'glob', 'grep', 'bash', 'todo_write', 'task', 'deploy', 'db_exec', 'db_query', 'db_schema', 'db_rows']) {
    assert.ok(names.includes(required), `missing tool ${required}`);
  }
  const openai = toOpenAITools(tools);
  assert.equal(openai[0].type, 'function');
  assert.ok(openai[0].function.parameters);
  const plan = toolsForMode(tools, 'plan');
  assert.ok(plan.every((t) => !['write', 'edit', 'bash', 'db_exec'].includes(t.name)), 'plan mode is read-only');
  const explore = toolsForMode(tools, 'default', 'explore');
  assert.equal(explore.some((t) => t.name === 'task'), false, 'no recursive subagents');
});

test('unified diff and edit tools mutate files predictably', async () => {
  const fsx = mkFs();
  const store = new Store(new MemoryBackend());
  const tools = buildTools({ fs: fsx, store, projectId: 'p', shell: null, getDb: async () => null, releaseDb: () => {}, emit: () => {} });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.write.run({ file_path: 'a.txt', content: 'one\ntwo\nthree\n' });
  assert.equal(await fsx.readText('p', 'a.txt'), 'one\ntwo\nthree\n');
  const edited = await byName.edit.run({ file_path: 'a.txt', old_string: 'two', new_string: 'TWO' });
  assert.match(edited.display.diff, /-two/);
  assert.match(edited.display.diff, /\+TWO/);
  const multi = await byName.multiedit.run({ file_path: 'a.txt', edits: [{ old_string: 'one', new_string: '1' }, { old_string: 'three', new_string: '3' }] });
  assert.ok(!multi.isError);
  assert.equal(await fsx.readText('p', 'a.txt'), '1\nTWO\n3\n');
  const miss = await byName.edit.run({ file_path: 'a.txt', old_string: 'zzz', new_string: 'y' });
  assert.equal(miss.isError, true);
  const diff = unifiedDiff('a\nb\n', 'a\nc\n', 'f.txt');
  assert.match(diff, /^--- a\/f\.txt/m);
  assert.match(diff, /@@/);
  const read = await byName.read.run({ file_path: 'a.txt' });
  assert.match(read.text, /1→1/);
});

/* ---------------------------------------------------------------- harness --- */

async function makeHarness({ mode = 'bypass', demo = true } = {}) {
  const fsx = mkFs();
  const store = new Store(new MemoryBackend());
  const { project, thread } = await store.createProject({ name: 'Harness' });
  const shell = new Shell({ fs: fsx, projectId: project.id });
  const events = [];
  const dbs = new Map();
  const getDb = async (p) => {
    if (!dbs.has(p)) dbs.set(p, await openDatabase(fsx, project.id, p));
    return dbs.get(p);
  };
  const harness = new Harness({
    store,
    fs: fsx,
    shell,
    project,
    projectId: project.id,
    threadId: thread.id,
    mode,
    modelRef: 'kilo-auto/free',
    requestedModel: 'kilo-auto/free',
    settings: () => ({ demo }),
    getDb,
    releaseDb: (p) => dbs.delete(p),
    deploy: async () => ({ message: 'preview', url: 'blob:x' }),
    runtimeInfo: () => ({ mode: 'test' }),
    confirm: async () => ({ approved: true }),
    emit: (e) => events.push(e),
  });
  return { harness, fsx, store, project, thread, events, getDb };
}

test('a full agent turn writes files, runs the shell and reports usage', async () => {
  const { harness, fsx, events, store, thread } = await makeHarness();
  const result = await harness.send('Build a landing page');
  assert.equal(await fsx.exists('p', 'index.html'), false); // different project id than 'p'
  const files = await fsx.list(harness.projectId);
  assert.ok(files.some((f) => f.path === 'index.html'), 'index.html written');
  assert.ok(files.some((f) => f.path === 'style.css'), 'style.css written');
  const toolStarts = events.filter((e) => e.type === 'tool_start').map((e) => e.name);
  assert.ok(toolStarts.includes('write'));
  assert.ok(toolStarts.includes('bash'));
  assert.ok(events.some((e) => e.type === 'todos'));
  assert.ok(events.some((e) => e.type === 'usage'));
  assert.equal(result.finishReason, 'stop');
  const messages = await store.messages(thread.id);
  assert.ok(messages.length >= 4, 'user, assistant, tool and final messages persisted');
  assert.ok(messages.some((m) => m.role === 'tool'));
});

test('plan mode blocks writes even if the model asks for one', async () => {
  const { harness, fsx } = await makeHarness({ mode: 'plan' });
  const tools = toolsForMode(buildTools(harness.toolContext()), 'plan');
  assert.equal(tools.some((t) => t.name === 'write'), false);
  await harness.send('write something');
  assert.equal((await fsx.list(harness.projectId)).length, 0, 'plan mode wrote nothing');
});

test('permission denial is reported back to the model, not thrown', async () => {
  const { harness, fsx, events } = await makeHarness({ mode: 'default' });
  harness.confirm = async () => ({ approved: false, reason: 'not today' });
  harness.requestPermission = async () => ({ approved: false, reason: 'not today' });
  await harness.send('run a command');
  const denied = events.filter((e) => e.type === 'tool_end' && e.ok === false);
  assert.ok(denied.length >= 1, 'a tool call was denied');
  assert.equal((await fsx.list(harness.projectId)).length, 0, 'nothing was written');
});

test('stop() aborts a run', async () => {
  const { harness } = await makeHarness();
  const promise = harness.send('build');
  harness.signal?.dispatchEvent?.(new Event('abort'));
  const result = await promise.catch(() => ({ finishReason: 'stopped' }));
  assert.ok(['stopped', 'stop'].includes(result.finishReason));
});

test('database tools create, read and edit a real SQLite file', async () => {
  const { harness, fsx } = await makeHarness();
  const tools = Object.fromEntries(buildTools(harness.toolContext()).map((t) => [t.name, t]));
  await tools.db_exec.run({ path: 'shop.sqlite', sql: 'CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price REAL);' });
  await tools.db_insert.run({ path: 'shop.sqlite', table: 'products', values: { name: 'Mug', price: 9.5 } });
  await tools.db_insert.run({ path: 'shop.sqlite', table: 'products', values: { name: 'Cap', price: 19 } });
  const rows = await tools.db_rows.run({ path: 'shop.sqlite', table: 'products', limit: 10 });
  assert.match(rows.text, /Mug/);
  const schema = await tools.db_schema.run({ path: 'shop.sqlite' });
  assert.match(schema.text, /products/);
  const bulk = await tools.db_query.run({ path: 'shop.sqlite', sql: 'SELECT COUNT(*) AS n FROM products' });
  assert.match(bulk.text, /"n": 2/);
  await tools.db_update.run({ path: 'shop.sqlite', table: 'products', rowid: 1, changes: { price: 11 } });
  const after = await tools.db_query.run({ path: 'shop.sqlite', sql: 'SELECT price FROM products WHERE id=1' });
  assert.match(after.text, /11/);
  assert.equal(await fsx.exists(harness.projectId, 'shop.sqlite'), true, 'database persisted as a project file');
});

test('bash tool output is streamed as tool_output events', async () => {
  const { harness, events } = await makeHarness();
  const tools = Object.fromEntries(buildTools(harness.toolContext()).map((t) => [t.name, t]));
  await tools.bash.run({ command: 'echo streamed-line' });
  assert.ok(events.some((e) => e.type === 'tool_output' && /streamed-line/.test(e.text)));
});

test('checkpoints snapshot the workspace for rewind', async () => {
  const { harness, fsx, store } = await makeHarness();
  const tools = Object.fromEntries(buildTools(harness.toolContext()).map((t) => [t.name, t]));
  await tools.write.run({ file_path: 'a.txt', content: 'v1' });
  const snap = await tools.checkpoint.run({ label: 'before' });
  await tools.write.run({ file_path: 'a.txt', content: 'v2' });
  const list = await store.snapshots(harness.projectId);
  assert.ok(list.length >= 1);
  await fsx.restore(harness.projectId, list[0].files);
  assert.equal(await fsx.readText(harness.projectId, 'a.txt'), 'v1');
  assert.match(snap.text, /Checkpoint/);
});

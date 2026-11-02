/**
 * The workspace layer added for v7: mounting a real folder, mirroring writes
 * both ways, and installing npm packages into the project (and therefore into
 * the mounted folder, and into the Node runtime).
 *
 * The File System Access API has no headless implementation, so the tests use
 * handles shaped exactly like the browser's: `entries()`, `getFile()`,
 * `createWritable()`, `getDirectoryHandle()` and `getFileHandle()`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { FolderMount, walkFolder, isTextPath, MOUNT_SKIP_DIRS, MOUNT_LIMITS } = await import('../web/engine/mount.js');
const { FileSystem, MemoryFs } = await import('../web/engine/fs.js');
const { splitSpec, loadNodepod, nodepodStatus, NODEPOD_URL } = await import('../web/engine/node/nodepod.js');
const { NodeSession } = await import('../web/engine/node/session.js');
const { NodeFS } = await import('../web/engine/node/vfs.js');
const { fileIconPath, hasIcon } = await import('../web/app/ui.js');

/* ------------------------------------------------------------- fake FSA --- */

const encoder = new TextEncoder();

/** A directory handle over a plain object tree; writes are kept. */
function dirHandle(name, entries = {}) {
  const children = new Map();
  const handle = {
    kind: 'directory',
    name,
    children,
    async *entries() {
      for (const [key, value] of children) yield [key, value];
    },
    async getDirectoryHandle(child, options = {}) {
      const hit = children.get(child);
      if (hit?.kind === 'directory') return hit;
      if (!options.create) throw Object.assign(new Error(`ENOENT: ${child}`), { name: 'NotFoundError' });
      const created = dirHandle(child);
      children.set(child, created);
      return created;
    },
    async getFileHandle(child, options = {}) {
      const hit = children.get(child);
      if (hit && hit.kind === 'file') return hit;
      if (!options.create) throw Object.assign(new Error(`ENOENT: ${child}`), { name: 'NotFoundError' });
      const created = fileHandle(child, '');
      children.set(child, created);
      return created;
    },
    async queryPermission() {
      return 'granted';
    },
  };
  for (const [key, value] of Object.entries(entries)) children.set(key, typeof value === 'string' ? fileHandle(key, value) : value);
  return handle;
}

function fileHandle(name, initial) {
  let content = initial;
  return {
    kind: 'file',
    name,
    async getFile() {
      const bytes = typeof content === 'string' ? encoder.encode(content) : content;
      return {
        size: bytes.byteLength,
        lastModified: 1000,
        text: async () => (typeof content === 'string' ? content : new TextDecoder().decode(content)),
        arrayBuffer: async () => bytes.buffer,
      };
    },
    async createWritable() {
      let next = content;
      return {
        write: async (value) => {
          next = value;
        },
        close: async () => {
          content = next;
        },
      };
    },
    /** test helper */
    get content() {
      return content;
    },
  };
}

const textFile = (handle) => handle.content;

/* --------------------------------------------------------------- walking --- */

test('a folder walk skips build output and reports what it found', async () => {
  const root = dirHandle('site', {
    'index.html': '<h1>hi</h1>',
    src: dirHandle('src', { 'app.js': 'const a = 1;' }),
    node_modules: dirHandle('node_modules', { 'x.js': 'skip' }),
    '.git': dirHandle('.git', { HEAD: 'ref' }),
    dist: dirHandle('dist', { 'bundle.js': 'skip' }),
  });
  const { files, truncated } = await walkFolder(root);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['index.html', 'src/app.js']);
  assert.equal(truncated, false);
  assert.ok(MOUNT_SKIP_DIRS.has('node_modules'));
});

test('the walk stops at the file limit instead of hanging on a huge tree', async () => {
  const many = {};
  for (let i = 0; i < 40; i += 1) many[`f${i}.txt`] = 'x';
  const root = dirHandle('big', many);
  const { files, truncated } = await walkFolder(root, { limit: 10 });
  assert.equal(files.length, 11);
  assert.equal(truncated, true);
  assert.ok(MOUNT_LIMITS.files >= 1000);
});

test('text files are detected the same way the store detects them', () => {
  assert.equal(isTextPath('a/b/c.css'), true);
  assert.equal(isTextPath('index.html'), true);
  assert.equal(isTextPath('Dockerfile'), true);
  assert.equal(isTextPath('LICENSE'), true);
  assert.equal(isTextPath('.gitignore'), true);
  assert.equal(isTextPath('logo.png'), false);
  assert.equal(isTextPath('bundle.wasm'), false);
});

/* --------------------------------------------------------------- pulling --- */

test('mounting copies the folder into the project', async () => {
  const fs = new FileSystem(new MemoryFs());
  const root = dirHandle('site', {
    'index.html': '<h1>hi</h1>',
    src: dirHandle('src', { 'app.js': 'const a = 1;' }),
    node_modules: dirHandle('node_modules', { 'x.js': 'skip' }),
  });
  const mount = new FolderMount({ fs, projectId: 'p', handle: root });
  const result = await mount.pullAll();
  assert.equal(result.written, 2);
  assert.equal(await fs.readText('p', 'index.html'), '<h1>hi</h1>');
  assert.equal(await fs.readText('p', 'src/app.js'), 'const a = 1;');
  assert.equal(await fs.exists('p', 'node_modules/x.js'), false);
  assert.equal(mount.info().files, 2);
  mount.dispose();
});

test('pulling a second time only rewrites what changed on disk', async () => {
  const fs = new FileSystem(new MemoryFs());
  const root = dirHandle('site', { 'a.txt': 'one', 'b.txt': 'two' });
  const mount = new FolderMount({ fs, projectId: 'p', handle: root });
  assert.equal((await mount.pullAll()).written, 2);

  // untouched second pass
  assert.equal((await mount.pullAll()).written, 0);

  // one file edited on disk, one added, one deleted
  root.children.set('a.txt', fileHandle('a.txt', 'one changed'));
  root.children.set('c.txt', fileHandle('c.txt', 'three'));
  root.children.delete('b.txt');
  const changes = await mount.pullChanges();
  assert.equal(changes.written, 2);
  assert.deepEqual(changes.removed, ['b.txt']);
  assert.equal(await fs.readText('p', 'a.txt'), 'one changed');
  assert.equal(await fs.exists('p', 'c.txt'), true);
  mount.dispose();
});

/* --------------------------------------------------------------- pushing --- */

test('a write in the app is mirrored into the folder', async () => {
  const fs = new FileSystem(new MemoryFs());
  const root = dirHandle('site', {});
  const mount = new FolderMount({ fs, projectId: 'p', handle: root });
  mount.watch();

  await fs.write('p', 'notes/today.txt', 'written in the app');
  await mount.flush();

  const notes = root.children.get('notes');
  assert.ok(notes, 'the nested directory was created in the folder');
  assert.equal(textFile(notes.children.get('today.txt')), 'written in the app');
  mount.dispose();
});

test('files installed by npm are mirrored too, so node_modules lands in the folder', async () => {
  const fs = new FileSystem(new MemoryFs());
  const root = dirHandle('site', {});
  const mount = new FolderMount({ fs, projectId: 'p', handle: root });
  mount.watch();

  await fs.write('p', 'node_modules/left-pad/index.js', 'module.exports = () => {};');
  await mount.flush();

  const modules = root.children.get('node_modules');
  assert.ok(modules);
  assert.equal(textFile(modules.children.get('left-pad').children.get('index.js')), 'module.exports = () => {};');
  mount.dispose();
});

test('a write that came from the folder does not echo back into it', async () => {
  const fs = new FileSystem(new MemoryFs());
  const root = dirHandle('site', { 'a.txt': 'from disk' });
  const mount = new FolderMount({ fs, projectId: 'p', handle: root });
  mount.watch();
  await mount.pullAll();
  await mount.flush();
  // the file kept its disk content instead of being rewritten from the mirror
  assert.equal(textFile(root.children.get('a.txt')), 'from disk');
  mount.dispose();
});

test('pushAll writes the whole project out and counts skips', async () => {
  const fs = new FileSystem(new MemoryFs());
  const root = dirHandle('site', {});
  await fs.write('p', 'index.html', '<h1>x</h1>');
  await fs.write('p', 'style.css', 'body{}');
  const mount = new FolderMount({ fs, projectId: 'p', handle: root });
  const result = await mount.pushAll();
  assert.equal(result.written, 2);
  assert.equal(textFile(root.children.get('index.html')), '<h1>x</h1>');
  assert.equal(textFile(root.children.get('style.css')), 'body{}');
  mount.dispose();
});

test('pushAll can leave node_modules out', async () => {
  const fs = new FileSystem(new MemoryFs());
  const root = dirHandle('site', {});
  await fs.write('p', 'index.html', '<h1>x</h1>');
  await fs.write('p', 'node_modules/a/index.js', 'x');
  const mount = new FolderMount({ fs, projectId: 'p', handle: root });
  const result = await mount.pushAll({ includeModules: false });
  assert.equal(result.written, 1);
  assert.equal(root.children.has('node_modules'), false);
  mount.dispose();
});

test('the mount reports its state and stops mirroring when disposed', async () => {
  const fs = new FileSystem(new MemoryFs());
  const root = dirHandle('site', {});
  const seen = [];
  const mount = new FolderMount({ fs, projectId: 'p', handle: root, onEvent: (e) => seen.push(e.type) });
  mount.watch();
  await mount.pullAll();
  assert.equal(mount.info().state, 'ready');
  assert.ok(seen.includes('pulled'));
  mount.dispose();
  await fs.write('p', 'after.txt', 'not mirrored');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(root.children.has('after.txt'), false);
});

/* ------------------------------------------------------- fs change events --- */

test('the filesystem reports writes, deletes and moves, and can be muted', async () => {
  const fs = new FileSystem(new MemoryFs());
  const events = [];
  const off = fs.onChange((event) => events.push(event.type));
  await fs.write('p', 'a.txt', 'a');
  await fs.move('p', 'a.txt', 'b.txt');
  await fs.remove('p', 'b.txt');
  assert.deepEqual(events, ['write', 'move', 'remove']);

  // muting suppresses notifications without unsubscribing anyone
  const release = fs.mute();
  await fs.write('p', 'd.txt', 'd');
  release();
  await fs.write('p', 'e.txt', 'e');
  assert.deepEqual(events, ['write', 'move', 'remove', 'write']);

  // and unsubscribing really stops them
  off();
  await fs.write('p', 'f.txt', 'f');
  assert.equal(events.length, 4);
});

/* ------------------------------------------------------- npm, full engine --- */

test('a specifier splits into name and range the way npm does', () => {
  assert.deepEqual(splitSpec('react'), ['react', '']);
  assert.deepEqual(splitSpec('react@18.2.0'), ['react', '18.2.0']);
  assert.deepEqual(splitSpec('@scope/pkg'), ['@scope/pkg', '']);
  assert.deepEqual(splitSpec('@scope/pkg@^2.0.0'), ['@scope/pkg', '^2.0.0']);
});

test('the full npm engine reports itself missing instead of throwing at import time', async () => {
  const status = await nodepodStatus({ url: 'data:application/javascript,export const nope = 1;' });
  assert.equal(status.available, false);
  assert.equal(typeof status.reason, 'string');
  await assert.rejects(() => loadNodepod({ url: 'data:application/javascript,export const nope = 1;' }), (err) => err.code === 'NODEPOD_MISSING');
  assert.equal(NODEPOD_URL, '/nodepod/index.mjs');
});

test('a session falls back to the built-in installer when the full engine is absent', async () => {
  const fs = new FileSystem(new MemoryFs());
  await fs.write('p', 'package.json', JSON.stringify({ name: 'demo', dependencies: {} }));
  const written = [];
  const session = new NodeSession({ fs, projectId: 'p', npmEngine: 'nodepod' });
  // Point the runtime at the built-in path by stubbing the dynamic import:
  // npmInstallFull returns null when the engine is missing, and the caller logs
  // the downgrade and keeps going.
  session.npmInstallFull = async () => null;
  session.syncFromProject = async () => {
    const runtime = { fs: new NodeFS({ cwd: '/app' }) };
    return runtime;
  };
  const lines = [];
  const result = await session.npmInstall({ log: (line) => lines.push(line) });
  assert.ok(lines.some((line) => line.includes('built-in resolver')));
  assert.equal(typeof result.code, 'number');
  void written;
});

/* ------------------------------------------------------------- file icons --- */

test('every file type resolves to a glyph that exists', () => {
  const samples = ['a.js', 'a.ts', 'index.html', 's.css', 'p.json', 'README.md', 'x.png', 'y.zip', 'z.wasm', 'f.woff2', 'package-lock.json', 'c.yml', 'd.sqlite', 'e.py', 'run.sh', 'noext'];
  for (const name of samples) {
    const { glyph } = fileIconPath(name);
    assert.ok(hasIcon(glyph), `${name} → ${glyph} is missing from the icon set`);
  }
  assert.equal(fileIconPath('a.ts').kind, 'ts');
  assert.equal(fileIconPath('a.css').kind, 'css');
});

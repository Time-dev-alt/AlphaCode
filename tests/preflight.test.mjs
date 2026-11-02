/**
 * Deploy preflight.
 *
 * The rule under test: everything that is knowable on this machine is decided
 * before a provider tab opens. A blocker means "this cannot ship"; a warning
 * means "this will ship, and it will probably not be what you meant".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployPreflight } from '../web/engine/deploy.js';

const page = (body = '<h1>hi</h1>') =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`;

const codes = (rows) => rows.map((row) => row.code);

test('a complete static page passes with nothing to say', () => {
  const result = deployPreflight({ target: 'preview', files: { 'index.html': page(), 'style.css': 'body{}' } });
  assert.equal(result.ok, true);
  assert.equal(result.entry, 'index.html');
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.warnings, []);
});

test('an empty project is a blocker, not a broken deploy', () => {
  const result = deployPreflight({ target: 'preview', files: {} });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.blockers), ['empty-project']);
  assert.ok(result.blockers[0].fix.length > 10, 'a blocker says what to do about it');
});

test('no HTML at all is a blocker', () => {
  const result = deployPreflight({ target: 'preview', files: { 'notes.md': '# hi' } });
  assert.deepEqual(codes(result.blockers), ['missing-entry']);
});

test('a non-index entry warns instead of blocking', () => {
  const result = deployPreflight({ target: 'preview', files: { 'home.html': page() } });
  assert.equal(result.ok, true);
  assert.equal(result.entry, 'home.html');
  assert.ok(codes(result.warnings).includes('entry-not-index'));
});

test('a referenced file that was never written is caught', () => {
  const result = deployPreflight({
    target: 'preview',
    files: { 'index.html': page('<link rel="stylesheet" href="styles.css">') },
  });
  assert.equal(result.ok, true, 'a 404 stylesheet does not stop a deploy');
  const warning = result.warnings.find((row) => row.code === 'missing-assets');
  assert.ok(warning, 'but it is reported');
  assert.match(warning.message, /styles\.css/);
});

test('absolute and external references are not mistaken for missing files', () => {
  const result = deployPreflight({
    target: 'preview',
    files: {
      'index.html': page('<link rel="stylesheet" href="/style.css"><script src="https://cdn.example/x.js"></script><a href="#top">t</a>'),
      'style.css': 'body{}',
    },
  });
  assert.deepEqual(codes(result.warnings), []);
});

test('missing viewport meta and no README are warnings, not blockers', () => {
  const result = deployPreflight({
    target: 'cloudflare',
    files: { 'index.html': '<html><body>x</body></html>' },
    github: { token: 'gho_x' },
  });
  assert.equal(result.ok, true);
  assert.ok(codes(result.warnings).includes('no-viewport'));
  assert.ok(codes(result.warnings).includes('no-readme'));
});

test('publishing to a host without GitHub is blocked before anything opens', () => {
  for (const target of ['cloudflare', 'vercel', 'netlify']) {
    const result = deployPreflight({ target, files: { 'index.html': page() } });
    assert.equal(result.ok, false, target);
    assert.deepEqual(codes(result.blockers), ['github-not-connected']);
    // An instant preview needs no account, and must still work.
    assert.equal(deployPreflight({ target: 'preview', files: { 'index.html': page() } }).ok, true);
  }
});

test('an expired GitHub session is still just "not connected"', () => {
  const result = deployPreflight({ target: 'vercel', files: { 'index.html': page() }, github: { token: '' } });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.blockers), ['github-not-connected']);
});

test('a very large text project is flagged before the upload', () => {
  const big = 'x'.repeat(13 * 1024 * 1024);
  const result = deployPreflight({ target: 'preview', files: { 'index.html': page(), 'data.json': big } });
  assert.ok(codes(result.warnings).includes('large-project'));
});

test('an unknown target is named, not silently accepted', () => {
  const result = deployPreflight({ target: 'heroku', files: { 'index.html': page() } });
  assert.ok(codes(result.warnings).includes('unknown-target'));
});

test('the reported size counts text, and the entry travels back', () => {
  const result = deployPreflight({ target: 'preview', files: { 'index.html': 'abc', 'a.txt': 'de' } });
  assert.equal(result.bytes, 5);
  assert.equal(result.entry, 'index.html');
});

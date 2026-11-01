/**
 * Hooks: matcher semantics, allow/block exit codes, environment contract and
 * isolation from a bad hook. Hooks are shell commands, so we exercise real ones.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alphacode-hooks-'));
const traceFile = path.join(tmp, 'trace.jsonl');

const config = {
  PreToolUse: [
    { matcher: 'bash', command: `printf '{"event":"%s","tool":"%s","file":"%s"}\\n' "$ALPHACODE_EVENT" "$ALPHACODE_TOOL" "$ALPHACODE_FILE" >> ${traceFile}` },
    { matcher: 'write', command: 'echo "writes are blocked here" >&2; exit 2' },
    { matcher: 'read',
      command: 'echo "{}" >/dev/null; exit 1' },
  ],
  PostToolUse: [{ matcher: '*', command: 'echo post-ran' }],
  PreCompact: [{ matcher: '*', command: 'cat > /dev/null; echo compacted' }],
};

process.env.ALPHACODE_HOOKS = JSON.stringify(config);

const { fireHooks, hooksConfig, matcherMatches, resetHooksCache, HOOK_EVENTS } = await import('../src/agent/hooks.mjs');

before(() => resetHooksCache());
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('parses only known events and normalises shapes', () => {
  resetHooksCache();
  const cfg = hooksConfig();
  assert.deepEqual(Object.keys(cfg).sort(), ['PostToolUse', 'PreCompact', 'PreToolUse']);
  assert.equal(cfg.PreToolUse.length, 3);
  assert.ok(HOOK_EVENTS.includes('SessionStart'));
  assert.equal(hooksConfig().PreToolUse[0].matcher, 'bash');
});

test('matchers accept regex, wildcards and literal lists', () => {
  assert.equal(matcherMatches('*', 'anything'), true);
  assert.equal(matcherMatches('', 'anything'), true);
  assert.equal(matcherMatches('bash|write', 'write'), true);
  assert.equal(matcherMatches('bash|write', 'read'), false);
  assert.equal(matcherMatches('^read', 'read_file'), true);
  assert.equal(matcherMatches('^read', 'write'), false);
  assert.equal(matcherMatches('bash', 'bash_output'), true, 'matchers are unanchored');
  assert.equal(matcherMatches('Bash', 'bash'), false);
});

test('an allowing hook runs with the documented environment', async () => {
  const res = await fireHooks('PreToolUse', { file: 'src/a.js', projectId: 'p1' }, { toolName: 'bash' });
  assert.equal(res.blocked, false);
  const trace = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = trace[trace.length - 1];
  assert.deepEqual(last, { event: 'PreToolUse', tool: 'bash', file: 'src/a.js' });
});

test('exit code 2 blocks the call and returns the reason', async () => {
  const res = await fireHooks('PreToolUse', { file: 'x.txt' }, { toolName: 'write' });
  assert.equal(res.blocked, true);
  assert.match(res.reason, /writes are blocked here/);
});

test('other non-zero codes warn but never block', async () => {
  const res = await fireHooks('PreToolUse', {}, { toolName: 'read' });
  assert.equal(res.blocked, false);
});

test('unmatched tools skip hooks entirely', async () => {
  const before = fs.readFileSync(traceFile, 'utf8').length;
  const res = await fireHooks('PreToolUse', {}, { toolName: 'grep' });
  assert.equal(res.blocked, false);
  assert.equal(fs.readFileSync(traceFile, 'utf8').length, before);
});

test('notices are emitted for stdout of successful hooks', async () => {
  const events = [];
  const res = await fireHooks('PreCompact', {}, { emit: (e) => events.push(e) });
  assert.equal(res.blocked, false);
  assert.ok(events.some((e) => /compacted/.test(e.text)));
});

test('a missing event is a no-op', async () => {
  const res = await fireHooks('SessionEnd', {});
  assert.deepEqual(res, { blocked: false, reason: '', notices: [] });
});

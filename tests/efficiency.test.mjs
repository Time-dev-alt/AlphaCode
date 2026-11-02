/**
 * Request-efficiency tests.
 *
 * The complaint these exist to prevent: "the agent requests too many times, so
 * most providers fail even though they were working". So the tests are about
 * request behaviour, not features — how many calls a turn makes, which provider
 * gets them, what happens when one is rate limited, and whether the agent gives
 * up cleanly instead of burning the allowance.
 *
 * Everything is deterministic: `now` and `sleep` are injected, and the model is
 * stubbed, so no network and no clock are involved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { RequestGovernor, classifyProviderError, readRetryAfter, getGovernor, setGovernor } = await import(
  '../web/engine/agent/governor.js'
);
const { buildSystemPrompt, rankFiles, keywords, budgetNote, EFFICIENCY_RULES } = await import(
  '../web/engine/agent/prompt.js'
);
const { Store, MemoryBackend } = await import('../web/engine/store.js');
const { FileSystem, MemoryFs } = await import('../web/engine/fs.js');
const { Shell } = await import('../web/engine/shell.js');
const { Harness } = await import('../web/engine/harness.js');

/** A governor on a fake clock that never really waits. */
function fakeGovernor(options = {}) {
  let clock = 1_000_000;
  const sleeps = [];
  const governor = new RequestGovernor({
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...options,
  });
  return {
    governor,
    sleeps,
    advance: (ms) => {
      clock += ms;
    },
    get clock() {
      return clock;
    },
  };
}

const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null });

/* ── classification ───────────────────────────────────────────────────── */

test('errors are classified by status first, message second', () => {
  const rate = classifyProviderError(Object.assign(new Error('429 nonsense'), { status: 429 }));
  assert.equal(rate.kind, 'rate_limit');
  assert.equal(rate.retryable, true);

  const auth = classifyProviderError(Object.assign(new Error('nope'), { status: 401 }));
  assert.equal(auth.kind, 'auth');
  assert.equal(auth.retryable, false, 'a bad key must never be retried');

  const quota = classifyProviderError(Object.assign(new Error('nope'), { status: 402 }));
  assert.equal(quota.kind, 'quota');
  assert.equal(quota.retryable, false);

  const model = classifyProviderError(Object.assign(new Error('nope'), { status: 404 }));
  assert.equal(model.kind, 'model');
  assert.equal(model.retryable, false);

  // Message-only signals, for routers that return 200-shaped errors.
  assert.equal(classifyProviderError(new Error('Rate limit exceeded, slow down')).kind, 'rate_limit');
  assert.equal(classifyProviderError(new Error('Invalid API key provided')).kind, 'auth');
  assert.equal(classifyProviderError(new Error('unavailable model: gpt-9')).kind, 'model');
  assert.equal(classifyProviderError(new Error('Failed to fetch')).kind, 'network');
});

test('a 400 about tokens is a context error, not a bad request', () => {
  const err = Object.assign(new Error('maximum context length is 8192 tokens'), { status: 400 });
  assert.equal(classifyProviderError(err).kind, 'context');
});

test('Retry-After is parsed in seconds, as a date, and from reset headers', () => {
  const now = 1_700_000_000_000;
  assert.equal(readRetryAfter(headers({ 'retry-after': '12' }), now), 12_000);
  assert.equal(readRetryAfter(headers({ 'retry-after': new Date(now + 7_000).toUTCString() }), now), 7_000);
  // A unix timestamp, not a delta.
  assert.equal(readRetryAfter(headers({ 'x-ratelimit-reset': String(Math.floor(now / 1000) + 30) }), now), 30_000);
  // A delta.
  assert.equal(readRetryAfter(headers({ 'x-ratelimit-reset': '45' }), now), 45_000);
  assert.equal(readRetryAfter(headers({}), now), null);
  assert.equal(readRetryAfter(null, now), null);
});

/* ── cooldowns ────────────────────────────────────────────────────────── */

test('a rate limit takes the provider out of rotation, then it comes back', () => {
  const { governor, advance } = fakeGovernor();
  const classification = classifyProviderError(Object.assign(new Error('429'), { status: 429, retryAfterMs: 20_000 }));
  const wait = governor.penalize('kilo', classification);
  assert.ok(wait >= 17_000 && wait <= 23_000, `honours Retry-After (got ${wait})`);
  assert.equal(governor.available('kilo'), false);

  advance(wait + 1);
  assert.equal(governor.available('kilo'), true, 'the cooldown expires on its own');
});

test('repeated rate limits back off further, but never past the cap', () => {
  const { governor } = fakeGovernor({ maxCooldownMs: 60_000 });
  const classification = classifyProviderError(Object.assign(new Error('429'), { status: 429 }));
  const first = governor.penalize('kilo', classification);
  const second = governor.penalize('kilo', classification);
  assert.ok(second > first, `backoff grows (${first} → ${second})`);
  for (let i = 0; i < 8; i++) governor.penalize('kilo', classification);
  assert.ok(governor.cooldownFor('kilo') <= 60_000, 'capped');
});

test('a bad key is parked for a long time; a network blip is not', () => {
  const { governor } = fakeGovernor();
  const authWait = governor.penalize('kilo', classifyProviderError(Object.assign(new Error('x'), { status: 401 })));
  const netWait = governor.penalize('groq', classifyProviderError(new Error('Failed to fetch')));
  assert.ok(authWait > netWait * 10, `auth ${authWait} vs network ${netWait}`);
});

test('success clears the cooldown and makes the provider sticky', () => {
  const { governor } = fakeGovernor();
  governor.penalize('kilo', classifyProviderError(Object.assign(new Error('429'), { status: 429 })));
  governor.reward('kilo');
  assert.equal(governor.available('kilo'), true);
  assert.equal(governor.sticky, 'kilo');
});

/* ── ordering ─────────────────────────────────────────────────────────── */

test('ordering prefers BYOK, then a healthy provider, then the sticky one', () => {
  const { governor } = fakeGovernor();
  const attempts = [
    { provider: 'kilo', via: 'free' },
    { provider: 'groq', via: 'free' },
    { provider: 'openai', via: 'byok' },
    { provider: 'demo', via: 'free' },
  ];
  assert.equal(governor.order(attempts)[0].provider, 'openai', 'the user pays, so their key goes first');

  governor.reward('groq');
  const ordered = governor.order(attempts.filter((a) => a.via !== 'byok')).map((a) => a.provider);
  assert.equal(ordered[0], 'groq', 'the provider that just worked is tried first');
});

test('providers in a long cooldown are dropped from the ordering entirely', () => {
  const { governor } = fakeGovernor();
  governor.penalize('kilo', classifyProviderError(Object.assign(new Error('x'), { status: 401 })));
  const ordered = governor.order([
    { provider: 'kilo', via: 'free' },
    { provider: 'groq', via: 'free' },
  ]);
  assert.deepEqual(ordered.map((a) => a.provider), ['groq']);
});

test('ordering does not rotate a working provider away', () => {
  const { governor } = fakeGovernor();
  const attempts = [
    { provider: 'a', via: 'free' },
    { provider: 'b', via: 'free' },
  ];
  governor.reward('b');
  for (let i = 0; i < 5; i++) {
    assert.equal(governor.order(attempts)[0].provider, 'b', `call ${i} stays on b`);
    governor.reward('b');
  }
});

/* ── rate window and budget ───────────────────────────────────────────── */

test('the sliding window stops a fast loop before the provider does', async () => {
  const { governor, advance, sleeps } = fakeGovernor({ maxPerWindow: 3, windowMs: 20_000, maxWaitMs: 30_000 });
  for (let i = 0; i < 3; i++) assert.equal(await governor.reserve('kilo'), true);
  assert.equal(governor.windowUsage('kilo').full, true);
  assert.equal(await governor.reserve('kilo'), true, 'the fourth waits for a slot');
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 0);
  advance(20_000);
  assert.equal(governor.windowUsage('kilo').used, 0, 'the window drains');
});

test('a wait longer than we are willing to sit through fails fast', async () => {
  const { governor } = fakeGovernor({ maxPerWindow: 1, windowMs: 120_000, maxWaitMs: 5_000 });
  await governor.reserve('kilo');
  assert.equal(await governor.reserve('kilo'), false, 'no stalling the turn for two minutes');
});

test('the turn budget is a hard stop', async () => {
  const { governor } = fakeGovernor({ budget: 2, maxPerWindow: 100 });
  assert.equal(await governor.reserve('kilo'), true);
  assert.equal(await governor.reserve('kilo'), true);
  assert.equal(governor.remaining, 0);
  assert.equal(await governor.reserve('kilo'), false);
});

test('state survives a page reload: cooldowns are restored, stale ones are not', () => {
  const { governor } = fakeGovernor();
  governor.penalize('kilo', classifyProviderError(Object.assign(new Error('x'), { status: 401 })));
  governor.reward('groq');
  const saved = governor.serialize();
  assert.equal(saved.sticky, 'groq');
  assert.ok(saved.cooldowns.kilo);

  const { governor: restored, advance } = fakeGovernor();
  restored.restore(saved);
  assert.equal(restored.available('kilo'), false, 'a parked key is still parked');

  advance(40 * 60_000);
  const { governor: later } = fakeGovernor();
  later.restore(saved);
  // The restored clock is far ahead of the saved one, so the cooldown is gone.
  assert.equal(later.available('kilo'), false, 'restore clamps to the saved instant');
});

test('snapshot reports what the UI needs and nothing else', () => {
  const { governor } = fakeGovernor();
  governor.penalize('kilo', classifyProviderError(Object.assign(new Error('429'), { status: 429 })));
  governor.reward('groq');
  const snap = governor.snapshot();
  assert.equal(snap.budget, 24);
  assert.ok(snap.providers.some((p) => p.provider === 'kilo' && p.cooldownMs > 0));
  assert.equal(snap.sticky, 'groq');
  assert.equal(snap.remaining, 24);
});

test('getGovernor is one instance per page, and setGovernor replaces it', () => {
  const original = getGovernor();
  const mine = fakeGovernor().governor;
  assert.equal(setGovernor(mine), mine);
  assert.equal(getGovernor(), mine);
  setGovernor(original);
});

/* ── prompt ───────────────────────────────────────────────────────────── */

test('the prompt states the request budget and asks for batched calls', () => {
  const prompt = buildSystemPrompt({ budgetLeft: 5, files: [{ path: 'index.html' }] });
  assert.match(prompt, /at most 4 model requests/i);
  assert.match(prompt, /ONE response/i);
  assert.match(prompt, /5 model requests left/);
  assert.ok(EFFICIENCY_RULES.includes('Never re-read'));
});

test('files are ranked so the listing stays short and useful', () => {
  const files = [
    'assets/fonts/inter.woff2',
    'assets/logo.png',
    'src/components/Navbar.jsx',
    'src/pages/Checkout.jsx',
    'index.html',
    'package.json',
  ].map((path) => ({ path }));
  const ranked = rankFiles(files, { request: 'change the checkout button colour' }).map((r) => r.path);
  assert.equal(ranked[0], 'src/pages/Checkout.jsx', `got ${ranked[0]}`);
  assert.ok(ranked.indexOf('index.html') < ranked.indexOf('assets/logo.png'), 'binaries sink');
  assert.ok(ranked.length <= 6);
});

test('recently changed and open files float to the top', () => {
  const files = ['a.js', 'b.js', 'c.js'].map((path) => ({ path }));
  assert.equal(rankFiles(files, { request: 'tidy up', recent: ['c.js'] })[0].path, 'c.js');
  assert.equal(rankFiles(files, { request: 'tidy up', openFile: 'b.js' })[0].path, 'b.js');
});

test('keywords drop the words every request has', () => {
  const words = keywords('please build me a landing page for a coffee shop');
  assert.ok(words.includes('landing'));
  assert.ok(words.includes('coffee'));
  assert.ok(!words.includes('please'));
  assert.ok(!words.includes('build'));
});

test('the budget note only appears when it matters', () => {
  assert.equal(budgetNote(6), '');
  assert.match(budgetNote(2), /Only 2 model requests left/);
  assert.match(budgetNote(0), /exhausted/);
});

/* ── the loop, end to end ─────────────────────────────────────────────── */

/**
 * A harness whose model is a stub, so we can count requests exactly.
 * `script` is a list of responses; each may also throw to simulate a failure.
 */
async function makeHarness({ script = [], settings = {} } = {}) {
  const fsx = new FileSystem(new MemoryFs());
  const store = new Store(new MemoryBackend());
  const { project, thread } = await store.createProject({ name: 'Budget' });
  const shell = new Shell({ fs: fsx, projectId: project.id });
  const events = [];
  const calls = [];
  const harness = new Harness({
    store,
    fs: fsx,
    shell,
    project,
    projectId: project.id,
    threadId: thread.id,
    mode: 'bypass',
    modelRef: 'kilo-auto/free',
    requestedModel: 'kilo-auto/free',
    settings: () => ({ demo: false, ...settings }),
    getDb: async () => ({}),
    releaseDb: () => {},
    deploy: async () => ({ message: 'preview' }),
    runtimeInfo: () => ({ mode: 'test' }),
    confirm: async () => ({ approved: true }),
    emit: (e) => events.push(e),
  });
  harness.governor = fakeGovernor({ budget: settings.requestBudget || 8, sleep: async () => {} }).governor;
  // Replace the single provider call with the scripted stub.
  harness.callModel = async function stub({ messages, tools }) {
    // Mirror the real path: when the segment's requests are gone the real
    // callModel raises a `paused` error, which is what the loop extends from.
    if (harness.governor.remaining <= 0) {
      const paused = new Error('Paused after the segment budget.');
      paused.paused = true;
      throw paused;
    }
    harness.governor.used += 1;
    harness.governor.stats.attempts += 1;
    calls.push({ messages: messages.length, toolCount: tools.length });
    const step = script[calls.length - 1];
    if (!step) return { content: 'done', toolCalls: [], usage: {}, finishReason: 'stop' };
    if (step.throw) throw step.throw;
    return { content: step.content || '', toolCalls: step.toolCalls || [], usage: {}, finishReason: 'stop' };
  };
  return { harness, fsx, store, project, thread, events, calls };
}

test('one response with five write calls costs one request, not five', async () => {
  const toolCalls = ['index.html', 'style.css', 'app.js', 'about.html', 'data.json'].map((file, i) => ({
    id: `c${i}`,
    name: 'write',
    arguments: JSON.stringify({ file_path: file, content: `/* ${file} */` }),
  }));
  const { harness, fsx, calls } = await makeHarness({ script: [{ toolCalls }, { content: 'Built it.' }] });
  const result = await harness.send('Build a five page site');
  assert.equal(calls.length, 2, 'a batched build is two requests');
  assert.equal(result.finishReason, 'stop');
  const files = (await fsx.list(harness.projectId)).map((f) => f.path);
  for (const file of ['index.html', 'style.css', 'app.js', 'about.html', 'data.json']) {
    assert.ok(files.includes(file), `${file} written`);
  }
});

test('read-only calls in one message run together', async () => {
  const { harness, fsx, calls } = await makeHarness({
    script: [
      { toolCalls: ['a.txt', 'b.txt', 'c.txt'].map((file, i) => ({ id: `r${i}`, name: 'read', arguments: JSON.stringify({ file_path: file }) })) },
      { content: 'Read them.' },
    ],
  });
  for (const file of ['a.txt', 'b.txt', 'c.txt']) await fsx.write(harness.projectId, file, `contents of ${file}`);
  const started = [];
  harness.emit = ((original) => (event) => {
    if (event.type === 'tool_start') started.push(event.name);
    original(event);
  })(harness.emit);
  await harness.send('Read three files');
  assert.equal(calls.length, 2, 'three reads still cost one request');
  assert.equal(started.filter((name) => name === 'read').length, 3, 'all three reads ran');
});

test('the same read twice in one message is answered once', async () => {
  const dup = { name: 'read', arguments: JSON.stringify({ file_path: 'x.txt' }) };
  const { harness, fsx, events } = await makeHarness({
    script: [
      { toolCalls: [{ id: 'd1', ...dup }, { id: 'd2', ...dup }] },
      { content: 'Done.' },
    ],
  });
  await fsx.write(harness.projectId, 'x.txt', 'hello');
  await harness.send('Read x twice');
  const ends = events.filter((e) => e.type === 'tool_end');
  assert.equal(ends.length, 2, 'both calls are answered, so the transcript stays valid');
});

test('a productive turn extends past its first budget, up to the hard cap', async () => {
  // A model that always wants one more file: the classic runaway loop.
  const script = Array.from({ length: 40 }, (_, i) => ({
    toolCalls: [{ id: `w${i}`, name: 'write', arguments: JSON.stringify({ file_path: `f${i}.txt`, content: 'x' }) }],
  }));
  const { harness, calls, events } = await makeHarness({ script, settings: { requestBudget: 4 } });
  const result = await harness.send('Write forever');
  // 4 per segment × 3 segments: it kept going instead of stopping at the first
  // checkpoint, because the turn was making progress.
  assert.ok(calls.length > 4, `it kept working past the first segment (${calls.length})`);
  assert.ok(calls.length <= 12 + 2, `but the hard cap still stops it (${calls.length})`);
  assert.equal(result.finishReason, 'budget');
  assert.ok(events.some((e) => e.type === 'budget_extended'), 'the extension is reported');
  assert.ok(events.some((e) => e.type === 'budget_exhausted'));
});

test('auto-continue off stops a turn at its first budget', async () => {
  const script = Array.from({ length: 30 }, (_, i) => ({
    toolCalls: [{ id: `w${i}`, name: 'write', arguments: JSON.stringify({ file_path: `g${i}.txt`, content: 'x' }) }],
  }));
  const { harness, calls } = await makeHarness({ script, settings: { requestBudget: 4, autoContinue: false } });
  const result = await harness.send('Write forever');
  assert.equal(calls.length, 4, `stopped at the budget (made ${calls.length})`);
  assert.equal(result.finishReason, 'budget');
});

test('the budget note is attached where the model will read it', async () => {
  const { harness, calls } = await makeHarness({
    script: [
      { toolCalls: [{ id: 'w1', name: 'write', arguments: JSON.stringify({ file_path: 'a.txt', content: 'x' }) }] },
      { content: 'ok' },
    ],
    settings: { requestBudget: 2 },
  });
  await harness.send('write one file');
  assert.equal(calls.length, 2);
});

test('a context overflow compacts and retries instead of failing the turn', async () => {
  const { harness } = await makeHarness();
  let n = 0;
  harness.callModel = async () => {
    n += 1;
    harness.governor.used += 1;
    if (n === 1) throw Object.assign(new Error('context too long'), { contextOverflow: true });
    return { content: 'Recovered.', toolCalls: [], usage: {}, finishReason: 'stop' };
  };
  const result = await harness.send('too much history');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.text, 'Recovered.');
  assert.equal(n, 2, 'one retry after compacting, not a dead turn');
});

test('project rules and memory reach the prompt without a request', async () => {
  const { harness, fsx } = await makeHarness({ script: [{ content: 'ok' }] });
  await fsx.write(harness.projectId, '.alphacode/rules.md', 'Always use tabs.');
  await fsx.write(harness.projectId, '.alphacode/memory.md', 'The user prefers dark mode.');
  await harness.send('hello');
  assert.match(harness.systemPrompt(), /Always use tabs/);
  assert.match(harness.systemPrompt(), /prefers dark mode/);
});

test('a turn reuses the provider that just worked', async () => {
  const { governor, sleeps } = fakeGovernor();
  const attempts = [
    { provider: 'kilo', via: 'free' },
    { provider: 'groq', via: 'free' },
    { provider: 'demo', via: 'free' },
  ];
  const used = [];
  for (let turn = 0; turn < 3; turn++) {
    const ordered = governor.order(attempts);
    // Simulate "kilo worked" on the first turn only.
    if (turn === 0) governor.reward('kilo');
    used.push(ordered[0].provider);
  }
  assert.deepEqual(used, ['kilo', 'kilo', 'kilo'], 'no rotation once something works');
  assert.equal(sleeps.length, 0);
});

/* ── visual edits ─────────────────────────────────────────────────────── */

const { visualEditPrompt, visualEditSummary, VISUAL_ACTIONS } = await import('../web/engine/agent/visual.js');

test('a visual edit becomes one precise, single-file instruction', () => {
  const target = { selector: 'section.hero > h1', tag: 'h1', text: 'Welcome' };
  const prompt = visualEditPrompt(target, { action: 'text', value: 'Hello there' });
  assert.match(prompt, /<h1>/);
  assert.match(prompt, /section\.hero > h1/);
  assert.match(prompt, /"Hello there"/);
  assert.match(prompt, /one edit/i, 'it asks for an edit, not a rewrite');
});

test('each quick action says something different and specific', () => {
  const target = { selector: '#cta', tag: 'button' };
  const prompts = VISUAL_ACTIONS.map((action) => visualEditPrompt(target, { action: action.id, value: '12' }));
  assert.equal(new Set(prompts).size, VISUAL_ACTIONS.length, 'no two actions produce the same instruction');
  assert.match(visualEditPrompt(target, { action: 'space', value: '16' }), /16px/);
  assert.match(visualEditPrompt(target, { action: 'hide' }), /hide it/i);
  assert.match(visualEditPrompt(target, { action: 'delete' }), /delete it entirely/i);
  assert.match(visualEditPrompt({ tag: 'div' }, { action: 'text', value: 'x' }), /<div>/, 'works without a selector');
});

test('the toast summary names the element and the change', () => {
  const summary = visualEditSummary({ tag: 'h2' }, { action: 'color', value: '#fff' });
  assert.match(summary, /Colour of <h2>/);
  assert.match(summary, /#fff/);
});

/* ── conversation memory ──────────────────────────────────────────────── */

const { toModelMessages, historySummary } = await import('../web/engine/agent/history.js');

test('the saved transcript is replayed as model messages', () => {
  const rows = toModelMessages([
    { role: 'user', content: { text: 'build a pricing page' } },
    { role: 'assistant', content: { text: '', toolCalls: [{ id: 'c1', name: 'write', arguments: '{}' }] } },
    { role: 'tool', content: { toolCallId: 'c1', name: 'write', content: 'Wrote index.html' } },
    { role: 'assistant', content: { text: 'Done.' } },
    { role: 'user', content: { text: 'make it blue' } },
  ]);
  assert.equal(rows[0].role, 'user');
  assert.equal(rows[2].role, 'tool');
  assert.equal(rows[2].tool_call_id, 'c1');
  assert.equal(rows.length, 5);
});

test('orphaned tool messages and empty assistant rows are dropped', () => {
  const rows = toModelMessages([
    { role: 'tool', content: { toolCallId: 'ghost', name: 'read', content: 'x' } },
    { role: 'assistant', content: { text: '' } },
    { role: 'user', content: { text: 'hello' } },
  ]);
  assert.deepEqual(rows.map((r) => r.role), ['user'], 'the transcript stays provably valid');
});

test('the replay window starts on a user turn and old tool output shrinks', () => {
  const stored = [];
  for (let turn = 0; turn < 6; turn++) {
    stored.push({ role: 'user', content: { text: `request ${turn}` } });
    stored.push({ role: 'assistant', content: { toolCalls: [{ id: `c${turn}`, name: 'read', arguments: '{}' }] } });
    stored.push({ role: 'tool', content: { toolCallId: `c${turn}`, name: 'read', content: 'x'.repeat(4000) } });
  }
  const rows = toModelMessages(stored, { limit: 8, toolChars: 100, recentToolChars: 150 });
  assert.equal(rows[0].role, 'user', 'a provider-safe boundary');
  assert.ok(rows.length <= 8);
  const oldTool = rows.find((r) => r.role === 'tool');
  assert.ok(oldTool.content.length < 400, 'history does not re-send megabytes of tool output');
  assert.match(oldTool.content, /trimmed from history/);
});

test('the summary lists what the earlier turns asked for', () => {
  const summary = historySummary([
    { role: 'user', content: { text: 'build a shop' } },
    { role: 'user', content: { text: 'add a cart' } },
  ]);
  assert.match(summary, /build a shop/);
  assert.match(summary, /add a cart/);
});

/* ── self-verification ───────────────────────────────���────────────────── */

const { canVerify, verifyDecision: decideVerify, verificationPrompt: buildVerifyPrompt, keyOf: errorKey, verifySummary } = await import('../web/engine/agent/verify.js');

test('verification is skipped for turns that cannot benefit from it', () => {
  const base = { finishReason: 'stop', filesChanged: true, budgetLeft: 6 };
  assert.equal(canVerify(base), true);
  assert.equal(canVerify({ ...base, finishReason: 'stopped' }), false, 'the user stopped it');
  assert.equal(canVerify({ ...base, finishReason: 'budget' }), false, 'out of requests');
  assert.equal(canVerify({ ...base, filesChanged: false }), false, 'nothing changed');
  assert.equal(canVerify({ ...base, budgetLeft: 1 }), false, 'no room for a fix turn');
  assert.equal(canVerify({ ...base, verifyAlready: true }), false, 'once per turn');
  assert.equal(canVerify({ ...base, enabled: false }), false, 'switched off in settings');
});

test('verification only reacts to real errors it has not already fixed', () => {
  const errors = [{ kind: 'runtime', message: 'boom' }];
  const base = { finishReason: 'stop', filesChanged: true, budgetLeft: 6, errors };
  assert.equal(decideVerify(base).go, true);
  assert.equal(decideVerify({ ...base, errors: [] }).go, false);
  assert.equal(decideVerify({ ...base, errors: [{ kind: 'warn', message: 'deprecated' }] }).go, false, 'warnings are not bugs');
  const seen = new Set([errorKey(errors[0])]);
  assert.equal(decideVerify({ ...base, seen }).go, false, 'the same error is never fixed twice');
  assert.equal(decideVerify({ ...base, seen, errors: [...errors, { kind: 'runtime', message: 'other' }] }).go, true, 'but a new one is');
});

test('the fix instruction is a bug report with the stack attached', () => {
  const prompt = buildVerifyPrompt([{ message: 'x is undefined', where: 'line 4', stack: 'at render (a.js:4:1)' }], { where: 'preview' });
  assert.match(prompt, /preview is throwing/i);
  assert.match(prompt, /x is undefined/);
  assert.match(prompt, /line 4/);
  assert.match(prompt, /at render/);
  assert.match(prompt, /do not rewrite the whole project/i);
});

test('the same error with a different line number counts as the same error', () => {
  assert.equal(errorKey({ message: 'boom:12:4' }), errorKey({ message: 'boom:88:2' }));
  assert.notEqual(errorKey({ message: 'boom', kind: 'console' }), errorKey({ message: 'boom', kind: 'runtime' }));
});

test('the activity line says what was fixed', () => {
  assert.match(verifySummary([{ message: 'a' }, { message: 'b' }]), /Caught 2 preview errors/);
  assert.match(verifySummary([]), /clean/);
});

/* ── multi-item tools: several operations per request ─────────────────── */

const { buildTools } = await import('../web/engine/tools.js');
const { renderScaffold, SCAFFOLDS, SCAFFOLD_IDS } = await import('../web/engine/agent/scaffolds.js');

async function toolBox() {
  const fsx = new FileSystem(new MemoryFs());
  const store = new Store(new MemoryBackend());
  const { project } = await store.createProject({ name: 'Tools' });
  const shell = new Shell({ fs: fsx, projectId: project.id });
  const tools = buildTools({
    fs: fsx,
    store,
    projectId: project.id,
    shell,
    getDb: async () => ({}),
    releaseDb: () => {},
    emit: () => {},
    confirm: async () => ({ approved: true }),
    runtimeInfo: () => ({}),
  });
  const get = (name) => tools.find((t) => t.name === name);
  return { fsx, project, get, tools };
}

test('write_many writes every file in one call and reports one changeset', async () => {
  const { fsx, project, get } = await toolBox();
  const out = await get('write_many').run({
    files: [
      { file_path: 'index.html', content: '<h1>hi</h1>' },
      { file_path: 'style.css', content: 'body{}' },
      { file_path: 'src/app.js', content: 'console.log(1)' },
    ],
  });
  assert.equal(out.isError, undefined);
  assert.equal(out.display.kind, 'diff-many');
  assert.equal(out.display.files.length, 3);
  for (const path of ['index.html', 'style.css', 'src/app.js']) {
    assert.ok(await fsx.exists(project.id, path), `${path} written`);
  }
  assert.match(out.text, /Created index\.html/);
});

test('read_many reads several files in one call, with a shared budget', async () => {
  const { fsx, project, get } = await toolBox();
  await fsx.write(project.id, 'a.js', 'const a = 1;');
  await fsx.write(project.id, 'b.js', 'const b = 2;');
  const out = await get('read_many').run({ paths: ['a.js', 'b.js', 'missing.js'] });
  assert.equal(out.display.kind, 'read-many');
  assert.match(out.text, /### a\.js/);
  assert.match(out.text, /const a = 1/);
  assert.match(out.text, /### b\.js/);
  assert.match(out.text, /not found/, 'a missing file is reported, not fatal');
  assert.ok(out.text.length < 12_000, 'the shared budget keeps the result small');
});

test('scaffold writes a complete working app for zero output tokens', async () => {
  const { fsx, project, get } = await toolBox();
  const out = await get('scaffold').run({ kind: 'landing', brand: 'Kestrel' });
  assert.equal(out.display.kind, 'scaffold');
  assert.deepEqual(Array.from(out.display.files), ['index.html', 'style.css', 'app.js']);
  const html = await fsx.readText(project.id, 'index.html');
  const css = await fsx.readText(project.id, 'style.css');
  const js = await fsx.readText(project.id, 'app.js');
  assert.match(html, /<h1>/, 'real markup');
  assert.match(html, /Kestrel/, 'the brand is applied');
  assert.ok(css.length > 2000, 'real styling');
  assert.match(js, /addEventListener/, 'real behaviour');
  // Everything is self-contained: no network at runtime.
  assert.ok(!/<script[^>]+src="http/i.test(html), 'no CDN scripts');
  assert.ok(!/@import\s+url\(/i.test(css), 'no remote fonts');
});

test('every scaffold is complete, responsive and offline', () => {
  for (const id of SCAFFOLD_IDS) {
    const { files } = renderScaffold(id);
    assert.deepEqual(Object.keys(files).sort(), ['app.js', 'index.html', 'style.css'], `${id} has the full set`);
    assert.match(files['index.html'], /<meta name="viewport"/, `${id} is responsive`);
    assert.match(files['style.css'], /@media/, `${id} has breakpoints`);
    assert.match(files['index.html'], /<title>/, `${id} has a title`);
    assert.ok(files['app.js'].length > 400, `${id} has behaviour`);
    assert.ok(SCAFFOLDS[id].blurb.length > 20);
  }
});

test('an unknown scaffold fails with the list of real ones', async () => {
  const { get } = await toolBox();
  const out = await get('scaffold').run({ kind: 'kubernetes' });
  assert.equal(out.isError, true);
  assert.match(out.text, /landing/);
});

test('the new tools are read-only or mutating where they should be', async () => {
  const { get } = await toolBox();
  assert.equal(get('read_many').readOnly, true);
  assert.equal(get('write_many').mutating, true);
  assert.equal(get('scaffold').mutating, true);
});

test('a turn that writes with write_many marks every file as changed', async () => {
  const { harness } = await makeHarness({
    script: [
      {
        toolCalls: [
          {
            id: 'wm',
            name: 'write_many',
            arguments: JSON.stringify({
              files: [
                { file_path: 'index.html', content: '<h1>x</h1>' },
                { file_path: 'style.css', content: 'h1{}' },
              ],
            }),
          },
        ],
      },
      { content: 'done' },
    ],
  });
  await harness.send('build two files');
  assert.deepEqual([...harness.filesChanged].sort(), ['index.html', 'style.css']);
});

/* ── autonomy: a turn that keeps going ────────────────────────────────── */

test('a turn may borrow extra segments, but never past the hard cap', () => {
  const { governor } = fakeGovernor({ budget: 4, hardCap: 10 });
  assert.equal(governor.headroom, 6, 'room to grow from the current budget');
  assert.equal(governor.extend(4), 4, 'the first borrow is granted');
  assert.equal(governor.budget, 8);
  assert.equal(governor.extend(4), 2, 'the second is clipped to the cap');
  assert.equal(governor.budget, 10);
  assert.equal(governor.extend(4), 0, 'and then it refuses');
  assert.equal(governor.headroom, 0);
});

test('extending does not reset the rate window', async () => {
  const { governor } = fakeGovernor({ budget: 2, hardCap: 20, maxPerWindow: 1, windowMs: 60_000, maxWaitMs: 0 });
  assert.equal(await governor.reserve('kilo'), true);
  governor.extend(2);
  // More budget, but the provider's one-per-minute window is still closed.
  assert.equal(await governor.reserve('kilo'), false, 'the window still protects the provider');
});

/**
 * The request governor.
 *
 * An agent turn is a loop of model requests, and free tiers are small: a
 * handful of requests a minute. The old loop treated every failure the same
 * way — try the next provider immediately — so one rate limit turned into a
 * burst that hit every provider in turn and left the whole chain cooling down.
 * A turn that needed 12 requests would exhaust a shared free allowance and the
 * next turn would start from nothing.
 *
 * This module makes the request pattern deliberate:
 *
 *   1. **Classify the failure.** A 429 is not a 401. A 503 is not "the model
 *      name is wrong". Only genuinely retryable failures are retried, and each
 *      kind gets its own cooldown.
 *   2. **Respect the clock they give us.** `Retry-After` and
 *      `x-ratelimit-reset` are honoured; otherwise a per-provider exponential
 *      backoff applies, with jitter so parallel tabs do not synchronise.
 *   3. **Stay on the provider that worked.** Rotating after every successful
 *      call is how a working provider gets rate-limited for no reason. The
 *      last good provider is tried first until it actually fails.
 *   4. **Cap the rate, not just the count.** A sliding window per provider
 *      keeps a fast tool loop inside what the tier allows, instead of firing
 *      twelve requests and discovering the limit.
 *   5. **Budget the turn.** Every request costs one unit; the turn stops
 *      cleanly when the budget is gone instead of hammering on.
 *
 * Everything is injectable (`now`, `sleep`, storage) so all of it is testable
 * without a network or a browser.
 */

/** Failure kinds, in the language the rest of the app speaks. */
export const ERROR_KINDS = {
  rate_limit: { retryable: true, cooldown: 30_000, label: 'rate limited' },
  server: { retryable: true, cooldown: 8_000, label: 'provider error' },
  network: { retryable: true, cooldown: 6_000, label: 'unreachable' },
  timeout: { retryable: true, cooldown: 5_000, label: 'timed out' },
  auth: { retryable: false, cooldown: 30 * 60_000, label: 'bad credentials' },
  quota: { retryable: false, cooldown: 30 * 60_000, label: 'out of credit' },
  model: { retryable: false, cooldown: 15 * 60_000, label: 'model unavailable' },
  context: { retryable: true, cooldown: 0, label: 'context too long' },
  unknown: { retryable: true, cooldown: 4_000, label: 'failed' },
};

const KIND_BY_STATUS = {
  400: 'context',
  401: 'auth',
  402: 'quota',
  403: 'auth',
  404: 'model',
  408: 'timeout',
  413: 'context',
  422: 'context',
  429: 'rate_limit',
  500: 'server',
  502: 'server',
  503: 'server',
  504: 'timeout',
  529: 'server',
};

const RATE_LIMIT_TEXT = /rate.?limit|too many requests|requests per (minute|day)|quota exceeded|resource.?exhausted|slow down|throttl/i;
const AUTH_TEXT = /invalid api key|unauthorized|authentication|api key not valid|incorrect api key|invalid_api_key/i;
const CONTEXT_TEXT = /context (length|window)|too many tokens|maximum context|prompt is too long|exceeds.*token/i;
const MODEL_TEXT =
  /model .*(not found|does not exist|unsupported|unavailable|not available)|(not found|no such|unknown|invalid|unsupported|unavailable) model|no such model|unknown model|decommissioned model/i;

/**
 * Work out what kind of failure this is and how long to stay away.
 *
 * Providers throw plain `Error`s with a status attached (see providers.js), so
 * this reads the status first and falls back to the message, because several
 * free routers return 200-shaped errors with a message and no code.
 *
 * @param {Error & {status?: number, retryAfterMs?: number, provider?: string}} error
 * @returns {{kind: string, retryable: boolean, cooldownMs: number, status: number, retryAfterMs: number|null, label: string, message: string}}
 */
export function classifyProviderError(error) {
  const message = String(error?.message || error || '');
  const status = Number(error?.status) || 0;
  let kind = KIND_BY_STATUS[status] || '';

  if (!kind) {
    if (RATE_LIMIT_TEXT.test(message)) kind = 'rate_limit';
    else if (CONTEXT_TEXT.test(message)) kind = 'context';
    else if (AUTH_TEXT.test(message)) kind = 'auth';
    else if (MODEL_TEXT.test(message)) kind = 'model';
    else if (/abort|stopped/i.test(message)) kind = 'unknown';
    else kind = 'unknown';
  }
  // A 400 that mentions tokens is a context problem, not a bad request; a 429
  // that mentions keys is still a rate limit. The text refines, it does not
  // overrule, except for the two cases below.
  if (kind === 'context' && RATE_LIMIT_TEXT.test(message)) kind = 'rate_limit';
  if (kind === 'unknown' && /network|unreachable|failed to fetch|load failed/i.test(message)) kind = 'network';

  const meta = ERROR_KINDS[kind] || ERROR_KINDS.unknown;
  const retryAfterMs = Number.isFinite(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : null;
  return {
    kind,
    retryable: meta.retryable,
    cooldownMs: meta.cooldown,
    label: meta.label,
    status,
    retryAfterMs,
    message,
  };
}

/** Parse `Retry-After` (seconds or an HTTP date) and the usual reset headers. */
export function readRetryAfter(headers, now = Date.now()) {
  if (!headers?.get) return null;
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const when = Date.parse(retryAfter);
    if (Number.isFinite(when)) return Math.max(0, when - now);
  }
  for (const name of ['x-ratelimit-reset-requests', 'x-ratelimit-reset', 'ratelimit-reset']) {
    const raw = headers.get(name);
    if (!raw) continue;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) {
      // Some providers send a unix timestamp, some a delta. Anything past the
      // year 2000 in seconds is clearly a timestamp.
      return seconds > 946_684_800 ? Math.max(0, seconds * 1000 - now) : Math.max(0, seconds * 1000);
    }
  }
  return null;
}

const jitter = (ms) => Math.round(ms * (0.85 + Math.random() * 0.3));

/**
 * Per-provider health, a global budget, and the waiting.
 *
 * One instance lives with the page (see `getGovernor`), so a cooldown learned
 * in one turn is still respected in the next one instead of being forgotten and
 * re-learned by burning another request.
 */
export class RequestGovernor {
  /**
   * @param {object} [options]
   * @param {number} [options.budget]         requests allowed in this turn
   * @param {number} [options.maxPerWindow]   requests per minute per free provider
   * @param {number} [options.maxPerWindowByok] same, for a provider with the user's own key
   * @param {number} [options.windowMs]       the sliding window
   * @param {number} [options.maxWaitMs]      longest we will sit and wait for a slot
   * @param {() => number} [options.now]
   * @param {(ms:number, signal?:AbortSignal) => Promise<void>} [options.sleep]
   */
  constructor({
    budget = 24,
    hardCap = 24,
    maxPerWindow = 10,
    maxPerWindowByok = 40,
    windowMs = 60_000,
    maxWaitMs = 8_000,
    maxCooldownMs = 30 * 60_000,
    now = () => Date.now(),
    sleep = null,
  } = {}) {
    this.now = now;
    this._sleep = sleep || ((ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('stopped', 'AbortError'));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener?.('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('stopped', 'AbortError'));
      }, { once: true });
    }));
    this.budget = budget;
    // A turn may borrow against the hard cap (see `extend`): the per-turn number
    // is a checkpoint, not a wall, and the rate window is what actually protects
    // the provider.
    this.hardCap = hardCap;
    this.maxPerWindow = maxPerWindow;
    this.maxPerWindowByok = maxPerWindowByok;
    this.windowMs = windowMs;
    this.maxWaitMs = maxWaitMs;
    this.maxCooldownMs = maxCooldownMs;
    this.used = 0;
    this.health = new Map(); // provider -> { until, failures, hits: number[], lastOk, reason }
    this.sticky = '';
    this.stats = { attempts: 0, skippedCooldown: 0, waitedMs: 0, failovers: 0 };
  }

  entry(provider) {
    let row = this.health.get(provider);
    if (!row) {
      row = { until: 0, failures: 0, hits: [], lastOk: 0, reason: '' };
      this.health.set(provider, row);
    }
    return row;
  }

  /** Requests left in this turn. */
  get remaining() {
    return Math.max(0, this.budget - this.used);
  }

  /**
   * Requests left before the hard cap.
   *
   * Measured against whichever is further along — requests actually spent, or
   * budget already granted — so repeated extensions cannot creep past the cap.
   */
  get headroom() {
    return Math.max(0, this.hardCap - Math.max(this.used, this.budget));
  }

  /**
   * Give a turn that is still making progress more room — up to the hard cap.
   *
   * The point of the per-turn budget is to stop runaway loops, not to stop an
   * agent mid-build. If the turn is advancing (it ran tools and asked for more),
   * borrowing another segment is correct *provided* the rate window still has
   * capacity; `reserve()` enforces that on every request anyway.
   *
   * @param {number} [step] requests to add
   * @returns {number} how many were actually granted (0 when the cap is reached)
   */
  extend(step = 8) {
    const granted = Math.min(step, this.headroom);
    if (granted <= 0) return 0;
    this.budget += granted;
    this.stats.extensions = (this.stats.extensions || 0) + 1;
    return granted;
  }

  /** ms until this provider is usable again (0 = now). */
  cooldownFor(provider) {
    const row = this.entry(provider);
    return Math.max(0, row.until - this.now());
  }

  available(provider) {
    return this.cooldownFor(provider) === 0;
  }

  /**
   * Record a failure and take the provider out of rotation for a while.
   * @returns {number} the cooldown applied
   */
  penalize(provider, classification, { byok = false } = {}) {
    const row = this.entry(provider);
    row.failures += 1;
    row.reason = classification.kind;

    let wait = classification.cooldownMs;
    if (classification.kind === 'rate_limit') {
      // Trust the provider's own number when it gives one.
      const hinted = classification.retryAfterMs ?? null;
      const backoff = 15_000 * 2 ** Math.min(4, row.failures - 1);
      wait = hinted != null ? Math.max(hinted, 2_000) : backoff;
      // A BYOK key is the user's money: retry it sooner than a shared free tier.
      if (byok) wait = Math.min(wait, 10_000);
    } else if (classification.kind === 'server' || classification.kind === 'network' || classification.kind === 'timeout') {
      wait = classification.cooldownMs * Math.min(3, row.failures);
    }
    wait = Math.min(this.maxCooldownMs, Math.max(0, jitter(wait)));
    row.until = this.now() + wait;
    if (this.sticky === provider) this.sticky = '';
    this.stats.failovers += 1;
    return wait;
  }

  /** The provider answered. Forget its backoff and prefer it next time. */
  reward(provider) {
    const row = this.entry(provider);
    row.failures = 0;
    row.until = 0;
    row.reason = '';
    row.lastOk = this.now();
    row.hits.push(this.now());
    this.sticky = provider;
  }

  /** Trim the sliding window and report how many slots are used. */
  windowUsage(provider, { byok = false } = {}) {
    const row = this.entry(provider);
    const cutoff = this.now() - this.windowMs;
    row.hits = row.hits.filter((t) => t > cutoff);
    const limit = byok ? this.maxPerWindowByok : this.maxPerWindow;
    return { used: row.hits.length, limit, full: row.hits.length >= limit };
  }

  /** ms until a slot frees up, or 0 if one is available now. */
  waitForSlot(provider, { byok = false } = {}) {
    const { used, limit } = this.windowUsage(provider, { byok });
    if (used < limit) return 0;
    const row = this.entry(provider);
    const oldest = row.hits[0] || this.now();
    return Math.max(0, oldest + this.windowMs - this.now());
  }

  /**
   * Wait for a rate-limit slot (bounded), then record the request.
   *
   * Returns false when the wait would be longer than we are willing to sit
   * there — the caller should fail over or stop instead of stalling the turn.
   */
  async reserve(provider, { byok = false, signal } = {}) {
    if (this.remaining <= 0) return false;
    const wait = this.waitForSlot(provider, { byok });
    if (wait > 0) {
      if (wait > this.maxWaitMs) return false;
      const started = this.now();
      await this._sleep(wait, signal);
      this.stats.waitedMs += this.now() - started;
    }
    this.used += 1;
    this.stats.attempts += 1;
    this.entry(provider).hits.push(this.now());
    return true;
  }

  /**
   * Order the attempt list for one call.
   *
   * BYOK providers always come first — the user is paying, so their key should
   * not lose to a shared free tier. Within each group the sticky provider wins,
   * then whoever is available, and providers in a long cooldown (bad key, no
   * credit, unknown model) are dropped rather than retried.
   */
  order(attempts = [], { dropAfterMs = 5 * 60_000 } = {}) {
    const scored = attempts.map((attempt, index) => {
      const cooldown = this.cooldownFor(attempt.provider);
      return { attempt, index, cooldown, byok: attempt.via === 'byok' };
    });
    return scored
      .filter((row) => row.cooldown < dropAfterMs)
      .sort((a, b) => {
        if (a.byok !== b.byok) return a.byok ? -1 : 1;
        if (a.cooldown !== b.cooldown) return a.cooldown - b.cooldown;
        const aSticky = this.sticky === a.attempt.provider ? 0 : 1;
        const bSticky = this.sticky === b.attempt.provider ? 0 : 1;
        if (aSticky !== bSticky) return aSticky - bSticky;
        return a.index - b.index;
      })
      .map((row) => row.attempt);
  }

  /** Everything the UI wants to show about request pressure. */
  snapshot() {
    const providers = [...this.health.entries()]
      .map(([provider, row]) => ({
        provider,
        cooldownMs: Math.max(0, row.until - this.now()),
        failures: row.failures,
        reason: row.reason,
        window: this.windowUsage(provider).used,
      }))
      .filter((row) => row.cooldownMs > 0 || row.window > 0);
    return {
      budget: this.budget,
      hardCap: this.hardCap,
      used: this.used,
      remaining: this.remaining,
      headroom: this.headroom,
      sticky: this.sticky,
      providers,
      ...this.stats,
    };
  }

  /** Forget cooldowns (the "try again now" button). */
  reset({ keepBudget = false } = {}) {
    for (const row of this.health.values()) {
      row.until = 0;
      row.failures = 0;
      row.hits = [];
      row.reason = '';
    }
    if (!keepBudget) this.used = 0;
  }

  /** Persist only what is worth remembering between page loads. */
  serialize() {
    const now = this.now();
    const cooldowns = {};
    for (const [provider, row] of this.health) {
      if (row.until > now) cooldowns[provider] = { until: row.until, failures: row.failures, reason: row.reason };
    }
    return { cooldowns, sticky: this.sticky, now };
  }

  restore(state = {}) {
    const now = this.now();
    this.sticky = state.sticky || '';
    for (const [provider, row] of Object.entries(state.cooldowns || {})) {
      if (!row || row.until <= now) continue;
      const entry = this.entry(provider);
      entry.until = Math.min(row.until, now + this.maxCooldownMs);
      entry.failures = Number(row.failures) || 1;
      entry.reason = row.reason || 'rate_limit';
    }
    return this;
  }
}

/** One governor per page, so cooldowns outlive a single turn. */
let shared = null;
export function getGovernor(options = {}) {
  if (!shared) shared = new RequestGovernor(options);
  return shared;
}
export function setGovernor(instance) {
  shared = instance;
  return shared;
}

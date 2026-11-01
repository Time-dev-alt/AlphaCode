/**
 * Model routing policy — the product rules for AlphaCode.
 *
 *  Guest (no login)      → Kilo `kilo-auto/free`, no key, free forever.
 *                         BYOK is allowed and takes priority.
 *  Signed-in, no BYOK    → 40 agent requests/day on platform keys:
 *                          OpenRouter → OpenCode Zen → Google AI Studio,
 *                          then automatically falls back to Kilo free.
 *  Signed-in with BYOK   → user's key + model, no platform quota consumed.
 */
import { config } from './config.mjs';
import { getStore, today } from './lib/store.mjs';
import { platformConfigured } from './providers/index.mjs';
import { tooMany } from './lib/http.mjs';

export const DEFAULT_CHAIN = {
  openrouter: ['openrouter/free'],
  opencode: ['big-pickle'],
  google: ['gemini-2.5-flash'],
  kilo: [config.guestModel],
};

const GUEST_ALLOWED_PROVIDERS = new Set(['kilo', 'opencode']);

export function parseModelRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const trimmed = ref.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return null;
  const provider = trimmed.slice(0, slash);
  const model = trimmed.slice(slash + 1);
  if (!model) return null;
  return { provider, model };
}

export function quotaKeyFor(ctx) {
  return ctx.user ? `user:${ctx.user.id}` : `guest:${ctx.session?.id || 'anon'}`;
}

export function quotaState(ctx, used) {
  const limit = ctx.user ? config.dailyRequests : null;
  return {
    limited: Boolean(limit),
    limit,
    used,
    remaining: limit === null ? null : Math.max(0, limit - used),
    resetsAt: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(),
    unlimited: !limit,
  };
}

export function currentUsage(ctx) {
  const store = getStore();
  const key = quotaKeyFor(ctx);
  return store.getQuota(key, today());
}

export function assertQuota(ctx, cost = 1) {
  if (!ctx.user) return quotaState(ctx, 0);
  const usage = currentUsage(ctx);
  if (usage.turns + cost > config.dailyRequests) {
    const err = tooMany(
      `Daily limit reached (${config.dailyRequests} requests). Add your own API key for unlimited use, or continue on the free Kilo router tomorrow.`,
      'daily_limit',
    );
    err.detail = { limit: config.dailyRequests, used: usage.turns, resetsAt: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString() };
    throw err;
  }
  return quotaState(ctx, usage.turns);
}

export function bumpUsage(ctx, { turns = 0, calls = 0, tokens = 0 }) {
  const store = getStore();
  return store.bumpQuota(quotaKeyFor(ctx), { turns, calls, tokens });
}

export function byokFor(settings, provider) {
  const byok = settings?.byokParsed || {};
  const entry = byok[provider];
  if (!entry || !entry.key) return null;
  return { provider, key: entry.key, baseUrl: entry.baseUrl || '', model: entry.model || '' };
}

export function anyByok(settings) {
  const byok = settings?.byokParsed || {};
  return Object.keys(byok).filter((p) => byok[p]?.key);
}

/**
 * Build the ordered candidate list for a turn.
 * `requested` is a `provider/model` string from the UI (optional).
 */
export function planModelRequest(ctx, { settings, requested } = {}) {
  const candidates = [];
  const push = (c) => {
    if (!c || !c.provider) return;
    if (candidates.some((x) => x.provider === c.provider && x.model === c.model)) return;
    candidates.push(c);
  };

  const parsed = parseModelRef(requested);
  const byokProviders = anyByok(settings);

  // 1. Explicit BYOK provider selected in the picker.
  if (parsed && byokProviders.includes(parsed.provider)) {
    push({ provider: parsed.provider, model: parsed.model, apiKey: byokFor(settings, parsed.provider).key, baseUrl: byokFor(settings, parsed.provider).baseUrl, via: 'byok' });
  }

  // 2. Explicit platform model (free only).
  if (parsed && !PROTECTED.has(parsed.provider) && platformConfigured(parsed.provider)) {
    if (ctx.user || GUEST_ALLOWED_PROVIDERS.has(parsed.provider)) {
      push({ provider: parsed.provider, model: parsed.model, via: ctx.user ? 'platform' : 'guest' });
    }
  }

  // 3. Any BYOK key set to "use everywhere".
  for (const p of byokProviders) {
    const entry = byokFor(settings, p);
    if (!entry) continue;
    push({
      provider: p,
      model: entry.model || (parsed?.provider === p ? parsed.model : '') || '',
      apiKey: entry.key,
      baseUrl: entry.baseUrl,
      via: 'byok',
      needsModel: !entry.model && parsed?.provider !== p,
    });
  }

  if (config.mock) {
    push({ provider: 'mock', model: parsed?.model || 'demo-1', via: 'demo' });
  }

  if (ctx.user) {
    // 4. Platform chain: OpenRouter → OpenCode → Google AI Studio → Kilo.
    for (const provider of ['openrouter', 'opencode', 'google']) {
      if (!platformConfigured(provider)) continue;
      for (const model of DEFAULT_CHAIN[provider]) {
        push({ provider, model, via: 'platform' });
      }
    }
  }

  // 5. Always-available free floor.
  for (const model of DEFAULT_CHAIN.kilo) push({ provider: 'kilo', model, via: ctx.user ? 'fallback' : 'guest' });

  return candidates.filter((c) => c.model || c.needsModel);
}

const PROTECTED = new Set(['openrouter', 'opencode', 'google', 'kilo']);

const FALLBACK_ON = new Set(['rate_limited', 'network', 'http_error', 'no_base', 'empty']);

export function shouldFallback(err) {
  if (!err) return false;
  if (err.code === 'unauthorized') return true; // bad/missing key → next provider
  return FALLBACK_ON.has(err.code) || err.retryable === true || err.status === 402;
}

export function describeRouting(ctx, settings) {
  const usage = currentUsage(ctx);
  const byok = anyByok(settings || {});
  return {
    tier: ctx.user ? 'pro' : 'guest',
    signedIn: Boolean(ctx.user),
    byok,
    quota: quotaState(ctx, usage.turns),
    chain: ctx.user
      ? ['openrouter', 'opencode', 'google', 'kilo'].filter((p) => platformConfigured(p))
      : ['kilo'],
    defaultModel: ctx.user
      ? platformConfigured('openrouter')
        ? `openrouter/${DEFAULT_CHAIN.openrouter[0]}`
        : platformConfigured('opencode')
          ? `opencode/${DEFAULT_CHAIN.opencode[0]}`
          : platformConfigured('google')
            ? `google/${DEFAULT_CHAIN.google[0]}`
            : `kilo/${config.guestModel}`
      : `kilo/${config.guestModel}`,
  };
}

/** Free-only catalogue exposed to the model picker. */
export async function buildModelCatalog(ctx, settings) {
  const { listModels, PROVIDER_META } = await import('./providers/index.mjs');
  const providers = [];
  const byok = settings?.byokParsed || {};

  for (const id of ['openrouter', 'opencode', 'google', 'kilo']) {
    if (!ctx.user && !GUEST_ALLOWED_PROVIDERS.has(id)) continue;
    const configured = platformConfigured(id);
    if (!configured) {
      providers.push({ id, label: PROVIDER_META[id].label, available: false, reason: 'No platform key configured', models: [] });
      continue;
    }
    const models = await listModels(id, { apiKey: id === 'opencode' ? 'public' : undefined });
    providers.push({
      id,
      label: PROVIDER_META[id].label,
      available: true,
      free: true,
      models: models.map((m) => ({ ...m, ref: `${id}/${m.id}` })),
    });
  }

  for (const [id, entry] of Object.entries(byok)) {
    if (!entry?.key) continue;
    const meta = PROVIDER_META[id];
    if (!meta) continue;
    const models = await listModels(id, { apiKey: entry.key, baseUrl: entry.baseUrl });
    providers.push({
      id,
      label: meta.label,
      available: true,
      byok: true,
      models: models.map((m) => ({ ...m, ref: `${id}/${m.id}` })),
    });
  }
  return providers;
}

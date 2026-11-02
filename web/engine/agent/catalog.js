/**
 * Model discovery.
 *
 * Every OpenAI-compatible provider exposes `GET {base}/models`, but the
 * responses differ enough that "just fetch it" is not enough: some return
 * `{data:[...]}`, some a bare array, some nest pricing and context windows under
 * provider-specific keys, and the free routers publish models that come and go
 * weekly. This module normalises all of it into one shape, caches it, and falls
 * back to a curated list when the endpoint is unreachable (offline, CORS, guest
 * network) so the picker is never empty.
 *
 * Kilo is special-cased because it is AlphaCode's default: its catalog is the
 * source of truth for what the free router can actually reach *right now*, so
 * the app asks it once per session and remembers the answer.
 */

/** Curated fallbacks — used when the catalog cannot be fetched. */
export const FALLBACK_CATALOG = {
  kilo: [
    { id: 'kilo-auto/free', name: 'Kilo Auto (best free router)', context: 256_000, free: true, note: 'Router picks the best available free model' },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra 550B', context: 1_000_000, free: true },
    { id: 'cohere/north-mini-code:free', name: 'North Mini Code', context: 256_000, free: true, note: 'Fast at code' },
    { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super 120B', context: 262_000, free: true },
    { id: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron 3.5 Lightning', context: 1_000_000, free: true },
    { id: 'stepfun/step-3.7-flash:free', name: 'Step 3.7 Flash', context: 262_000, free: true },
    { id: 'poolside/laguna-s-2.1:free', name: 'Laguna S 2.1', context: 262_000, free: true },
    { id: 'minimax/minimax-m2.5:free', name: 'MiniMax M2.5', context: 196_000, free: true },
  ],
  opencode: [
    { id: 'big-pickle', name: 'Big Pickle', context: 200_000, free: true },
    { id: 'minimax-m2.5-free', name: 'MiniMax M2.5', context: 204_800, free: true },
    { id: 'nemotron-3-super-free', name: 'Nemotron 3 Super', context: 204_800, free: true },
    { id: 'mimo-v2.5-free', name: 'MiMo V2.5', context: 131_072, free: true },
  ],
  openrouter: [
    { id: 'openrouter/free', name: 'OpenRouter free router', context: 200_000, free: true },
    { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder', context: 262_144, free: true },
    { id: 'deepseek/deepseek-chat-v3.1:free', name: 'DeepSeek V3.1', context: 163_840, free: true },
  ],
  google: [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', context: 1_000_000, free: true },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', context: 1_000_000, free: true },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', context: 1_000_000, free: true },
  ],
  openai: [
    { id: 'gpt-4o-mini', name: 'GPT-4o mini', context: 128_000 },
    { id: 'gpt-4.1', name: 'GPT-4.1', context: 1_000_000 },
    { id: 'o4-mini', name: 'o4-mini', context: 200_000 },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', context: 200_000 },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', context: 200_000 },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', context: 131_072 },
    { id: 'qwen/qwen3-32b', name: 'Qwen3 32B', context: 131_072 },
  ],
  deepseek: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', context: 128_000 }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', context: 128_000 }],
  mistral: [{ id: 'mistral-large-latest', name: 'Mistral Large', context: 131_072 }, { id: 'codestral-latest', name: 'Codestral', context: 262_144 }],
  xai: [{ id: 'grok-4', name: 'Grok 4', context: 256_000 }, { id: 'grok-code-fast-1', name: 'Grok Code Fast', context: 256_000 }],
  together: [{ id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Turbo', context: 131_072 }],
};

/** Heuristics that are good enough to label a catalog entry. */
export const isFreeId = (id) => /:free\b|[-/]free\b|free$/i.test(String(id || ''));

const CODEY = /coder|code|devstral|codestral|laguna|north-mini|grok-code|qwen|deepseek|nemotron|sonnet|gpt-4\.1|gpt-5/i;
const HUGE = /ultra|550b|max|large|opus/i;

/**
 * Rank a free model for coding work.
 *
 * The router's own opinion comes first (`kilo-auto/free` exists precisely to
 * make this choice), then coding-tuned models, then size. The point is that the
 * fallback order is deterministic and explainable rather than "whatever the API
 * returned first".
 */
export function rankModel(model) {
  let score = 0;
  if (/kilo-auto\/free|openrouter\/free/.test(model.id)) score += 1000;
  if (CODEY.test(model.id)) score += 60;
  if (HUGE.test(model.id)) score += 25;
  if (isFreeId(model.id)) score += 20;
  if (/vision|audio|image|embed|whisper|tts|content-safety|moderation/i.test(model.id)) score -= 200;
  score += Math.min(30, Math.round((model.context || 0) / 32_000));
  return score;
}

/** Pick the models worth trying, best first. Never more than `limit`. */
export function bestModels(models = [], { limit = 4, freeOnly = true } = {}) {
  const list = (freeOnly ? models.filter((m) => m.free !== false && isFreeId(m.id)) : models)
    .map((m) => ({ ...m, score: rankModel(m) }))
    .sort((a, b) => b.score - a.score);
  return list.slice(0, limit);
}

/** Normalise one provider's `/models` response into `{id,name,context,free}`. */
export function normalizeModels(payload, provider = '') {
  const rows = Array.isArray(payload) ? payload : payload?.data || payload?.models || [];
  return rows
    .map((row) => {
      const id = String(row?.id || row?.name || row?.model || '').trim();
      if (!id) return null;
      const context =
        Number(row?.context_length || row?.context_window || row?.max_context_length || row?.top_provider?.context_length || row?.limit?.context || 0) || 0;
      return {
        id,
        name: String(row?.name || row?.display_name || id).slice(0, 60),
        context,
        free: provider === 'kilo' || provider === 'opencode' ? isFreeId(id) || id === 'big-pickle' : isFreeId(id) || Boolean(row?.free),
      };
    })
    .filter(Boolean)
    .filter((model, index, all) => all.findIndex((other) => other.id === model.id) === index);
}

/**
 * Routers that also exist as a same-origin relay (`functions/api/llm`).
 * Only keyless routers: a relayed request never carries a credential.
 */
export const RELAY_ROUTERS = { kilo: 'kilo', opencode: 'opencode' };

/** Same-origin path for a relayed model list, or '' when there is no relay. */
export const relayModelsUrl = (provider) => {
  const relay = RELAY_ROUTERS[provider];
  return relay ? `/api/llm/${relay}/models` : '';
};

/** Where the catalog lives for a provider. */
export function modelsUrl(provider, { baseUrl = '', key = '', relay = false } = {}) {
  // A keyless router asked through the relay goes same-origin: that is the path
  // that works on the devices whose network mangles a cross-origin request.
  if (relay && !key && RELAY_ROUTERS[provider]) return relayModelsUrl(provider);
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (!root) return '';
  // Anthropic does not implement /models for the messages API.
  if (provider === 'anthropic' && !baseUrl) return '';
  return `${root}/models`;
}

/**
 * Fetch a provider's catalog.
 *
 * Never throws: the caller gets `{models, source, error}` and can always fall
 * back to the curated list, because a settings screen that dies because a
 * provider is down is worse than one showing a slightly stale list.
 */
export async function fetchModels({ provider, baseUrl = '', key = '', relay = true, signal, fetchImpl = (...a) => fetch(...a), timeoutMs = 12_000 } = {}) {
  const directUrl = modelsUrl(provider, { baseUrl, key });
  const relayUrl = relay && !key ? relayModelsUrl(provider) : '';
  if (!directUrl && !relayUrl) return { models: [], source: 'none', error: 'this provider has no model list endpoint' };

  const timer = new AbortController();
  const abort = () => timer.abort();
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  const to = setTimeout(abort, timeoutMs);

  const headers = { Accept: 'application/json' };
  if (key && provider !== 'anthropic') headers.Authorization = `Bearer ${key}`;
  if (key && provider === 'anthropic') headers['x-api-key'] = key;
  if (provider === 'anthropic') headers['anthropic-version'] = '2023-06-01';

  /**
   * Statuses that mean "the transport is talking to something that is not the
   * API" — the same set `providers.js` treats as relay-worthy. A 404 or a 429 is
   * a real answer from the API and is reported as-is.
   */
  const TRANSPORT_STATUS = new Set([0, 403, 405, 407, 421]);

  /** One attempt. Returns the parsed list, or throws with a `status` when HTTP failed. */
  const ask = async (url, extraHeaders = {}) => {
    const res = await fetchImpl(url, { headers: { ...headers, ...extraHeaders }, signal: timer.signal });
    if (!res.ok) {
      const error = new Error(`${provider} model list returned ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return normalizeModels(await res.json(), provider);
  };

  try {
    let models;
    let relayed = false;
    try {
      models = directUrl ? await ask(directUrl) : await ask(relayUrl, { 'X-AlphaCode-Relay': '1' });
      relayed = !directUrl;
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      // Same rule as chat: a transport failure on a keyless router is worth one
      // retry through our own origin, which is what makes Kilo work everywhere.
      // A 403/405 is a transport symptom too (an extension, a proxy or a missing
      // CORS header), not an answer about models.
      const transport = err?.status === undefined || TRANSPORT_STATUS.has(err.status);
      if (!relayUrl || !directUrl || !transport) throw err;
      models = await ask(relayUrl, { 'X-AlphaCode-Relay': '1' });
      relayed = true;
    }
    return { models, source: 'live', relayed, error: models.length ? '' : 'the provider returned an empty list' };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      models: [],
      source: 'error',
      relayed: false,
      error: aborted
        ? 'timed out'
        : err?.status
          ? `${provider} model list returned ${err.status}`
          : 'could not reach the model list (blocked or offline)',
    };
  } finally {
    clearTimeout(to);
    signal?.removeEventListener?.('abort', abort);
  }
}

/**
 * The catalog for the pickers: live when possible, curated otherwise.
 *
 * Merging (rather than replacing) matters for the free routers: their `/models`
 * catalog lags what is actually served, so a curated entry that is missing from
 * the live list is still offered — it may well work, and if it does not the
 * governor will retire it after one attempt instead of the user guessing.
 */
export function mergeCatalog(provider, live = []) {
  const curated = FALLBACK_CATALOG[provider] || [];
  const byId = new Map();
  for (const model of curated) byId.set(model.id, { ...model, curated: true });
  for (const model of live) {
    const existing = byId.get(model.id);
    byId.set(model.id, { ...(existing || {}), ...model, curated: Boolean(existing?.curated), live: true });
  }
  return [...byId.values()].sort((a, b) => rankModel(b) - rankModel(a));
}

/** The models the user starred in Settings, best first, provider-scoped. */
export function poolModels(provider, pool = []) {
  const catalog = FALLBACK_CATALOG[provider] || [];
  const ids = [];
  for (const entry of Array.isArray(pool) ? pool : []) {
    if (!entry) continue;
    if (typeof entry === 'string') {
      // A bare id belongs to whoever publishes it; an id nobody curates is
      // attached to the relay routers only, which is where the picker lives.
      const owner = Object.entries(FALLBACK_CATALOG).find(([, list]) => list.some((m) => m.id === entry))?.[0];
      if (owner === provider || (!owner && RELAY_ROUTERS[provider])) ids.push(entry);
      continue;
    }
    if (entry.provider && entry.provider === provider) ids.push(entry.id);
  }
  return ids
    .filter(Boolean)
    .filter((id, index, all) => all.indexOf(id) === index)
    .map((id) => catalog.find((m) => m.id === id) || { id, name: id, free: isFreeId(id) });
}

/**
 * The models to try for one provider, in order.
 *
 * Order: the chosen model → the user's starred pool → the ranked catalog. The
 * pool is what "fetch models" writes into, so a user who picks three models
 * gets those three attempted before anything the ranking guessed.
 */
export function attemptModels(provider, { live = [], preferred = '', limit = 3, pool = [] } = {}) {
  const catalog = mergeCatalog(provider, live);
  const best = bestModels(catalog, { limit });
  const starred = poolModels(provider, pool).map((model) => catalog.find((m) => m.id === model.id) || model);
  const seen = new Set();
  const ordered = [];
  for (const model of [preferred ? { id: preferred } : null, ...starred, ...best].filter(Boolean)) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    ordered.push(catalog.find((m) => m.id === model.id) || model);
  }
  const capped = ordered.slice(0, Math.max(limit, starred.length));
  return capped.length ? capped : best;
}

/* ----------------------------------------------------------- router health -- */

/**
 * Is the free router actually answering *right now*?
 *
 * A dead router was only discoverable by typing a prompt and watching it fail —
 * which is a bad first minute for someone who was told the app is free. This
 * probe is deliberately cheap: one `GET /models` per keyless router, no chat
 * request, no tokens. It answers three questions the status pill needs:
 *
 *   • does the router respond at all        → `blocked` when it does not;
 *   • does it respond only through the relay → `relay` (still fine, just slower);
 *   • how many models does it offer          → the "live" count.
 *
 * @param {Array<{id:string, baseUrl:string, key?:string, free?:boolean}>} providers
 * @returns {Promise<{state:'live'|'relay'|'blocked'|'unknown', providers:Array, liveCount:number, checkedAt:number}>}
 */
export async function probeModels(providers = [], { fetchImpl, timeoutMs = 8_000 } = {}) {
  const results = [];
  for (const provider of providers) {
    if (!provider?.id) continue;
    const result = await fetchModels({
      provider: provider.id,
      baseUrl: provider.baseUrl || '',
      key: provider.key || '',
      fetchImpl,
      timeoutMs,
    });
    results.push({
      provider: provider.id,
      ok: result.models.length > 0,
      via: result.relayed ? 'relay' : result.models.length ? 'direct' : '',
      count: result.models.length,
      error: result.error || '',
    });
  }

  const responding = results.filter((row) => row.ok);
  const state = !results.length ? 'unknown' : responding.length ? (responding.every((row) => row.via === 'relay') ? 'relay' : 'live') : 'blocked';
  return {
    state,
    providers: results,
    liveCount: responding.reduce((sum, row) => sum + row.count, 0),
    checkedAt: Date.now(),
  };
}

/** How the status pill should describe a probe result. Never throws. */
export function describeProbe(probe) {
  const rows = probe?.providers || [];
  const failed = rows.filter((row) => !row.ok);
  if (!probe || probe.state === 'unknown') return { tone: 'warn', label: 'router unknown', detail: 'No free router has been checked yet.' };
  if (probe.state === 'blocked') {
    return {
      tone: 'err',
      label: 'free router offline',
      detail: `${rows.map((row) => row.provider).join(', ')} did not answer${failed.length ? ` (${failed[0].error})` : ''}. The offline demo model will answer until it comes back.`,
    };
  }
  const via = probe.state === 'relay' ? ' via relay' : '';
  return {
    tone: probe.state === 'relay' ? 'warn' : 'ok',
    label: `${rows.filter((r) => r.ok).map((r) => r.provider).join(' + ')}${via}`,
    detail: rows.map((row) => `${row.provider}: ${row.ok ? `${row.count} models (${row.via})` : row.error}`).join('\n'),
  };
}

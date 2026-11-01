/**
 * Provider layer — every model backend is OpenAI-Chat-Completions compatible,
 * so one streaming client + one tool-call normaliser covers them all:
 *
 *   OpenRouter      https://openrouter.ai/api/v1
 *   OpenCode Zen    https://opencode.ai/zen/v1          (Bearer public for free)
 *   Google AI Studio https://generativelanguage.googleapis.com/v1beta/openai
 *   Kilo gateway    https://api.kilo.ai/api/gateway     (anonymous :free models)
 *   BYOK            openai / anthropic* / google / groq / deepseek / custom
 *
 * (*Anthropic is used through its OpenAI-compatible endpoint.)
 */
import { config } from '../config.mjs';
import { log } from '../lib/log.mjs';

export class ProviderError extends Error {
  constructor(message, { status = 0, provider = '', retryable = false, code = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
    this.retryable = retryable;
    this.code = code;
  }
}

export const PROVIDER_META = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    freeHint: 'Free models (":free")',
    docs: 'https://openrouter.ai/keys',
    baseUrl: () => config.providers.openrouter.baseUrl,
    modelsPath: '/models',
    keyless: false,
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode Zen',
    freeHint: 'Free Zen models ("-free", big-pickle)',
    docs: 'https://opencode.ai/auth',
    baseUrl: () => config.providers.opencode.baseUrl,
    modelsPath: '/models',
    keyless: true,
  },
  google: {
    id: 'google',
    label: 'Google AI Studio',
    freeHint: 'Gemini free tier',
    docs: 'https://aistudio.google.com/apikey',
    baseUrl: () => config.providers.google.baseUrl,
    modelsPath: '/models',
    keyless: false,
  },
  kilo: {
    id: 'kilo',
    label: 'Kilo',
    freeHint: 'kilo-auto/free — always free, no key',
    docs: 'https://kilo.ai',
    baseUrl: () => config.providers.kilo.baseUrl,
    modelsPath: '/models',
    keyless: true,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI (BYOK)',
    baseUrl: () => 'https://api.openai.com/v1',
    modelsPath: '/models',
    keyless: false,
    byok: true,
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (BYOK)',
    baseUrl: () => 'https://api.anthropic.com/v1',
    modelsPath: '/models',
    keyless: false,
    byok: true,
  },
  groq: { id: 'groq', label: 'Groq (BYOK)', baseUrl: () => 'https://api.groq.com/openai/v1', modelsPath: '/models', keyless: false, byok: true },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek (BYOK)',
    baseUrl: () => 'https://api.deepseek.com/v1',
    modelsPath: '/models',
    keyless: false,
    byok: true,
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral (BYOK)',
    baseUrl: () => 'https://api.mistral.ai/v1',
    modelsPath: '/models',
    keyless: false,
    byok: true,
  },
  xai: { id: 'xai', label: 'xAI (BYOK)', baseUrl: () => 'https://api.x.ai/v1', modelsPath: '/models', keyless: false, byok: true },
  together: {
    id: 'together',
    label: 'Together (BYOK)',
    baseUrl: () => 'https://api.together.xyz/v1',
    modelsPath: '/models',
    keyless: false,
    byok: true,
  },
  mock: {
    id: 'mock',
    label: 'Demo provider',
    baseUrl: () => 'mock://local',
    modelsPath: '/models',
    keyless: true,
    byok: false,
  },
  custom: {
    id: 'custom',
    label: 'Custom OpenAI-compatible (BYOK)',
    baseUrl: () => '',
    modelsPath: '/models',
    keyless: false,
    byok: true,
    needsBaseUrl: true,
  },
};

/** Platform keys configured via environment (Cloudflare dashboard). */
export function platformKey(provider) {
  const p = config.providers[provider];
  if (!p) return '';
  if (provider === 'opencode') return p.key || 'public';
  return p.key || '';
}

export function platformConfigured(provider) {
  const p = config.providers[provider];
  if (!p) return false;
  if (provider === 'kilo') return true; // anonymous free tier always available
  if (provider === 'opencode') return true; // Bearer public works for free models
  return Boolean(p.key);
}

function authHeaders(providerId, apiKey) {
  const meta = PROVIDER_META[providerId];
  const headers = { 'Content-Type': 'application/json' };
  if (providerId === 'anthropic') {
    headers.Authorization = `Bearer ${apiKey}`;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const extra = config.providers[providerId]?.headers;
  if (extra) Object.assign(headers, extra);
  headers['User-Agent'] = 'AlphaCode/2.0 (+https://github.com/Time-dev-alt/Nex)';
  if (meta) headers['X-AlphaCode-Client'] = 'harness';
  return headers;
}

export function resolveBase(providerId, overrideBase) {
  if (overrideBase) return overrideBase.replace(/\/+$/, '');
  const factory = PROVIDER_META[providerId]?.baseUrl;
  return (factory ? factory() : '').replace(/\/+$/, '');
}

// ---------------------------------------------------------------- models ---
const modelCache = new Map(); // key -> {at, models}

function isFreeModel(providerId, m) {
  const id = String(m.id || '').toLowerCase();
  const pricing = m.pricing || {};
  const zeroPrice =
    (pricing.prompt === '0' || pricing.prompt === 0 || pricing.prompt === undefined) &&
    (pricing.completion === '0' || pricing.completion === 0 || pricing.completion === undefined);
  switch (providerId) {
    case 'openrouter':
      return /:free$/.test(id) || (pricing.prompt === '0' && pricing.completion === '0');
    case 'opencode':
      return /-free$/.test(id) || /free$/.test(id) || ['big-pickle', 'grok-code-fast-1', 'gpt-5-nano'].includes(id);
    case 'google':
      return /(gemini|gemma)/.test(id) && !/pro/.test(id) ? true : /gemini-2\.5-flash|gemini-2\.0-flash|gemma/.test(id);
    case 'kilo':
      return /:free$/.test(id) || id === 'kilo-auto/free' || /auto\/free/.test(id) || zeroPrice;
    default:
      return true; // BYOK — user pays, everything is "allowed"
  }
}

export function fallbackCatalog(providerId) {
  switch (providerId) {
    case 'kilo':
      return [
        { id: 'kilo-auto/free', name: 'Kilo Auto (free router)', context: 256000, free: true },
        { id: 'minimax/minimax-m2.5:free', name: 'MiniMax M2.5 (free)', context: 196000, free: true },
        { id: 'stepfun/step-3.7-flash:free', name: 'Step 3.7 Flash (free)', context: 262000, free: true },
        { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super (free)', context: 262000, free: true },
      ];
    case 'opencode':
      return [
        { id: 'big-pickle', name: 'Big Pickle (free)', context: 200000, free: true },
        { id: 'minimax-m2.5-free', name: 'MiniMax M2.5 (free)', context: 204800, free: true },
        { id: 'nemotron-3-super-free', name: 'Nemotron 3 Super (free)', context: 204800, free: true },
        { id: 'mimo-v2.5-free', name: 'MiMo V2.5 (free)', context: 131072, free: true },
      ];
    case 'google':
      return [
        { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', context: 1000000, free: true },
        { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', context: 1000000, free: true },
        { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', context: 1000000, free: true },
      ];
    case 'openrouter':
      return [
        { id: 'openrouter/free', name: 'OpenRouter free router', context: 200000, free: true },
        { id: 'deepseek/deepseek-chat-v3.1:free', name: 'DeepSeek V3.1 (free)', context: 163840, free: true },
        { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder (free)', context: 262144, free: true },
      ];
    default:
      return [];
  }
}

export async function listModels(providerId, { apiKey, baseUrl, force = false } = {}) {
  const meta = PROVIDER_META[providerId];
  if (!meta) return [];
  const key = `${providerId}:${apiKey ? 'user' : 'platform'}:${baseUrl || ''}`;
  const cached = modelCache.get(key);
  if (!force && cached && Date.now() - cached.at < 10 * 60_000) return cached.models;
  const base = resolveBase(providerId, baseUrl);
  if (!base) return fallbackCatalog(providerId);
  try {
    const res = await fetchWithTimeout(
      `${base}${meta.modelsPath}`,
      { headers: authHeaders(providerId, apiKey) },
      12_000,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const raw = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    let models = raw.map((m) => ({
      id: m.id || m.name,
      name: m.name || m.id,
      context: m.context_length || m.context_window || m.max_context_length || (m.top_provider?.context_length ?? 0) || 0,
      free: isFreeModel(providerId, m),
      tools: m.supported_parameters ? m.supported_parameters.includes('tools') : true,
    }));
    models = models.filter((m) => m.id);
    if (config.providers[providerId]?.freeOnly) models = models.filter((m) => m.free);
    if (!models.length) models = fallbackCatalog(providerId);
    models.sort((a, b) => Number(b.free) - Number(a.free) || a.id.localeCompare(b.id));
    modelCache.set(key, { at: Date.now(), models });
    return models;
  } catch (err) {
    log.warn(`model catalog unavailable for ${providerId}: ${err.message}`);
    const fb = fallbackCatalog(providerId);
    modelCache.set(key, { at: Date.now() - 8 * 60_000, models: fb });
    return fb;
  }
}

// ------------------------------------------------------------------ chat ---
async function fetchWithTimeout(url, opts = {}, timeoutMs = 60_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: opts.signal || ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normaliseMessages(providerId, messages, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content ?? null };
      if (m.tool_calls?.length) msg.tool_calls = m.tool_calls;
      if (!msg.content && !msg.tool_calls) msg.content = '';
      out.push(msg);
    } else {
      out.push({ role: m.role === 'system' ? 'system' : 'user', content: m.content });
    }
  }
  return out;
}

/**
 * Stream a chat completion.
 * Returns { content, reasoning, toolCalls, usage, finishReason, model }.
 */
export async function streamChat({
  provider,
  model,
  messages,
  system,
  tools,
  apiKey,
  baseUrl,
  temperature = 0.2,
  maxTokens = 8192,
  signal,
  onEvent = () => {},
  timeoutMs = config.agent.requestTimeoutMs,
}) {
  if (provider === 'mock') {
    return mockChat({ model, messages, tools, onEvent, signal });
  }
  const base = resolveBase(provider, baseUrl);
  if (!base) throw new ProviderError('Provider base URL is not configured', { provider, code: 'no_base' });
  const key = apiKey !== undefined ? apiKey : platformKey(provider);
  const headers = authHeaders(provider, key);
  headers.Accept = 'text/event-stream';

  const body = {
    model,
    messages: normaliseMessages(provider, messages, system),
    stream: true,
    max_tokens: maxTokens,
    temperature: provider === 'google' ? Math.min(temperature, 1) : temperature,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
    if (provider === 'google') body.parallel_tool_calls = false;
  }
  // Zen's free tier rejects some params.
  if (provider === 'opencode') {
    delete body.temperature;
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(new Error('aborted'));
  if (signal) {
    if (signal.aborted) throw new ProviderError('Request cancelled', { provider, code: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new Error('provider timeout')), timeoutMs);

  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    throw new ProviderError(
      ctrl.signal.aborted ? 'Model request timed out' : `Network error talking to ${provider}: ${err.message}`,
      { provider, retryable: true, code: 'network' },
    );
  }

  if (!res.ok) {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    const text = await res.text().catch(() => '');
    const detail = text.slice(0, 600);
    throw new ProviderError(`HTTP ${res.status} from ${provider}${detail ? ': ' + detail : ''}`, {
      status: res.status,
      provider,
      retryable: res.status === 429 || res.status >= 500,
      code: res.status === 429 ? 'rate_limited' : res.status === 401 || res.status === 403 ? 'unauthorized' : 'http_error',
    });
  }

  const acc = {
    content: '',
    reasoning: '',
    toolCalls: [],
    usage: null,
    finishReason: '',
    model,
    provider,
  };
  const ct = String(res.headers.get('content-type') || '');
  try {
    if (!ct.includes('text/event-stream') || !res.body) {
      // Some gateways ignore stream:true.
      const json = await res.json();
      const choice = json?.choices?.[0];
      acc.content = choice?.message?.content || '';
      acc.reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || '';
      acc.finishReason = choice?.finish_reason || 'stop';
      acc.usage = json?.usage || null;
      for (const [i, tc] of (choice?.message?.tool_calls || []).entries()) {
        acc.toolCalls.push({ id: tc.id || `call_${i}`, name: tc.function?.name || '', arguments: tc.function?.arguments || '{}' });
      }
      onEvent({ type: 'text', text: acc.content });
      if (acc.reasoning) onEvent({ type: 'reasoning', text: acc.reasoning });
    } else {
      await readSSE(res.body, (event, data) => {
        if (data === '[DONE]') return;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          return;
        }
        if (json.error) throw new ProviderError(json.error.message || 'provider error', { provider, retryable: true });
        if (json.usage) acc.usage = json.usage;
        if (json.model) acc.model = json.model;
        const choice = json.choices?.[0];
        if (!choice) return;
        const delta = choice.delta || choice.message || {};
        const think = delta.reasoning_content || delta.reasoning || json.reasoning_content;
        if (think) {
          acc.reasoning += think;
          onEvent({ type: 'reasoning', text: think });
        }
        if (delta.content) {
          acc.content += delta.content;
          onEvent({ type: 'text', text: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const [pos, tc] of delta.tool_calls.entries()) {
            const idx = tc.index ?? pos;
            const slot = (acc.toolCalls[idx] ||= { id: '', name: '', arguments: '' });
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name += tc.function.name;
            if (tc.function?.arguments) slot.arguments += tc.function.arguments;
            onEvent({ type: 'tool_delta', index: idx, name: slot.name });
          }
        }
        if (choice.finish_reason) acc.finishReason = choice.finish_reason;
      });
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }

  acc.toolCalls = acc.toolCalls
    .filter((t) => t && t.name)
    .map((t, i) => ({ id: t.id || `call_${Date.now().toString(36)}_${i}`, name: t.name, arguments: t.arguments || '{}' }));
  return acc;
}

async function readSSE(stream, onMessage) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let eventName = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0 || (idx = buf.indexOf('\r\n\r\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2));
        let data = '';
        eventName = '';
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('data:')) data += line.slice(5).trimStart();
          else if (line.startsWith('event:')) eventName = line.slice(6).trim();
        }
        if (data) onMessage(eventName, data);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
}

/** Rough token estimate (4 chars/token) — good enough for budget shaping. */
export function estimateTokens(text) {
  if (!text) return 0;
  if (typeof text !== 'string') text = JSON.stringify(text);
  return Math.ceil(text.length / 3.6);
}

/* ------------------------------------------------------------ demo mode --- */
/**
 * Deterministic local provider used when ALPHACODE_MOCK=1 (offline demos and
 * end-to-end tests). It drives the *real* harness — real tool execution, real
 * files, real shell — it only fakes the model.
 */
export async function mockChat({ model = 'demo-1', messages, tools = [], onEvent, signal }) {
  const toolNames = new Set(tools.map((t) => t.function?.name));
  const toolResults = messages.filter((m) => m.role === 'tool');
  const userText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const emitText = async (text) => {
    for (const chunk of String(text).match(/.{1,24}/gs) || []) {
      if (signal?.aborted) throw new ProviderError('Request cancelled', { provider: 'mock', code: 'aborted' });
      onEvent({ type: 'text', text: chunk });
      await sleep(8);
    }
  };
  const call = (name, args) => ({ id: `call_${crypto.randomUUID().slice(0, 8)}`, name, arguments: JSON.stringify(args) });
  const acc = { content: '', reasoning: '', toolCalls: [], usage: { prompt_tokens: 120, completion_tokens: 60 }, finishReason: 'stop', model, provider: 'mock' };

  const step = toolResults.length;
  const wantsApp = !/^(hi|hello|hey)\b/i.test(userText.trim());

  if (tools.length && step === 0 && wantsApp && toolNames.has('todo_write')) {
    acc.reasoning = 'Plan the work, then build it.';
    onEvent({ type: 'reasoning', text: acc.reasoning });
    acc.toolCalls = [call('todo_write', { todos: [
      { content: 'Scaffold the app', status: 'in_progress', activeForm: 'Scaffolding the app' },
      { content: 'Run a sanity check', status: 'pending' },
      { content: 'Report back', status: 'pending' },
    ] })];
    acc.finishReason = 'tool_calls';
    return acc;
  }
  if (tools.length && step === 1 && toolNames.has('write')) {
    acc.toolCalls = [call('write', { file_path: 'index.html', content: '<!doctype html>\n<html><head><meta charset="utf-8"><title>Demo app</title><style>body{font-family:system-ui;background:#0b0d12;color:#eef1f7;display:grid;place-items:center;height:100vh;margin:0}h1{background:linear-gradient(135deg,#ff9d5c,#e2566a);-webkit-background-clip:text;background-clip:text;color:transparent}</style></head><body><h1>Built by AlphaCode</h1></body></html>' })];
    acc.finishReason = 'tool_calls';
    return acc;
  }
  if (tools.length && step === 2 && toolNames.has('bash')) {
    acc.toolCalls = [call('bash', { command: 'ls -la && echo ALPHACODE_SMOKE_OK', description: 'List the workspace and prove the shell runs' })];
    acc.finishReason = 'tool_calls';
    return acc;
  }
  if (tools.length && step === 3 && toolNames.has('todo_write')) {
    acc.toolCalls = [call('todo_write', { todos: [
      { content: 'Scaffold the app', status: 'completed' },
      { content: 'Run a sanity check', status: 'completed' },
      { content: 'Report back', status: 'in_progress' },
    ] })];
    acc.finishReason = 'tool_calls';
    return acc;
  }
  await emitText(
    `## Demo run complete\n\nI created \`index.html\` and verified the shell works.\n\n- Real file write went through the workspace sandbox\n- Real bash process ran in the project directory\n- Todos tracked the plan\n\n> This instance is running the **demo provider** because it has no outbound access to model APIs. Add a BYOK key or set the platform keys to use a real model.`,
  );
  acc.content = 'Demo run complete — file written and shell verified.';
  return acc;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

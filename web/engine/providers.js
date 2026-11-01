/**
 * Model providers — called straight from the browser.
 *
 * There is no key-hiding server in this architecture: every request is made by
 * the user's own browser, with their own key, to the provider's own API. That
 * is the point of the design (we host nothing), and it is why BYOK is the
 * first-class path and the anonymous free routers are the fallback.
 *
 * CORS reality check: a provider that does not send
 * `Access-Control-Allow-Origin` cannot be called from a page. The ones wired
 * here are the known-good browser endpoints; anything else is available through
 * a BYOK "custom base URL" and will surface a precise CORS error if it refuses.
 */

export const PROVIDERS = {
  kilo: {
    id: 'kilo',
    label: 'Kilo (free)',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    keyless: true,
    freeOnly: true,
    docs: 'https://kilo.ai',
    note: 'Anonymous free router — no account, no key.',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    keyless: true,
    freeOnly: true,
    docs: 'https://opencode.ai/docs/zen',
    note: 'Free models accept an anonymous key; paid models need your own.',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyless: false,
    freeOnly: true,
    docs: 'https://openrouter.ai/keys',
    note: 'Models ending in :free cost nothing.',
  },
  google: {
    id: 'google',
    label: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyless: false,
    freeOnly: true,
    docs: 'https://aistudio.google.com/apikey',
    note: 'Gemini free tier — the key is used directly from your browser.',
  },
  openai: { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyless: false, byok: true },
  anthropic: { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', keyless: false, byok: true, wire: 'anthropic' },
  groq: { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyless: false, byok: true },
  deepseek: { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyless: false, byok: true },
  mistral: { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyless: false, byok: true },
  xai: { id: 'xai', label: 'xAI', baseUrl: 'https://api.x.ai/v1', keyless: false, byok: true },
  together: { id: 'together', label: 'Together', baseUrl: 'https://api.together.xyz/v1', keyless: false, byok: true },
  custom: { id: 'custom', label: 'Custom (OpenAI-compatible)', baseUrl: '', keyless: false, byok: true },
  demo: { id: 'demo', label: 'Demo (offline)', baseUrl: '', keyless: true, offline: true },
};

/** The free catalog offered in the picker, per provider. */
export const FREE_MODELS = {
  kilo: [
    { id: 'kilo-auto/free', name: 'Kilo Auto (free router)', context: 256000 },
    { id: 'minimax/minimax-m2.5:free', name: 'MiniMax M2.5 (free)', context: 196000 },
    { id: 'stepfun/step-3.7-flash:free', name: 'Step 3.7 Flash (free)', context: 262000 },
    { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super (free)', context: 262000 },
  ],
  opencode: [
    { id: 'big-pickle', name: 'Big Pickle (free)', context: 200000 },
    { id: 'minimax-m2.5-free', name: 'MiniMax M2.5 (free)', context: 204800 },
    { id: 'mimo-v2.5-free', name: 'MiMo V2.5 (free)', context: 131072 },
    { id: 'nemotron-3-super-free', name: 'Nemotron 3 Super (free)', context: 204800 },
  ],
  openrouter: [
    { id: 'openrouter/free', name: 'OpenRouter free router', context: 200000 },
    { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder (free)', context: 262144 },
    { id: 'deepseek/deepseek-chat-v3.1:free', name: 'DeepSeek V3.1 (free)', context: 163840 },
  ],
  google: [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', context: 1000000 },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', context: 1000000 },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', context: 1000000 },
  ],
};

export const isFreeModel = (id) => /:free$|(^|\/)(kilo-auto|openrouter)\/free$|\bfree\b|-free$/.test(String(id || '')) || /^gemini-.*flash/.test(String(id || ''));

export const GUEST_MODEL = 'kilo-auto/free';

/** Order of providers tried for a signed-in-free request. */
export const PLATFORM_CHAIN = ['kilo', 'opencode'];

/**
 * Build the attempt list for one request.
 * Order: explicit BYOK → platform free routers (kilo/opencode) → demo.
 */
export function planAttempts({ model = '', settings = {} } = {}) {
  const keys = settings.keys || {};
  const byok = Object.entries(keys)
    .filter(([id, v]) => v && v.key && PROVIDERS[id])
    .map(([id]) => ({ provider: id, model: keys[id].model || model || '', via: 'byok', key: keys[id].key, baseUrl: keys[id].baseUrl }));

  const attempts = [...byok];
  const freeModel = model || GUEST_MODEL;
  for (const provider of PLATFORM_CHAIN) {
    if (provider === 'openrouter' && !keys.openrouter?.key && !settings.platformOpenrouter) continue;
    attempts.push({
      provider,
      model: modelForProvider(provider, freeModel),
      via: provider === 'kilo' ? 'guest' : 'platform',
      key: keys[provider]?.key || (provider === 'opencode' ? 'public' : ''),
    });
  }
  // Demo is the last resort so the product is usable with no key and no network.
  if (settings.demo !== false) attempts.push({ provider: 'demo', model: 'demo-1', via: 'demo' });
  return attempts;
}

export function modelForProvider(provider, model) {
  const list = FREE_MODELS[provider] || [];
  if (list.some((m) => m.id === model)) return model;
  if (provider === 'kilo') return 'kilo-auto/free';
  if (provider === 'opencode') return 'big-pickle';
  if (provider === 'openrouter') return 'openrouter/free';
  if (provider === 'google') return 'gemini-2.5-flash';
  return model;
}

function headersFor(provider, key, extra = {}) {
  const meta = PROVIDERS[provider] || {};
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (meta.wire === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = location.origin;
    headers['X-Title'] = 'AlphaCode';
  }
  return headers;
}

function anthropicBody({ model, messages, system, tools, maxTokens }) {
  const converted = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      converted.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }],
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const call of m.tool_calls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: safeJson(call.arguments) });
      }
      converted.push({ role: 'assistant', content });
      continue;
    }
    converted.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') });
  }
  return {
    model,
    max_tokens: maxTokens || 8192,
    system: system || undefined,
    messages: converted,
    stream: true,
    tools: tools?.length
      ? tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }))
      : undefined,
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

/** Parse an SSE stream of OpenAI-style chunks (also used for Anthropic events). */
async function readSse(response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        onChunk(JSON.parse(data));
      } catch {
        /* ignore keep-alives */
      }
    }
  }
}

/**
 * Stream one completion.
 * @returns {Promise<{content:string, reasoning:string, toolCalls:Array, usage:object, finishReason:string}>}
 */
export async function streamChat({
  provider = 'kilo',
  model,
  messages = [],
  system = '',
  tools = [],
  key = '',
  baseUrl = '',
  maxTokens = 8192,
  signal,
  onEvent = () => {},
  fetchImpl = (...a) => fetch(...a),
} = {}) {
  if (provider === 'demo') return demoCompletion({ messages, tools, onEvent, model: model || 'demo-1' });

  const meta = PROVIDERS[provider];
  if (!meta) throw new Error(`Unknown provider "${provider}"`);
  const root = (baseUrl || meta.baseUrl || '').replace(/\/+$/, '');
  if (!root) throw new Error(`${meta.label} needs a base URL (Settings → Providers)`);
  const anthropic = meta.wire === 'anthropic';
  const url = anthropic ? `${root}/messages` : `${root}/chat/completions`;

  const body = anthropic
    ? anthropicBody({ model, messages, system, tools, maxTokens })
    : {
        model,
        messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
        stream: true,
        max_tokens: maxTokens,
        tools: tools?.length ? tools : undefined,
        tool_choice: tools?.length ? 'auto' : undefined,
        stream_options: { include_usage: true },
      };

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: headersFor(provider, key),
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(
      `${meta.label} is unreachable from this browser (${err.message || 'network error'}). ` +
        `If you expected this to work, the provider is probably blocking cross-origin requests — use a BYOK provider that allows CORS, or proxy it yourself.`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error?.message || parsed.message || detail;
    } catch {}
    const hint =
      res.status === 401
        ? ' — add or fix your API key in Settings → Providers'
        : res.status === 402
          ? ' — the free allowance is used up on this key'
          : res.status === 429
            ? ' — rate limited, try again shortly'
            : '';
    throw new Error(`${meta.label} ${res.status}: ${detail}${hint}`);
  }

  const acc = { content: '', reasoning: '', toolCalls: [], usage: {}, finishReason: 'stop' };
  const toolIndex = new Map();

  if (anthropic) {
    await readSse(res, (ev) => {
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        toolIndex.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, arguments: '' });
      } else if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta') {
          acc.content += ev.delta.text;
          onEvent({ type: 'text', text: ev.delta.text });
        } else if (ev.delta?.type === 'input_json_delta') {
          const slot = toolIndex.get(ev.index);
          if (slot) slot.arguments += ev.delta.partial_json || '';
        } else if (ev.delta?.type === 'thinking_delta') {
          acc.reasoning += ev.delta.thinking || '';
          onEvent({ type: 'reasoning', text: ev.delta.thinking || '' });
        }
      } else if (ev.type === 'message_delta') {
        if (ev.delta?.stop_reason) acc.finishReason = ev.delta.stop_reason;
        if (ev.usage) acc.usage = { input: ev.usage.input_tokens || 0, output: ev.usage.output_tokens || 0 };
      }
    });
    acc.toolCalls = [...toolIndex.values()].filter((t) => t.name);
  } else {
    await readSse(res, (chunk) => {
      const choice = chunk.choices?.[0];
      if (chunk.usage) acc.usage = { input: chunk.usage.prompt_tokens || 0, output: chunk.usage.completion_tokens || 0 };
      if (!choice) return;
      const delta = choice.delta || {};
      if (delta.content) {
        acc.content += delta.content;
        onEvent({ type: 'text', text: delta.content });
      }
      if (delta.reasoning || delta.reasoning_content) {
        const r = delta.reasoning || delta.reasoning_content;
        acc.reasoning += r;
        onEvent({ type: 'reasoning', text: r });
      }
      for (const call of delta.tool_calls || []) {
        const idx = call.index ?? 0;
        const slot = toolIndex.get(idx) || { id: '', name: '', arguments: '' };
        if (call.id) slot.id = call.id;
        if (call.function?.name) slot.name = (slot.name || '') + call.function.name;
        if (call.function?.arguments) slot.arguments += call.function.arguments;
        toolIndex.set(idx, slot);
      }
      if (choice.finish_reason) acc.finishReason = choice.finish_reason;
    });
    acc.toolCalls = [...toolIndex.values()]
      .filter((t) => t.name)
      .map((t, i) => ({ id: t.id || `call_${i}_${Date.now()}`, name: t.name, arguments: t.arguments || '{}' }));
  }

  for (const call of acc.toolCalls) onEvent({ type: 'tool_call', call });
  return acc;
}

/** Deterministic offline model so the harness is demoable without any network. */
export async function demoCompletion({ messages = [], tools = [], onEvent = () => {}, model = 'demo-1' }) {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const toolResults = messages.filter((m) => m.role === 'tool');
  const step = toolResults.length;
  const plan = [
    { name: 'todo_write', args: { todos: [{ content: 'Scaffold the app', status: 'in_progress' }, { content: 'Verify the build', status: 'pending' }] } },
    { name: 'write', args: { file_path: 'index.html', content: DEMO_PAGE } },
    { name: 'bash', args: { command: 'ls -la' } },
    { name: 'write', args: { file_path: 'style.css', content: DEMO_CSS } },
  ];
  const say = (text) => onEvent({ type: 'text', text });

  if (step < plan.length && tools.some((t) => t.function?.name === plan[step].name)) {
    const call = { id: `call_demo_${step}`, name: plan[step].name, arguments: JSON.stringify(plan[step].args) };
    say(`Step ${step + 1}: ${call.name}`);
    onEvent({ type: 'tool_call', call });
    return { content: `Step ${step + 1}: ${call.name}`, reasoning: '', toolCalls: [call], usage: { input: 120, output: 60 }, finishReason: 'tool_calls', model };
  }

  const text = `Built a landing page for: **${String(last).slice(0, 120)}**\n\n- \`index.html\` — hero, feature grid, footer\n- \`style.css\` — dark theme, responsive\n\nThis is the offline demo model. Add a key under Settings → Providers to use a real one.`;
  for (const chunk of text.match(/[\s\S]{1,24}/g) || []) {
    say(chunk);
    await new Promise((r) => setTimeout(r, 8));
  }
  return { content: text, reasoning: '', toolCalls: [], usage: { input: 240, output: 120 }, finishReason: 'stop', model };
}

const DEMO_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Roam — coffee, delivered</title><link rel="stylesheet" href="style.css"></head>
<body>
<header class="nav">
  <a class="brand" href="#"><span class="mark"></span>Roam</a>
  <nav><a href="#beans">Beans</a><a href="#how">How it works</a><a href="#plans">Plans</a></nav>
  <a class="btn ghost" href="#plans">Get started</a>
</header>

<main>
  <section class="hero">
    <p class="eyebrow">Fresh roasted · shipped weekly</p>
    <h1>Coffee that tastes like<br><em>somewhere else.</em></h1>
    <p class="lede">Three single-origin roasts a month, chosen by people who obsess over this sort of thing. Roasted Tuesday, at your door Friday.</p>
    <div class="cta"><a class="btn" href="#plans">Start with a trial box</a><a class="link" href="#how">See how it works</a></div>
    <div class="proof"><span>4.9 / 5</span><span>2,400+ subscribers</span><span>Cancel anytime</span></div>
  </section>

  <section class="beans" id="beans">
    <article><span class="swatch s1"></span><h2>Ethiopia Guji</h2><p>Jasmine, peach, bergamot. Bright and floral.</p></article>
    <article><span class="swatch s2"></span><h2>Colombia Huila</h2><p>Red apple, panela, cocoa nib. Sweet and round.</p></article>
    <article><span class="swatch s3"></span><h2>Sumatra Gayo</h2><p>Cedar, dark cherry, tobacco leaf. Deep and earthy.</p></article>
  </section>

  <section class="how" id="how">
    <h2>Three steps, then it is coffee.</h2>
    <ol>
      <li><b>Tell us how you brew</b><span>Espresso, filter, or a bit of both.</span></li>
      <li><b>We pick the roasts</b><span>Three origins, ground to order.</span></li>
      <li><b>It arrives Friday</b><span>Roasted Tuesday, in the post Wednesday.</span></li>
    </ol>
  </section>

  <section class="plans" id="plans">
    <h2>Pick a plan</h2>
    <div class="grid">
      <article><h3>Small</h3><p class="price">$16<span>/mo</span></p><p>2 × 150 g bags</p><a class="btn ghost" href="#">Choose</a></article>
      <article class="featured"><h3>Weekly</h3><p class="price">$27<span>/mo</span></p><p>3 × 250 g bags</p><a class="btn" href="#">Choose</a></article>
      <article><h3>Café</h3><p class="price">$58<span>/mo</span></p><p>1 kg, your choice</p><a class="btn ghost" href="#">Choose</a></article>
    </div>
  </section>
</main>

<footer><span>Roam Coffee Co.</span><span>Built in a browser tab with AlphaCode.</span></footer>
<script>document.querySelector('.brand').onclick = (e) => { e.preventDefault(); document.body.classList.toggle('alt'); };</script>
</body></html>`;

const DEMO_CSS = `:root{
  --bg:#0d0a08; --panel:#151210; --fg:#f6efe7; --muted:#a79a8c;
  --accent:#e8a24a; --accent-2:#c9663b; --line:rgba(255,255,255,.09);
}
body.alt{--bg:#fbf7f1;--panel:#fff;--fg:#1b1510;--muted:#6f6255;--line:rgba(24,16,8,.12)}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0 0 auto;height:70vh;background:
  radial-gradient(60% 80% at 20% 0%,rgba(232,162,74,.18),transparent 65%),
  radial-gradient(50% 70% at 85% 10%,rgba(201,102,59,.14),transparent 65%);pointer-events:none}
.nav{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:28px;padding:18px 32px;
  backdrop-filter:blur(14px);background:color-mix(in srgb,var(--bg) 78%,transparent);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;letter-spacing:-.02em;color:inherit;text-decoration:none;font-size:17px}
.mark{width:22px;height:22px;border-radius:7px;background:linear-gradient(140deg,var(--accent),var(--accent-2))}
.nav nav{display:flex;gap:22px;margin-left:auto}
.nav nav a{color:var(--muted);text-decoration:none;font-size:14px}
.nav nav a:hover{color:var(--fg)}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:11px 18px;border-radius:11px;font-weight:600;font-size:14px;
  background:linear-gradient(180deg,var(--accent),var(--accent-2));color:#1a1006;text-decoration:none;border:1px solid transparent;
  box-shadow:0 8px 24px -12px rgba(232,162,74,.8)}
.btn.ghost{background:transparent;color:var(--fg);border-color:var(--line);box-shadow:none}
main{max-width:1080px;margin:0 auto;padding:0 32px}
.hero{padding:96px 0 72px;max-width:760px}
.eyebrow{margin:0 0 20px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
h1{margin:0 0 22px;font-size:clamp(40px,6.4vw,68px);line-height:1.02;letter-spacing:-.035em}
h1 em{font-family:"Instrument Serif",Georgia,serif;font-style:italic;font-weight:400;
  background:linear-gradient(100deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;color:transparent}
.lede{margin:0 0 32px;font-size:18px;color:var(--muted);max-width:56ch}
.cta{display:flex;align-items:center;gap:20px;flex-wrap:wrap}
.link{color:var(--muted);text-decoration:none;font-size:14px;border-bottom:1px solid var(--line);padding-bottom:2px}
.link:hover{color:var(--fg)}
.proof{display:flex;gap:22px;margin-top:44px;font-size:13px;color:var(--muted);flex-wrap:wrap}
.proof span{display:flex;align-items:center;gap:8px}
.proof span::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--accent)}
.beans{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;padding:8px 0 72px}
.beans article{padding:22px;border:1px solid var(--line);border-radius:18px;background:var(--panel)}
.swatch{display:block;height:96px;border-radius:12px;margin-bottom:16px}
.s1{background:linear-gradient(140deg,#f3d9a4,#c98f4a)}
.s2{background:linear-gradient(140deg,#d98d63,#7e3f2a)}
.s3{background:linear-gradient(140deg,#8d7f6a,#2f2a25)}
.beans h2{margin:0 0 6px;font-size:17px;letter-spacing:-.01em}
.beans p{margin:0;font-size:14px;color:var(--muted)}
.how{padding:56px 0;border-top:1px solid var(--line)}
.how h2{font-size:28px;letter-spacing:-.02em;margin:0 0 28px}
.how ol{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:22px;list-style:none;padding:0;margin:0;counter-reset:step}
.how li{border-left:1px solid var(--line);padding-left:18px}
.how li::before{counter-increment:step;content:"0" counter(step);display:block;font-size:12px;color:var(--accent);margin-bottom:8px;letter-spacing:.1em}
.how b{display:block;font-size:16px;margin-bottom:4px}
.how span{font-size:14px;color:var(--muted)}
.plans{padding:56px 0 80px;border-top:1px solid var(--line)}
.plans h2{font-size:28px;letter-spacing:-.02em;margin:0 0 26px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.grid article{padding:24px;border:1px solid var(--line);border-radius:18px;background:var(--panel);display:flex;flex-direction:column;gap:6px}
.grid article.featured{border-color:color-mix(in srgb,var(--accent) 55%,transparent);box-shadow:0 24px 60px -30px rgba(232,162,74,.5)}
.grid h3{margin:0;font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.price{margin:6px 0;font-size:38px;letter-spacing:-.03em}
.price span{font-size:14px;color:var(--muted);letter-spacing:0}
.grid p{margin:0;font-size:14px;color:var(--muted)}
.grid .btn{margin-top:16px}
footer{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:26px 32px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
@media(max-width:640px){.nav nav{display:none}.hero{padding:56px 0 40px}main{padding:0 20px}footer{padding:22px 20px}}`;

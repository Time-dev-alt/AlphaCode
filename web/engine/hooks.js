/**
 * Hooks — the browser equivalent of Claude Code's `hooks.json`.
 *
 * There is no shell to run, so a hook is a small JavaScript function stored in
 * the project (`.alphacode/hooks.js` or settings) and executed in a restricted
 * scope. It can:
 *
 *   • block a tool call        → `return { block: 'reason' }`
 *   • rewrite its arguments    → `return { args: {...} }`
 *   • inject context for the model → `return { note: '…' }`
 *   • auto-approve             → `return { approve: true }`
 *
 * Example (`.alphacode/hooks.js`):
 *
 *   export default {
 *     pre_tool: [
 *       { match: 'bash', run: () => /rm -rf|curl/.test(String(ctx.args.command)) ? { block: 'destructive command' } : null },
 *       { match: 'write', run: () => ctx.args.path.endsWith('.env') ? { block: '.env files are not written by agents here' } : null },
 *     ],
 *     post_tool: [
 *       { match: 'write', run: () => ({ note: `wrote ${ctx.args.path}` }) },
 *     ],
 *   };
 */

export const HOOK_EVENTS = ['pre_tool', 'post_tool', 'pre_run', 'post_run', 'on_error', 'on_stop'];

const matcherFor = (pattern) => {
  if (!pattern || pattern === '*') return () => true;
  if (pattern instanceof RegExp) return (name) => pattern.test(name);
  const text = String(pattern);
  if (text.includes('*')) {
    const re = new RegExp(`^${text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return (name) => re.test(name);
  }
  return (name) => name === text;
};

/** Normalise whatever the project gave us into {event: [{match, run}]}. */
export function normalizeHooks(input, { source = 'hooks' } = {}) {
  const hooks = {};
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      try {
        raw = compileModule(raw, source).default || compileModule(raw, source);
      } catch (err) {
        throw new Error(`hooks are not valid JSON or JavaScript: ${err.message}`);
      }
    }
  }
  if (!raw || typeof raw !== 'object') return hooks;
  for (const [event, list] of Object.entries(raw)) {
    if (!HOOK_EVENTS.includes(event)) continue;
    const entries = (Array.isArray(list) ? list : [list]).filter(Boolean).map((entry) => {
      if (typeof entry === 'function') return { match: '*', run: entry, description: entry.name };
      const run = typeof entry.run === 'function' ? entry.run : typeof entry.run === 'string' ? compileFunction(entry.run, event) : () => null;
      return { match: entry.match || '*', run, description: entry.description || '' };
    });
    if (entries.length) hooks[event] = entries;
  }
  return hooks;
}

function compileModule(source, name) {
  // Tiny ESM shim: `export default {…}` → return value.
  const code = String(source).replace(/export\s+default\s+/, 'return ');
  // eslint-disable-next-line no-new-func
  return new Function(code)();
}

function compileFunction(body, name) {
  const text = String(body).trim();
  if (/^(async\s+)?(function|\(|[\w$]+\s*=>)/.test(text)) {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${text});`)();
  }
  // A bare body gets `ctx` in scope.
  // eslint-disable-next-line no-new-func
  return new Function('ctx', text);
}

/**
 * Run every hook for an event.
 * @returns {Promise<{ blocked?: string, note?: string, args?: object, approve?: boolean, logs: string[] }>}
 */
export async function runHooks(hooks, event, ctx, { onLog = () => {}, timeoutMs = 3000 } = {}) {
  const entries = (hooks?.[event] || []).filter((entry) => matcherFor(entry.match)(ctx.tool || ctx.event || '*'));
  const outcome = { logs: [] };
  if (!entries.length) return outcome;
  for (const entry of entries) {
    let result;
    try {
      result = await Promise.race([
        Promise.resolve(entry.run(ctx)),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`hook timed out after ${timeoutMs}ms`)), timeoutMs)),
      ]);
    } catch (err) {
      const message = `${event} hook failed: ${err.message}`;
      outcome.logs.push(message);
      onLog(message);
      continue;
    }
    if (!result) continue;
    if (typeof result === 'string') {
      outcome.note = outcome.note ? `${outcome.note}\n${result}` : result;
      continue;
    }
    if (result.block) {
      outcome.blocked = String(result.block);
      return outcome;
    }
    if (result.args && typeof result.args === 'object') outcome.args = { ...(outcome.args || {}), ...result.args };
    if (result.note) outcome.note = outcome.note ? `${outcome.note}\n${result.note}` : result.note;
    if (result.approve === true) outcome.approve = true;
    if (result.approve === false) outcome.blocked = result.reason || 'denied by hook';
    if (result.log) {
      outcome.logs.push(String(result.log));
      onLog(String(result.log));
    }
  }
  return outcome;
}

/** Merge hook files from the project + settings. */
export async function loadHooks({ fs, projectId, settings }) {
  const hooks = {};
  const sources = [];
  const file = await fs.readText(projectId, '.alphacode/hooks.js').catch(() => null);
  if (file) sources.push({ name: '.alphacode/hooks.js', text: file });
  const json = await fs.readText(projectId, '.alphacode/hooks.json').catch(() => null);
  if (json) sources.push({ name: '.alphacode/hooks.json', text: json });
  if (settings?.hooks) sources.push({ name: 'settings', text: settings.hooks });
  for (const source of sources) {
    try {
      const next = normalizeHooks(source.text, { source: source.name });
      for (const [event, list] of Object.entries(next)) hooks[event] = [...(hooks[event] || []), ...list];
    } catch (err) {
      throw new Error(`${source.name}: ${err.message}`);
    }
  }
  return hooks;
}

export const HOOK_DOCS = `Hooks live in .alphacode/hooks.js and run inside the page:

export default {
  pre_tool:  [{ match: 'bash', run: () => ({ block: 'no shell here' }) }],
  post_tool: [{ match: 'write', run: () => ({ note: 'file saved' }) }],
};

Events: ${HOOK_EVENTS.join(', ')}.
Return { block }, { args }, { note }, { approve } — or nothing.`;

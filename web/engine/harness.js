/**
 * The agent loop, in the browser.
 *
 * assemble context → call model (streamed) → gate each tool → execute in the
 * page → feed results back → repeat until the model stops asking for tools.
 * Everything Claude-Code-shaped lives here: permission modes, todo working
 * memory, plan mode, compaction, subagents, checkpoints, stop/interrupt.
 */
import { streamChat, planAttempts, PROVIDERS } from './providers.js';
import { runHooks } from './hooks.js';
import { buildTools, toolsForMode, toOpenAITools, summarize, toolTitle } from './tools.js';
import { getGovernor, classifyProviderError } from './agent/governor.js';
import { buildSystemPrompt, budgetNote, rankFiles } from './agent/prompt.js';

/**
 * Requests per turn.
 *
 * This used to be 40, which is not a budget — it is permission to burn a shared
 * free tier forty times while hunting for a working provider. A well-prompted
 * agent finishes a normal task in two or three requests; eight is a lot of
 * work; past that the turn is going in circles and stopping early with a
 * useful summary is better than maxing out the allowance.
 */
const MAX_REQUESTS = 8;
const MAX_SUBAGENT_REQUESTS = 4;
/** How many times a productive turn may borrow another segment of requests. */
const MAX_SEGMENTS = 3;
/** Kept as an alias because other modules and tests import it. */
const MAX_ITERATIONS = MAX_REQUESTS;
const CONTEXT_WINDOW = 200_000;
const COMPACT_AT = 0.86;

/** Path normalisation for the bookkeeping above (the fs does the real one). */
const normPathLite = (path) => String(path || '').replace(/^\/+/, '').replace(/\/{2,}/g, '/');

/** Tools that never touch shared state, so a batch of them can run at once. */
const PARALLEL_SAFE = new Set([
  'read', 'read_many', 'ls', 'glob', 'grep', 'web_fetch', 'runtime_info', 'db_list', 'db_query', 'db_schema', 'db_rows',
]);

class Emitter {
  constructor() {
    this.handlers = new Set();
    this.log = [];
  }
  on(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }
  emit(event) {
    const stamped = { ...event, t: Date.now(), i: this.log.length + 1 };
    this.log.push(stamped);
    if (this.log.length > 5000) this.log.splice(0, 1000);
    for (const fn of this.handlers) {
      try {
        fn(stamped);
      } catch (err) {
        console.error('[harness] handler failed', err);
      }
    }
  }
}

export class Run {
  constructor({ id, threadId, projectId, mode = 'default', model = '', guest = true }) {
    this.id = id;
    this.threadId = threadId;
    this.projectId = projectId;
    this.mode = mode;
    this.model = model;
    this.guest = guest;
    this.status = 'queued';
    this.events = new Emitter();
    this.controller = new AbortController();
    this.permissions = new Map();
    this.emitted = [];
  }

  get signal() {
    return this.controller.signal;
  }

  emit(event) {
    this.emitted.push(event);
    this.events.emit(event);
  }

  onEvent(fn) {
    return this.events.on(fn);
  }

  stop() {
    this.status = 'stopped';
    this.controller.abort();
    for (const [, resolve] of this.permissions) resolve({ approved: false, reason: 'stopped' });
    this.permissions.clear();
  }

  /** Ask the UI for approval; resolves on allow/deny, times out as deny. */
  requestPermission(request) {
    return new Promise((resolve) => {
      const id = request.requestId || `perm_${Math.random().toString(36).slice(2, 10)}`;
      const timer = setTimeout(() => {
        this.permissions.delete(id);
        this.emit({ type: 'permission_timeout', requestId: id });
        resolve({ approved: false, reason: 'timeout' });
      }, 10 * 60_000);
      this.permissions.set(id, (decision) => {
        clearTimeout(timer);
        this.permissions.delete(id);
        resolve({ approved: Boolean(decision?.approved), reason: decision?.reason || '' });
      });
      this.emit({ type: 'permission', requestId: id, ...request });
    });
  }

  resolvePermission(requestId, decision) {
    const fn = this.permissions.get(requestId);
    if (!fn) return false;
    fn(decision);
    return true;
  }
}

const EMPTY = '(no content returned by the model)';

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  const text = String(raw).trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('arguments were not valid JSON');
  }
}

const estimate = (text) => Math.ceil(String(text || '').length / 3.6);

/** Commands that cannot change the workspace, so they never need approval. */
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'tree', 'find', 'grep', 'stat', 'du', 'date',
  'which', 'echo', 'env', 'printenv', 'whoami', 'rg', 'file', 'diff', 'sort', 'uniq',
]);

export class Harness {
  /**
   * @param {object} deps
   * @param {import('./store.js').Store} deps.store
   * @param {import('./fs.js').FileSystem} deps.fs
   * @param {import('./shell.js').Shell} deps.shell
   * @param {(path:string)=>Promise<object>} deps.getDb       cached db handle
   * @param {(path:string)=>void} deps.releaseDb
   * @param {(args:object)=>Promise<object>} deps.deploy
   * @param {()=>object} deps.settings
   * @param {(event:object)=>void} deps.emit
   * @param {(req:object)=>Promise<object>} deps.confirm
   * @param {(args:object)=>Promise<object>} deps.runSubagent
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.messages = [];
    this.usage = { input: 0, output: 0, calls: 0 };
    this.todos = [];
    this.plan = '';
    this.filesChanged = new Set();
    this.detectedModel = '';
    this.provider = '';
  }

  /**
   * The system prompt.
   *
   * Built from `agent/prompt.js` so the request-efficiency contract (batch your
   * tool calls, don't re-read, don't verify every step) is stated once and
   * travels with the ranking that keeps the file list short.
   */
  systemPrompt({ subagentType = '' } = {}) {
    const project = this.project || { name: 'project' };
    return buildSystemPrompt({
      request: this.request || '',
      files: (this.fileIndex || []).map((path) => ({ path })),
      recent: [...this.filesChanged],
      openFile: this.openFile || '',
      todos: this.todos,
      plan: this.plan,
      rules: this.rulesText || '',
      memory: this.memoryText || '',
      projectName: project.name || 'project',
      stackHint: this.stackHint || '',
      subagentType,
      budgetLeft: this.governor ? this.governor.remaining : 0,
    });
  }

  /** Project rules and durable notes, read once per turn. Never a request. */
  async loadProjectMemory() {
    const read = async (path, max) => {
      try {
        const exists = await this.fs.exists?.(this.projectId, path);
        if (exists === false) return '';
        const file = await this.fs.read(this.projectId, path);
        const text = typeof file === 'string' ? file : file?.content || '';
        return text.slice(0, max);
      } catch {
        return '';
      }
    };
    this.rulesText = await read('.alphacode/rules.md', 4000);
    this.memoryText = await read('.alphacode/memory.md', 3000);
    try {
      const pkg = await this.fs.read(this.projectId, 'package.json');
      const parsed = JSON.parse(typeof pkg === 'string' ? pkg : pkg?.content || '{}');
      const deps = Object.keys({ ...parsed.dependencies, ...parsed.devDependencies }).slice(0, 8);
      const scripts = Object.keys(parsed.scripts || {}).slice(0, 4);
      this.stackHint = [deps.length ? `stack: ${deps.join(', ')}` : '', scripts.length ? `scripts: ${scripts.join(', ')}` : '']
        .filter(Boolean)
        .join('\n');
    } catch {
      this.stackHint = '';
    }
  }

  /**
   * One model request, with the governor deciding which provider gets it.
   *
   * The old loop walked the whole provider chain on any error, which is how a
   * single 429 became five failures and five cooldowns. Now:
   *
   *   • providers in a long cooldown are dropped before we start;
   *   • a provider that just worked is tried first;
   *   • nothing is retried unless the failure is actually retryable;
   *   • `Retry-After` is honoured, and one bounded second pass is the only
   *     retry we do.
   *
   * @returns {Promise<{content:string, toolCalls:Array, usage:object, finishReason:string, provider:string}>}
   */
  async callModel({ system, messages, tools, maxRequests = MAX_REQUESTS }) {
    const settings = this.settings();
    const governor = this.governor || (this.governor = getGovernor());
    const planned = planAttempts({ model: this.requestedModel || this.modelRef || '', settings });
    if (!planned.length) throw new Error('No model providers are configured. Add a key in Settings → Providers.');

    let lastError = null;
    let passes = 0;
    let attemptsLeft = maxRequests;

    while (passes < 2 && attemptsLeft > 0) {
      passes += 1;
      const ordered = governor.order(planned);
      if (!ordered.length) {
        // Everything is either cooling down or dropped. Report the soonest.
        const soonest = planned
          .map((a) => ({ a, wait: governor.cooldownFor(a.provider) }))
          .sort((x, y) => x.wait - y.wait)[0];
        if (lastError) break;
        if (soonest) {
          // This is a pause, not a crash: the UI offers a Continue button.
          const paused = new Error(
            `Every provider is cooling down — ${PROVIDERS[soonest.a.provider]?.label || soonest.a.provider} is back in ${Math.ceil(soonest.wait / 1000)}s.`,
          );
          paused.paused = true;
          paused.retryInMs = soonest.wait;
          throw paused;
        }
        throw new Error('No model providers are available. Add a key in Settings → Providers.');
      }

      let retryableSeen = null;
      for (const attempt of ordered) {
        if (this.signal?.aborted) throw new DOMException('stopped', 'AbortError');
        if (attemptsLeft <= 0 && attempt.provider !== 'demo') break;

        // The offline demo model costs nothing, so it is exempt from the budget.
        const metered = attempt.provider !== 'demo';
        const byok = attempt.via === 'byok';
        let budgetOut = false;
        // A free router may refuse one model and serve another perfectly well.
        // Walking the ranked candidates inside the same provider attempt is what
        // keeps "works on this phone, not that one" from becoming a provider
        // change — and it costs nothing unless the first model actually fails.
        const candidates = [attempt.model, ...(attempt.models || [])]
          .filter(Boolean)
          .filter((model, index, all) => all.indexOf(model) === index)
          .filter((model) => !metered || governor.modelAvailable(attempt.provider, model));
        const modelList = candidates.length ? candidates : [attempt.model];

        for (const model of modelList) {
          if (this.signal?.aborted) throw new DOMException('stopped', 'AbortError');
          if (metered) {
            // Every request — including a retry on a different model — spends
            // one unit of the budget and one slot of the rate window.
            const wait = governor.waitForSlot(attempt.provider, { byok });
            if (wait > 500) this.emit({ type: 'rate_wait', provider: attempt.provider, ms: wait });
            const ok = await governor.reserve(attempt.provider, { byok, signal: this.signal }).catch((err) => {
              if (err?.name === 'AbortError') throw err;
              return false;
            });
            if (!ok) {
              this.emit({ type: 'provider_skip', provider: attempt.provider, reason: governor.remaining > 0 ? 'waiting for a rate-limit slot' : 'request budget spent' });
              budgetOut = governor.remaining <= 0;
              break;
            }
          }
          attemptsLeft -= 1;
          this.emit({
            type: 'model',
            provider: attempt.provider,
            model,
            via: attempt.via,
            label: PROVIDERS[attempt.provider]?.label || attempt.provider,
            request: this.usage.calls + 1,
            remaining: governor.remaining,
          });

          const started = Date.now();
          try {
            const result = await streamChat({
              provider: attempt.provider,
              model,
              messages,
              system,
              tools: toOpenAITools(tools),
              key: attempt.key,
              baseUrl: attempt.baseUrl,
              signal: this.signal,
              relay: settings.relay !== false,
              maxTokens: settings.maxTokens || 16_384,
              onEvent: (ev) => {
                if (ev.type === 'text') this.emit({ type: 'text', text: ev.text });
                if (ev.type === 'reasoning') this.emit({ type: 'reasoning', text: ev.text });
                if (ev.type === 'relay') this.emit({ type: 'relay', provider: attempt.provider });
              },
            });
            if (metered) governor.reward(attempt.provider);
            this.provider = attempt.provider;
            this.detectedModel = model;
            this.usage.calls += 1;
            this.usage.input += result.usage?.input || 0;
            this.usage.output += result.usage?.output || 0;
            this.emit({
              type: 'usage',
              usage: {
                ...this.usage,
                contextWindow: CONTEXT_WINDOW,
                inputTokens: result.usage?.input || 0,
                outputTokens: result.usage?.output || 0,
                durationMs: Date.now() - started,
                budget: governor.budget,
                remaining: governor.remaining,
              },
              model,
              provider: attempt.provider,
              via: attempt.via,
            });
            if (result.partial) result.content = `${result.partial}${result.content || ''}`;
            return { ...result, provider: attempt.provider, model };
          } catch (err) {
            if (err?.name === 'AbortError') throw err;
            lastError = err;
            const classification = classifyProviderError(err);

            // A missing model is the model's problem, not the provider's. Park
            // it for a while and try the next candidate on the same provider.
            if (classification.kind === 'model') {
              if (metered) governor.penalizeModel(attempt.provider, model, classification);
              this.emit({
                type: 'provider_error',
                provider: attempt.provider,
                model,
                kind: classification.kind,
                retryable: false,
                cooldownMs: 0,
                message: `${model} is not available on ${PROVIDERS[attempt.provider]?.label || attempt.provider} — trying another model.`,
              });
              continue;
            }

            if (metered) governor.penalize(attempt.provider, classification, { byok });
            this.emit({
              type: 'provider_error',
              provider: attempt.provider,
              model,
              kind: classification.kind,
              retryable: classification.retryable,
              cooldownMs: governor.cooldownFor(attempt.provider),
              message: err.message,
            });
            // A context overflow is not a provider problem — the caller has to
            // compact and try again, and spending another provider on it would
            // just overflow there too.
            if (classification.kind === 'context') {
              const overflow = new Error(err.message);
              overflow.contextOverflow = true;
              throw overflow;
            }
            if (classification.retryable) retryableSeen = classification;
            break;
          }
        }
        // The budget is spent, but the offline demo costs nothing: breaking out
        // of the whole chain here would end a starved turn with a half-written
        // project even though a free model was still right there.
        if (budgetOut && !ordered.slice(ordered.indexOf(attempt) + 1).some((a) => a.provider === 'demo')) break;
      }

      // One bounded second pass, and only when something was worth retrying
      // and the wait is short enough to be worth the user's patience.
      if (!retryableSeen) break;
      const ready = ordered
        .filter((a) => a.provider !== 'demo')
        .map((a) => ({ a, wait: governor.cooldownFor(a.provider) }))
        .sort((x, y) => x.wait - y.wait)[0];
      if (!ready || ready.wait > 6_000) break;
      if (ready.wait > 0) {
        await governor._sleep(ready.wait, this.signal).catch((err) => {
          if (err?.name === 'AbortError') throw err;
        });
      }
    }

    if (!lastError && governor.remaining <= 0) {
      const paused = new Error(`Paused after ${governor.used} model requests to stay inside the rate limit.`);
      paused.paused = true;
      throw paused;
    }
    throw lastError || new Error('No model providers are available. Add a key in Settings → Providers.');
  }

  /** Graduated compaction: trim old tool output, then summarise. */
  shapeContext() {
    let messages = this.messages.map((m) => ({ ...m }));
    const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
    for (const idx of toolIdx.slice(0, Math.max(0, toolIdx.length - 4))) {
      const m = messages[idx];
      if (typeof m.content === 'string' && m.content.length > 2500) {
        messages[idx] = { ...m, content: `${m.content.slice(0, 1200)}\n… [trimmed ${m.content.length - 1200} chars]` };
      }
    }
    const total = messages.reduce((sum, m) => sum + estimate(m.content) + estimate(JSON.stringify(m.tool_calls || '')) + 8, 0);
    if (total < CONTEXT_WINDOW * COMPACT_AT) return messages;

    const keep = 8;
    const dropped = messages.slice(0, Math.max(0, messages.length - keep));
    const tail = messages.slice(-keep);
    const summary = dropped
      .filter((m) => m.role === 'assistant' || m.role === 'user')
      .map((m) => `${m.role}: ${String(m.content).slice(0, 400)}`)
      .join('\n')
      .slice(0, 6000);
    this.emit({ type: 'compaction', dropped: dropped.length, kept: tail.length });
    return [
      { role: 'user', content: `[Context compacted. Summary of the earlier conversation:]\n${summary}\n[End summary — continue from here.]` },
      ...tail,
    ];
  }

  /**
   * Last-resort shrink after a context-overflow error.
   *
   * Keeps the request and the newest exchanges, and cuts old tool output to a
   * stub. Deliberately blunt: this runs once, when the alternative is failing
   * the turn.
   */
  compressContext() {
    const keep = 6;
    const head = this.messages.find((m) => m.role === 'user');
    const tail = this.messages.slice(-keep).map((m) => {
      const copy = { ...m };
      if (typeof copy.content === 'string' && copy.content.length > 1200) {
        copy.content = `${copy.content.slice(0, 600)}\n… [trimmed after a context overflow]`;
      }
      if (copy.tool_calls) {
        copy.tool_calls = copy.tool_calls.map((call) => ({ ...call, arguments: String(call.arguments || '').slice(0, 400) }));
      }
      return copy;
    });
    const headText = head ? `[Earlier conversation was dropped to fit the model's context window.]\nThe original request was: ${String(head.content).slice(0, 1500)}` : '';
    this.messages = [
      ...(headText ? [{ role: 'user', content: headText }] : []),
      ...tail.filter((m) => m !== head),
    ];
    return this.messages;
  }

  async runSubagent({ description, prompt, subagentType = 'general' }) {
    this.emit({ type: 'subagent_start', description, subagent: subagentType });
    const messages = [{ role: 'user', content: prompt }];
    const tools = toolsForMode(this.tools, 'default', subagentType);
    let summaryText = '';
    let steps = 0;
    // A subagent is a tool call, not a second agent: it gets a small cap and
    // spends from the same turn budget, so spawning one cannot blow the limit.
    for (let i = 0; i < MAX_SUBAGENT_REQUESTS; i++) {
      if (this.signal?.aborted) break;
      if (this.governor && this.governor.remaining <= 0) break;
      const result = await this.callModel({ system: this.systemPrompt({ subagentType }), messages, tools, maxRequests: 2 }).catch((err) => {
        this.emit({ type: 'subagent_error', message: err.message });
        return null;
      });
      if (!result) break;
      messages.push({ role: 'assistant', content: result.content || '', tool_calls: result.toolCalls?.length ? result.toolCalls : undefined });
      if (!result.toolCalls?.length) {
        summaryText = result.content || '(no findings)';
        break;
      }
      for (const call of result.toolCalls) {
        const tool = tools.find((t) => t.name === call.name);
        let content;
        if (!tool) content = `Error: unknown tool ${call.name}`;
        else {
          try {
            const out = await tool.run(parseArgs(call.arguments));
            content = String(out.text ?? '').slice(0, 8000);
            steps++;
          } catch (e) {
            content = `Error: ${e.message}`;
          }
        }
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content });
      }
    }
    this.emit({ type: 'subagent_end', description, steps });
    return { summary: summaryText || '(subagent hit its step limit)', steps };
  }

  toolContext() {
    return {
      fs: this.fs,
      store: this.store,
      projectId: this.projectId,
      shell: this.shell,
      getDb: this.getDb,
      releaseDb: this.releaseDb,
      emit: (event) => this.emit(event),
      beforeMutation: (label) => this.beforeMutation?.(label),
      setTodos: (todos) => {
        this.todos = todos;
      },
      setPlan: (plan) => {
        this.plan = plan;
      },
      runSubagent: (args) => this.runSubagent(args),
      deploy: (args) => this.deploy(args),
      runtimeInfo: () => this.runtimeInfo(),
      confirm: (req) => this.requestPermission(req),
      allowDeploy: this.allowDeploy !== false,
      node: this.node || null,
      jobs: this.jobs || null,
      mcpTools: this.mcpTools || [],
      snapshot: async () => {
        // Exclude node_modules at the listing stage: a big install would
        // otherwise fill the 2000-file budget before any project file is read.
        const files = await this.fs.list(this.projectId, { includeModules: false });
        const out = {};
        for (const file of files.slice(0, 2000)) {
          try {
            out[file.path] = await this.fs.readText(this.projectId, file.path);
          } catch {
            /* binary */
          }
        }
        return out;
      },
    };
  }

  /** Risk classification used by the permission gate. */
  risksFor(tool, args) {
    const risks = [];
    if (tool.name === 'bash') {
      const cmd = String(args.command || '');
      if (/\brm\s+-[a-z]*r/.test(cmd) || /\brm\s+-rf?\s+\//.test(cmd)) risks.push('recursive delete');
      if (/\b(curl|wget)\b.*\|\s*(ba)?sh/.test(cmd)) risks.push('piping a download into a shell');
      if (/\b(sudo|chmod\s+777)\b/.test(cmd)) risks.push('privilege change');
    }
    if (tool.name === 'deploy') risks.push('publishes to the internet');
    if (tool.name === 'db_exec' && /drop\s+table|delete\s+from/i.test(args.sql || '')) risks.push('destructive SQL');
    return risks;
  }

  /**
   * A shell command that only reads cannot damage anything, so it should not
   * interrupt a run. Anything with a redirection, a pipe into a shell, or a
   * mutating verb still asks.
   */
  isReadOnlyShell(args) {
    const cmd = String(args.command || '').trim();
    if (!cmd) return false;
    if (/[>|]|&&|;|\$\("?/.test(cmd) && !/\|\s*(head|tail|wc|sort|uniq|grep|cat)\b/.test(cmd)) return false;
    const first = cmd.split(/\s+/)[0].replace(/^.*\//, '');
    return READ_ONLY_COMMANDS.has(first) && !/\brm\b|\bmv\b|\bcp\b|\btouch\b|\bmkdir\b|\bnpm\b|\bnpx\b|\bpip\b|\bnode\b/.test(cmd);
  }

  async gate(tool, args) {
    if (this.mode === 'bypass') return { approved: true };
    if (this.mode === 'accept-edits' && (tool.name === 'write' || tool.name === 'edit' || tool.name === 'multiedit')) return { approved: true };
    if (tool.name === 'bash' && this.isReadOnlyShell(args) && (this.mode === 'accept-edits' || this.mode === 'default')) {
      return { approved: true, note: 'read-only command' };
    }
    // default: reads and bookkeeping are free, everything that mutates asks.
    // accept-edits: file writes are free too; shell/db/deploy still ask.
    if (this.mode === 'default' && tool.readOnly) return { approved: true };
    if (this.mode === 'default' && ['todo_write', 'checkpoint'].includes(tool.name)) return { approved: true };
    if (this.mode === 'accept-edits' && ['todo_write', 'checkpoint', 'write', 'edit', 'multiedit'].includes(tool.name)) return { approved: true };
    const ask = this.confirm || ((req) => this.requestPermission(req));
    return ask({
      title: toolTitle(tool.name, args) || `${tool.name}`,
      kind: tool.name,
      tool: tool.name,
      command: tool.name === 'bash' ? args.command : '',
      args: sanitizeArgs(args),
      risks: this.risksFor(tool, args),
    });
  }

  /**
   * Run the tool calls from one assistant message.
   *
   * Three things here exist to keep a turn cheap:
   *
   *   • **Gates run in order, tools run in parallel** when they are read-only.
   *     Five reads used to be five awaits; now they are one round of I/O, so the
   *     model gets its answer sooner and needs fewer follow-up requests.
   *   • **Identical calls in a batch are collapsed.** Models re-read the same
   *     file twice more often than you would think.
   *   • **A completed read is remembered**, so the same file read again after
   *     being written is answered from that note rather than re-sent in bulk.
   */
  async executeToolCalls(calls, tools) {
    const results = new Map();
    const jobs = [];
    const seen = new Map();
    this.toolTitles = this.toolTitles || new Map();
    const toolTitles = this.toolTitles;

    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.name);
      if (!tool) {
        results.set(call.id, { id: call.id, name: call.name, content: `Error: unknown tool "${call.name}". Available: ${tools.map((t) => t.name).join(', ')}`, isError: true });
        continue;
      }
      let args;
      try {
        args = parseArgs(call.arguments);
      } catch (e) {
        results.set(call.id, { id: call.id, name: call.name, content: `Error: invalid arguments — ${e.message}`, isError: true });
        continue;
      }

      // Same read twice in one response: answer the second from the first.
      const fingerprint = `${tool.name}:${JSON.stringify(args)}`;
      if (tool.readOnly && seen.has(fingerprint)) {
        const first = seen.get(fingerprint);
        const title = toolTitle(tool.name, args);
        toolTitles.set(call.id, title);
        this.emit({ type: 'tool_start', toolCallId: call.id, name: tool.name, args: sanitizeArgs(args), title, readOnly: true, deduped: true });
        this.emit({ type: 'tool_end', toolCallId: call.id, name: tool.name, ok: true, summary: 'duplicate of an earlier call — skipped', durationMs: 0, deduped: true });
        results.set(call.id, {
          id: call.id,
          name: tool.name,
          title,
          content: `Identical to an earlier call in this same message (${first}); its result is above. Do not repeat calls you have already made.`,
          isError: false,
          deduped: true,
        });
        continue;
      }
      seen.set(fingerprint, tool.name === 'read' ? args.file_path || args.path || 'an earlier call' : 'an earlier call');

      jobs.push({ call, tool, args, started: Date.now(), notes: [] });
    }

    // Phase 1 — hooks and gates. Sequential on purpose: a confirmation dialog
    // must be answered one at a time, and hooks may rewrite arguments.
    const approved = [];
    for (const job of jobs) {
      const { call, tool, args, started } = job;
      let hookApproved = false;
      if (this.hooks) {
        const pre = await runHooks(this.hooks, 'pre_tool', { tool: tool.name, args, mode: this.mode, cwd: this.shell?.cwd || '' }, { onLog: (line) => this.emit({ type: 'hook', event: 'pre_tool', message: line }) });
        if (pre.blocked) {
          this.emit({ type: 'tool_end', toolCallId: call.id, name: tool.name, ok: false, summary: `blocked by hook: ${pre.blocked}`, durationMs: Date.now() - started });
          results.set(call.id, { id: call.id, name: tool.name, content: `Error: a project hook blocked this call: ${pre.blocked}`, isError: true });
          continue;
        }
        if (pre.args) job.args = { ...job.args, ...pre.args };
        if (pre.approve) hookApproved = true;
        if (pre.note) job.notes.push(pre.note);
      }
      const title = toolTitle(tool.name, job.args);
      toolTitles.set(call.id, title);
      this.emit({ type: 'tool_start', toolCallId: call.id, name: tool.name, args: sanitizeArgs(job.args), title, readOnly: Boolean(tool.readOnly) });
      const decision = hookApproved ? { approved: true, reason: 'hook' } : await this.gate(tool, job.args);
      if (!decision.approved) {
        this.emit({ type: 'tool_end', toolCallId: call.id, name: tool.name, ok: false, summary: decision.reason || 'denied', durationMs: Date.now() - started });
        results.set(call.id, { id: call.id, name: tool.name, content: `Error: the user denied this action${decision.reason ? ` (${decision.reason})` : ''}. Ask before retrying differently.`, isError: true });
        continue;
      }
      approved.push(job);
    }

    // Phase 2 — execute. Read-only batches go out together; anything that
    // mutates shared state stays in order so the transcript reads correctly.
    const canParallel = approved.length > 1 && approved.every((job) => PARALLEL_SAFE.has(job.tool.name) && job.tool.readOnly);
    const runOne = async (job) => {
      const { call, tool } = job;
      const args = job.args;
      const started = job.started;
      try {
        const out = await tool.run(args);
        if (tool.name === 'write' || tool.name === 'edit' || tool.name === 'multiedit') {
          this.filesChanged.add(args.file_path || args.path);
          this.fileIndexDirty = true;
        } else if (tool.name === 'write_many') {
          for (const entry of args.files || []) if (entry?.file_path) this.filesChanged.add(normPathLite(entry.file_path));
          this.fileIndexDirty = true;
        } else if (tool.name === 'scaffold') {
          for (const path of out.display?.files || []) this.filesChanged.add(path);
          this.fileIndexDirty = true;
        }
        if (this.hooks?.post_tool) {
          const post = await runHooks(this.hooks, 'post_tool', { tool: tool.name, args, result: out.text?.slice(0, 2000), isError: Boolean(out.isError) }, { onLog: (line) => this.emit({ type: 'hook', event: 'post_tool', message: line }) });
          if (post.note) job.notes.push(post.note);
        }
        if (job.notes.length) out.text = `${out.text}\n\n[hooks] ${job.notes.join(' · ')}`;
        const summary = await summarize(tool, out);
        const cardTitle = toolTitles.get(call.id) || '';
        this.emit({ type: 'tool_end', toolCallId: call.id, name: tool.name, ok: !out.isError, summary, display: out.display || null, durationMs: Date.now() - started });
        results.set(call.id, { id: call.id, name: tool.name, title: cardTitle, content: out.text, isError: Boolean(out.isError), display: out.display });
      } catch (err) {
        this.emit({ type: 'tool_end', toolCallId: call.id, name: tool.name, ok: false, summary: String(err.message).slice(0, 160), durationMs: Date.now() - started });
        results.set(call.id, { id: call.id, name: tool.name, content: `Error: ${err.message}`, isError: true });
      }
    };

    if (canParallel) await Promise.all(approved.map(runOne));
    else for (const job of approved) await runOne(job);

    // Preserve the model's original call order regardless of completion order.
    return calls.map((call) => results.get(call.id)).filter(Boolean);
  }

  /**
   * Run one user turn to completion.
   * @returns {Promise<{finishReason:string, text:string}>}
   */
  async send(userText) {
    this.tools = buildTools(this.toolContext());
    const request = String(userText || '').slice(0, 40_000);
    this.request = request;
    this.fileIndexDirty = false;
    this.fileIndex = (await this.fs.list(this.projectId, { includeModules: false })).map((f) => f.path);
    await this.loadProjectMemory();

    const governor = this.governor || (this.governor = getGovernor());
    const settings = this.settings() || {};
    // One turn, one budget. Cooldowns survive it; the counter does not.
    const segment = Number(settings.requestBudget) > 0 ? Number(settings.requestBudget) : MAX_REQUESTS;
    governor.budget = segment;
    // The hard cap is what a single turn may ever spend, however many segments
    // it borrows. Three segments is a big, autonomous build; past that the turn
    // is going in circles.
    governor.hardCap = Math.max(segment, Number(settings.requestCap) || segment * MAX_SEGMENTS);
    governor.used = 0;
    this.emit({ type: 'budget', budget: governor.budget, remaining: governor.budget });

    this.messages.push({ role: 'user', content: request });
    await this.store.addMessage(this.threadId, 'user', { text: request });

    let finishReason = 'stop';
    let finalText = '';
    let overflows = 0;
    // Unmetered providers (the offline demo) do not consume budget, so the
    // loop needs its own hard stop as well.
    let iterations = 0;
    while (iterations < governor.hardCap + 2) {
      iterations += 1;
      if (this.signal?.aborted) {
        finishReason = 'stopped';
        break;
      }
      let messages = this.shapeContext();
      const tools = toolsForMode(this.tools, this.mode);

      let result;
      try {
        result = await this.callModel({ system: this.systemPrompt(), messages, tools });
      } catch (err) {
        if (err?.name === 'AbortError') {
          finishReason = 'stopped';
          break;
        }
        if (err?.paused) {
          // Out of this segment's requests. If the turn is still making progress
          // and the hard cap allows it, borrow another segment and keep going:
          // that is autonomy. The rate window still gates every request.
          // A cooldown pause (`retryInMs`) cannot be fixed by more budget — the
          // providers are simply resting — so only extend when it was the count.
          const granted = err.retryInMs || settings.autoContinue === false ? 0 : governor.extend(MAX_REQUESTS);
          if (granted > 0) {
            this.emit({
              type: 'budget_extended',
              granted,
              budget: governor.budget,
              used: governor.used,
              message: `Continuing — ${granted} more requests, still inside the rate limit.`,
            });
            continue;
          }
          finishReason = 'budget';
          this.lastPause = err.retryInMs
            ? { reason: 'rate', retryInMs: err.retryInMs, budget: governor.budget }
            : { reason: 'budget', retryInMs: 0, budget: governor.budget };
          break;
        }
        // A context overflow is recoverable without spending the rest of the
        // turn: shrink the conversation and ask once more.
        if (err?.contextOverflow && overflows < 1) {
          overflows += 1;
          this.compressContext();
          this.emit({ type: 'compaction', dropped: this.messages.length, kept: 6, reason: 'context overflow' });
          continue;
        }
        finishReason = 'error';
        this.emit({ type: 'error', message: err.message });
        throw err;
      }

      const content = result.content || '';
      if (content.trim()) this.emit({ type: 'text_done', text: content });
      const assistant = { role: 'assistant', content: content || '' };
      if (result.toolCalls?.length) assistant.tool_calls = result.toolCalls;
      if (!assistant.content && !assistant.tool_calls) assistant.content = EMPTY;
      this.messages.push(assistant);
      await this.store.addMessage(this.threadId, 'assistant', { text: content, toolCalls: result.toolCalls?.length ? result.toolCalls : undefined });
      finalText = content || finalText;

      if (!result.toolCalls?.length) {
        finishReason = result.finishReason || 'stop';
        break;
      }

      // The file list only has to be rebuilt when a tool could have changed it.
      if (this.fileIndexDirty) {
        this.fileIndex = (await this.fs.list(this.projectId, { includeModules: false })).map((f) => f.path);
        this.fileIndexDirty = false;
      }

      const toolResults = await this.executeToolCalls(result.toolCalls, tools);

      // Tell the model how much rope is left, in the last result it will read.
      const note = budgetNote(governor.remaining);
      if (note && toolResults.length) toolResults[toolResults.length - 1].content += `\n\n[budget] ${note}`;

      for (const tr of toolResults) {
        this.messages.push({ role: 'tool', tool_call_id: tr.id, name: tr.name, content: tr.content });
        await this.store.addMessage(this.threadId, 'tool', {
          toolCallId: tr.id,
          name: tr.name,
          title: tr.title || '',
          content: tr.content,
          isError: tr.isError,
          display: tr.display,
        });
      }
    }
    if (finishReason === 'budget') {
      this.emit({
        type: 'budget_exhausted',
        budget: governor.budget,
        used: governor.used,
        message: this.lastPause?.reason === 'rate'
          ? `Paused after ${governor.used} requests — every provider is cooling down. Continue when you are ready.`
          : `Paused after ${governor.used} requests this turn. Continue and I will pick up exactly where I left off.`,
      });
    }
    return { finishReason, text: finalText };
  }
}

function sanitizeArgs(args) {
  const clone = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v === 'string' && v.length > 600) clone[k] = `${v.slice(0, 600)}…`;
    else if (typeof v === 'object' && v !== null) {
      const json = JSON.stringify(v);
      clone[k] = json.length > 600 ? `${json.slice(0, 600)}…` : v;
    } else clone[k] = v;
  }
  return clone;
}

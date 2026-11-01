/**
 * The agent loop, in the browser.
 *
 * assemble context → call model (streamed) → gate each tool → execute in the
 * page → feed results back → repeat until the model stops asking for tools.
 * Everything Claude-Code-shaped lives here: permission modes, todo working
 * memory, plan mode, compaction, subagents, checkpoints, stop/interrupt.
 */
import { streamChat, planAttempts, PROVIDERS } from './providers.js';
import { buildTools, toolsForMode, toOpenAITools, summarize, toolTitle } from './tools.js';

const MAX_ITERATIONS = 40;
const MAX_SUBAGENT_ITERATIONS = 16;
const CONTEXT_WINDOW = 200_000;
const COMPACT_AT = 0.86;

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

  systemPrompt({ subagentType = '' } = {}) {
    const project = this.project || { name: 'project' };
    const files = (this.fileIndex || []).slice(0, 80).map((f) => `- ${f}`).join('\n');
    const todos = this.todos.length
      ? this.todos.map((t) => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`).join('\n')
      : '- (none yet — create a plan with todo_write)';
    const base = `You are AlphaCode, a coding agent running entirely inside the user's browser.

## How this environment differs from a normal machine
- The workspace is an in-browser filesystem (OPFS). Paths are relative to the project root; "/" is the root.
- The \`bash\` tool is a real shell implementation over that filesystem: ls, cat, grep, find, mkdir, rm, mv, cp, head, tail, wc, echo, sed-like pipelines, \`node <file>\` (JS in a sandbox), \`npm run <script>\`, \`python\` (Pyodide when loaded), \`sqlite3\`, \`curl\`. It is not GNU bash: no apt, no docker, no native binaries.
- There is no server. Nothing you do is uploaded anywhere. Files persist in this browser only.
- Deploys go to the user's own Cloudflare / Vercel / Netlify account through their OAuth connection. The \`deploy\` tool opens the right flow; you never handle their secrets.

## Rules
- Read before you edit. Never guess file contents.
- Make the smallest correct change; keep existing style.
- Run the project after changing it (bash: \`node\`/\`npm run\`, or \`sqlite3\` for data) and fix what breaks.
- Keep todo_write current: exactly one item in_progress.
- When the task is done, stop calling tools and summarise what changed.

## Project
name: ${project.name}
files:
${files || '- (empty)'}

## Todo list
${todos}
${this.plan ? `\n## Plan (approved)\n${this.plan}\n` : ''}${subagentType ? `\nYou are a ${subagentType} subagent: gather facts and report a concise summary. You cannot modify files.` : ''}`;
    return base;
  }

  async callModel({ system, messages, tools }) {
    const settings = this.settings();
    const attempts = planAttempts({ model: this.requestedModel || this.modelRef || '', settings });
    let lastError = null;
    for (const attempt of attempts) {
      if (this.signal?.aborted) throw new DOMException('stopped', 'AbortError');
      this.emit({
        type: 'model',
        provider: attempt.provider,
        model: attempt.model,
        via: attempt.via,
        label: PROVIDERS[attempt.provider]?.label || attempt.provider,
      });
      try {
        const started = Date.now();
        const result = await streamChat({
          provider: attempt.provider,
          model: attempt.model,
          messages,
          system,
          tools: toOpenAITools(tools),
          key: attempt.key,
          baseUrl: attempt.baseUrl,
          signal: this.signal,
          maxTokens: settings.maxTokens || 8192,
          onEvent: (ev) => {
            if (ev.type === 'text') this.emit({ type: 'text', text: ev.text });
            if (ev.type === 'reasoning') this.emit({ type: 'reasoning', text: ev.text });
          },
        });
        this.provider = attempt.provider;
        this.detectedModel = attempt.model;
        this.usage.calls += 1;
        this.usage.input += result.usage?.input || 0;
        this.usage.output += result.usage?.output || 0;
        this.emit({
          type: 'usage',
          usage: { ...this.usage, contextWindow: CONTEXT_WINDOW, inputTokens: result.usage?.input || 0, outputTokens: result.usage?.output || 0, durationMs: Date.now() - started },
          model: attempt.model,
          provider: attempt.provider,
          via: attempt.via,
        });
        return result;
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        lastError = err;
        this.emit({ type: 'provider_error', provider: attempt.provider, message: err.message });
      }
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

  async runSubagent({ description, prompt, subagentType = 'general' }) {
    this.emit({ type: 'subagent_start', description, subagent: subagentType });
    const messages = [{ role: 'user', content: prompt }];
    const tools = toolsForMode(this.tools, 'default', subagentType);
    let summaryText = '';
    let steps = 0;
    for (let i = 0; i < MAX_SUBAGENT_ITERATIONS; i++) {
      if (this.signal?.aborted) break;
      const result = await this.callModel({ system: this.systemPrompt({ subagentType }), messages, tools }).catch((err) => {
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

  async gate(tool, args) {
    if (this.mode === 'bypass') return { approved: true };
    if (this.mode === 'accept-edits' && (tool.name === 'write' || tool.name === 'edit' || tool.name === 'multiedit')) return { approved: true };
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

  async executeToolCalls(calls, tools) {
    const results = [];
    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.name);
      if (!tool) {
        results.push({ id: call.id, name: call.name, content: `Error: unknown tool "${call.name}". Available: ${tools.map((t) => t.name).join(', ')}`, isError: true });
        continue;
      }
      let args;
      try {
        args = parseArgs(call.arguments);
      } catch (e) {
        results.push({ id: call.id, name: call.name, content: `Error: invalid arguments — ${e.message}`, isError: true });
        continue;
      }
      this.emit({ type: 'tool_start', toolCallId: call.id, name: tool.name, args: sanitizeArgs(args), title: toolTitle(tool.name, args), readOnly: Boolean(tool.readOnly) });
      const started = Date.now();
      const decision = await this.gate(tool, args);
      if (!decision.approved) {
        this.emit({ type: 'tool_end', toolCallId: call.id, name: tool.name, ok: false, summary: decision.reason || 'denied', durationMs: Date.now() - started });
        results.push({ id: call.id, name: tool.name, content: `Error: the user denied this action${decision.reason ? ` (${decision.reason})` : ''}. Ask before retrying differently.`, isError: true });
        continue;
      }
      try {
        const out = await tool.run(args);
        if (tool.name === 'write' || tool.name === 'edit' || tool.name === 'multiedit') this.filesChanged.add(args.file_path);
        const summary = await summarize(tool, out);
        this.emit({ type: 'tool_end', toolCallId: call.id, name: tool.name, ok: !out.isError, summary, display: out.display || null, durationMs: Date.now() - started });
        results.push({ id: call.id, name: tool.name, content: out.text, isError: Boolean(out.isError), display: out.display });
      } catch (err) {
        this.emit({ type: 'tool_end', toolCallId: call.id, name: tool.name, ok: false, summary: String(err.message).slice(0, 160), durationMs: Date.now() - started });
        results.push({ id: call.id, name: tool.name, content: `Error: ${err.message}`, isError: true });
      }
    }
    return results;
  }

  /**
   * Run one user turn to completion.
   * @returns {Promise<{finishReason:string, text:string}>}
   */
  async send(userText) {
    this.tools = buildTools(this.toolContext());
    this.fileIndex = (await this.fs.list(this.projectId)).map((f) => f.path);
    const text = String(userText || '').slice(0, 40_000);
    this.messages.push({ role: 'user', content: text });
    await this.store.addMessage(this.threadId, 'user', { text });

    let finishReason = 'stop';
    let finalText = '';
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (this.signal?.aborted) {
        finishReason = 'stopped';
        break;
      }
      const messages = this.shapeContext();
      const tools = toolsForMode(this.tools, this.mode);
      const result = await this.callModel({ system: this.systemPrompt(), messages, tools });
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
      this.fileIndex = (await this.fs.list(this.projectId)).map((f) => f.path);
      const toolResults = await this.executeToolCalls(result.toolCalls, tools);
      for (const tr of toolResults) {
        this.messages.push({ role: 'tool', tool_call_id: tr.id, name: tr.name, content: tr.content });
        await this.store.addMessage(this.threadId, 'tool', { toolCallId: tr.id, name: tr.name, content: tr.content, isError: tr.isError, display: tr.display });
      }
    }
    if (finishReason === 'stop' && this.usage.calls >= MAX_ITERATIONS) finishReason = 'max_iterations';
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

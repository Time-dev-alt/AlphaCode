/**
 * AlphaCode agent harness — the agentic query loop.
 *
 * Mirrors the Claude Code turn model:
 *   context assembly → model call (streamed) → tool calls → permission gate →
 *   tool execution (parallel where safe) → results back into context → repeat,
 *   with graduated context shaping and auto-compaction between iterations.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.mjs';
import { getStore } from '../lib/store.mjs';
import { log } from '../lib/log.mjs';
import { randomId } from '../lib/crypto.mjs';
import { streamChat, estimateTokens, ProviderError, PROVIDER_META } from '../providers/index.mjs';
import { buildSystemPrompt, readProjectMemory } from './prompt.mjs';
import { buildTools, toOpenAITools, toolsForMode, backgroundShells } from './tools.mjs';
import { loadMcpTools, shutdownMcp } from './mcp.mjs';
import { fireHooks } from './hooks.mjs';
import { planModelRequest, shouldFallback, bumpUsage, anyByok } from '../policy.mjs';
import { detect } from '../runtime/runtimes.mjs';
import { userEnv } from '../runtime/exec.mjs';
import { checkpoint } from '../runtime/git.mjs';

const MAX_EVENTS = 4000;
const EMPTY = '(no content)';

export class Run extends EventEmitter {
  constructor({ id, projectId, threadId, userId, guest }) {
    super();
    this.id = id;
    this.projectId = projectId;
    this.threadId = threadId;
    this.userId = userId;
    this.guest = guest;
    this.events = [];
    this.seq = 0;
    this.status = 'running';
    this.createdAt = Date.now();
    this.subscribers = new Set();
    this.permissions = new Map();
    this.abort = new AbortController();
    this.harness = null;
    this.lastModel = '';
    this.lastProvider = '';
  }

  emitEvent(event) {
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    const payload = { i: ++this.seq, t: Date.now(), ...event };
    this.events.push(payload);
    for (const sse of this.subscribers) sse.send('event', payload);
    this.emit('event', payload);
    return payload;
  }

  attach(sse, from = 0) {
    for (const ev of this.events) if (ev.i > from) sse.send('event', ev);
    sse.send('state', { status: this.status, runId: this.id, seq: this.seq });
    this.subscribers.add(sse);
    sse.onClose(() => this.subscribers.delete(sse));
    if (this.status !== 'running' && this.status !== 'waiting') setTimeout(() => sse.close(), 20);
  }

  closeSubscribers() {
    for (const sse of this.subscribers) {
      sse.send('state', { status: this.status, runId: this.id, seq: this.seq });
      sse.close();
    }
    this.subscribers.clear();
  }

  requestPermission(request) {
    const id = randomId('perm_', 8);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.permissions.delete(id);
        this.emitEvent({ type: 'permission_timeout', requestId: id });
        resolve({ approved: false, reason: 'timeout' });
      }, 10 * 60_000);
      this.permissions.set(id, (decision) => {
        clearTimeout(timer);
        this.permissions.delete(id);
        resolve({ approved: Boolean(decision?.approved), reason: decision?.reason || '' });
      });
      this.emitEvent({ type: 'permission', requestId: id, ...request });
    });
  }

  resolvePermission(requestId, decision) {
    const fn = this.permissions.get(requestId);
    if (!fn) return false;
    fn(decision);
    return true;
  }

  stop() {
    this.abort.abort(new Error('stopped by user'));
    for (const [, resolve] of this.permissions) resolve({ approved: false, reason: 'run stopped' });
    this.permissions.clear();
  }
}

class BackgroundShell {
  constructor(command, cwd) {
    this.command = command;
    this.buffer = '';
    this.alive = true;
    this.exitCode = null;
    this.proc = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env: userEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const push = (d) => {
      this.buffer += d.toString('utf8');
      if (this.buffer.length > 512 * 1024) this.buffer = this.buffer.slice(-256 * 1024);
    };
    this.proc.stdout.on('data', push);
    this.proc.stderr.on('data', push);
    this.proc.on('exit', (code) => {
      this.alive = false;
      this.exitCode = code;
      this.buffer += `\n[exited ${code}]\n`;
    });
    this.proc.on('error', (err) => {
      this.alive = false;
      this.buffer += `\n[error ${err.message}]\n`;
    });
  }
  drain() {
    const out = this.buffer;
    this.buffer = '';
    return out;
  }
  kill() {
    try {
      process.kill(-this.proc.pid, 'SIGKILL');
    } catch {
      try {
        this.proc.kill('SIGKILL');
      } catch {}
    }
    this.alive = false;
  }
}

export class AgentHarness {
  constructor({
    run,
    project,
    thread,
    user,
    settings,
    requestedModel,
    mode = 'default',
    projectDir,
    deploy,
    externalConnections = [],
  }) {
    this.run = run;
    this.project = project;
    this.thread = thread;
    this.user = user;
    this.settings = settings;
    this.mode = mode;
    this.projectDir = projectDir;
    this.deployFn = deploy;
    this.externalConnections = externalConnections;
    this.messages = [];
    this.steps = 0;
    this.filesChanged = new Set();
    this.todos = [];
    this.plan = '';
    this.lastCheckpoint = 0;
    this.requestedModel = requestedModel;
    this.usage = { input: 0, output: 0, calls: 0 };
    this.model = '';
    this.provider = '';
    this.signal = run.abort.signal;
    this.tools = buildTools(this.buildToolContext());
    this.activeTools = [];
    this.lastProviderError = null;
  }

  emit(event) {
    if (event.type !== 'text' && event.type !== 'reasoning' && event.type !== 'tool_output') {
      log.debug(`[run ${this.run.id}] ${event.type}${event.text ? ': ' + String(event.text).slice(0, 120) : ''}`);
    }
    // The run is the single source of truth for client events.
    this.run.emitEvent(event);
  }

  buildToolContext() {
    const ctx = {
      projectId: this.project.id,
      projectDir: this.projectDir,
      signal: this.signal,
      externalConnections: this.externalConnections,
      emit: (event) => this.emit(event),
      beforeMutation: async (label) => {
        if (Date.now() - this.lastCheckpoint < 45_000) return;
        this.lastCheckpoint = Date.now();
        try {
          await checkpoint(this.project.id, this.projectDir, label);
        } catch (err) {
          log.debug('checkpoint skipped: ' + err.message);
        }
      },
      checkpoint: (label) => checkpoint(this.project.id, this.projectDir, label),
      requestPermission: async (request) => {
        if (this.mode === 'bypass' || this.mode === 'acceptEdits') return { approved: true };
        this.emit({ type: 'permission_pending', request });
        return this.run.requestPermission(request);
      },
      setTodos: (todos) => {
        this.todos = todos;
      },
      setPlan: (plan) => {
        this.plan = plan;
      },
      runSubagent: (args) => this.runSubagent(args),
      deploy: (args) => this.deployFn({ ...args, projectDir: this.projectDir, projectId: this.project.id, userId: this.user?.id }),
      spawnBackground: (command) => new BackgroundShell(command, this.projectDir),
    };
    return ctx;
  }

  // ------------------------------------------------------------ prompt ------
  async systemPrompt({ subagentType = '', extra = '' } = {}) {
    const runtime = await this.detectedRuntime;
    const memory = await readProjectMemory(this.projectDir);
    return buildSystemPrompt({
      projectDir: this.projectDir,
      projectName: this.project.name,
      model: this.model,
      provider: this.provider,
      mode: this.mode,
      todos: this.todos,
      memory,
      runtime,
      extra,
      isSubagent: Boolean(subagentType),
      subagentType,
    });
  }

  get detectedRuntime() {
    this._runtime ||= detect().catch(() => null);
    return this._runtime;
  }

  // ------------------------------------------------------------- history ----
  loadHistory() {
    const store = getStore();
    const stored = store.listMessages(this.thread.id, 800);
    this.messages = [];
    for (const m of stored) {
      const content = m.content || {};
      if (m.role === 'user') this.messages.push({ role: 'user', content: content.text || '' });
      else if (m.role === 'assistant') {
        const msg = { role: 'assistant', content: content.text || '' };
        if (content.toolCalls?.length) msg.tool_calls = content.toolCalls;
        if (!msg.content && !msg.tool_calls) msg.content = EMPTY;
        this.messages.push(msg);
      } else if (m.role === 'tool') {
        this.messages.push({ role: 'tool', tool_call_id: content.toolCallId, name: content.name, content: String(content.content ?? '') });
      }
    }
    // Repair dangling tool calls (e.g. server restarted mid-run) so providers accept the history.
    this.messages = repairToolPairs(this.messages);
  }

  persist(role, content, meta = {}) {
    try {
      getStore().addMessage({ threadId: this.thread.id, role, content, meta });
    } catch (err) {
      log.warn('failed to persist message: ' + err.message);
    }
  }

  /** Connect configured MCP servers and expose their tools to this agent. */
  async attachMcpTools() {
    if (this.mcpLoaded) return;
    this.mcpLoaded = true;
    try {
      const extra = await loadMcpTools();
      if (!extra.length) return;
      const known = new Set(this.tools.map((t) => t.name));
      let added = 0;
      for (const tool of extra) {
        if (known.has(tool.name)) continue;
        this.tools.push(tool);
        added++;
      }
      if (added) this.emit({ type: 'notice', level: 'info', text: `MCP: ${added} external tool(s) available.` });
    } catch (err) {
      log.warn('MCP tools unavailable: ' + err.message);
    }
  }

  // -------------------------------------------------------------- loop ------
  async send(userText, { attachments = [] } = {}) {
    const store = getStore();
    this.loadHistory();
    await this.attachMcpTools();
    await fireHooks('SessionStart', { projectId: this.project.id, threadId: this.thread.id }, { emit: (e) => this.emit(e) });

    const text = String(userText || '').slice(0, 60_000);
    this.messages.push({ role: 'user', content: text });
    this.persist('user', { text }, { attachments: attachments.map((a) => ({ name: a.name, size: a.size })) });
    store.touchProject(this.project.id);

    // Title the session from the first message.
    try {
      if (!this.thread.title || this.thread.title === 'New session') {
        const title = text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New session';
        store.updateThread(this.thread.id, { title });
      }
    } catch {}

    let finishReason = 'stop';
    const nudge = { count: 0 };

    for (let iteration = 0; iteration < config.agent.maxIterations; iteration++) {
      if (this.signal.aborted) {
        finishReason = 'stopped';
        break;
      }
      this.steps = iteration + 1;

      const shaped = await this.shapeContext();
      const system = await this.systemPrompt();
      const tools = toolsForMode(this.tools, this.mode);
      const result = await this.callModel({ system, messages: shaped, tools });
      if (!result) {
        finishReason = 'error';
        break;
      }

      let { content, reasoning, toolCalls } = result;

      // Weak free models sometimes emit tool calls as text — recover them.
      if (!toolCalls.length && content) {
        const extracted = extractTextToolCalls(content, tools.map((t) => t.name));
        if (extracted.calls.length) {
          toolCalls = extracted.calls;
          content = extracted.cleaned;
          this.emit({ type: 'notice', level: 'info', text: 'Recovered tool calls from model text output.' });
        }
      }

      if (reasoning) this.emit({ type: 'reasoning_done', length: reasoning.length });
      if (content?.trim()) this.emit({ type: 'text_done', text: content });

      const assistantMsg = { role: 'assistant', content: content || '' };
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      if (!assistantMsg.content && !assistantMsg.tool_calls) assistantMsg.content = EMPTY;
      this.messages.push(assistantMsg);
      this.persist('assistant', { text: content || '', reasoning: reasoning || '', toolCalls: toolCalls.length ? toolCalls : undefined }, { model: this.model, provider: this.provider });

      if (!toolCalls.length) {
        finishReason = result.finishReason || 'stop';
        break;
      }

      const toolResults = await this.executeToolCalls(toolCalls, tools);
      for (const tr of toolResults) {
        this.messages.push({ role: 'tool', tool_call_id: tr.id, name: tr.name, content: tr.content });
        this.persist('tool', { toolCallId: tr.id, name: tr.name, content: tr.content, isError: tr.isError, display: tr.display }, {});
      }

      // If every call failed because of an unknown tool with no progress, nudge once.
      if (toolResults.every((r) => r.isError && /unknown tool/i.test(r.content)) && nudge.count < 1) {
        nudge.count++;
        const available = tools.map((t) => t.name).join(', ');
        this.messages.push({ role: 'user', content: `System note: those tool names do not exist. Available tools: ${available}. Call one of them with valid JSON arguments.` });
        continue;
      }
    }

    return { finishReason, steps: this.steps };
  }

  // ---------------------------------------------------------- model call ----
  async callModel({ system, messages, tools }) {
    const candidates = planModelRequest(
      { user: this.user, session: null },
      { settings: this.settings, requested: this.requestedModel },
    ).filter((c) => c.provider);
    if (!candidates.length) {
      this.emit({ type: 'error', message: 'No model provider available. Sign in, add a BYOK key, or use the free Kilo router.', code: 'no_provider' });
      return null;
    }

    const openaiTools = toOpenAITools(tools);
    let lastError = null;
    for (const [index, candidate] of candidates.entries()) {
      if (this.signal.aborted) return null;
      if (candidate.needsModel) continue;
      const model = candidate.model;
      const isByok = candidate.via === 'byok';
      try {
        const started = Date.now();
        this.model = model;
        this.provider = candidate.provider;
        this.emit({
          type: 'model',
          provider: candidate.provider,
          model,
          via: candidate.via,
          attempt: index + 1,
          of: candidates.length,
          label: PROVIDER_META[candidate.provider]?.label || candidate.provider,
        });

        let textStarted = false;
        const acc = await streamChat({
          provider: candidate.provider,
          model,
          messages,
          system,
          tools: openaiTools,
          apiKey: candidate.apiKey,
          baseUrl: candidate.baseUrl,
          signal: this.signal,
          maxTokens: 8192,
          onEvent: (ev) => {
            if (ev.type === 'text') {
              textStarted = true;
              this.emit({ type: 'text', text: ev.text });
            } else if (ev.type === 'reasoning') {
              this.emit({ type: 'reasoning', text: ev.text });
            }
          },
        });

        const usage = acc.usage || {};
        const input = usage.prompt_tokens || estimateTokens(system) + estimateTokens(JSON.stringify(messages));
        const output = usage.completion_tokens || estimateTokens(acc.content);
        this.usage.input += input;
        this.usage.output += output;
        this.usage.calls += 1;
        if (!acc.content?.trim() && !acc.toolCalls.length) {
          throw new ProviderError('Provider returned an empty response', { provider: candidate.provider, code: 'empty', retryable: true });
        }
        if (!isByok) {
          bumpUsage({ user: this.user, session: null }, { turns: 0, calls: 1, tokens: input + output });
        }
        this.emit({
          type: 'usage',
          usage: { ...this.usage, inputTokens: input, outputTokens: output, durationMs: Date.now() - started, contextWindow: config.agent.contextWindow },
          model,
          provider: candidate.provider,
          via: candidate.via,
        });
        this.run.lastModel = model;
        this.run.lastProvider = candidate.provider;
        return { content: acc.content, reasoning: acc.reasoning, toolCalls: acc.toolCalls || [], finishReason: acc.finishReason };
      } catch (err) {
        lastError = err;
        const code = err.code || (err.name === 'ProviderError' ? 'http_error' : 'unknown');
        this.emit({ type: 'provider_error', provider: candidate.provider, model, message: String(err.message).slice(0, 400), code });
        if (this.signal.aborted) return null;
        if (!shouldFallback({ ...err, code })) {
          this.emit({ type: 'error', message: `${PROVIDER_META[candidate.provider]?.label || candidate.provider}: ${err.message}`, code });
          return null;
        }
        this.emit({
          type: 'notice',
          level: 'warn',
          text: `${PROVIDER_META[candidate.provider]?.label || candidate.provider} unavailable (${code}) — trying the next model.`,
        });
      }
    }
    this.emit({
      type: 'error',
      message: `All model providers failed. Last error: ${lastError?.message || 'unknown'}. Add a BYOK key in Settings for a dedicated route.`,
      code: 'all_providers_failed',
    });
    return null;
  }

  // --------------------------------------------------------- tool running ---
  async executeToolCalls(toolCalls, tools) {
    const results = new Array(toolCalls.length);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const parallel = [];
    const sequential = [];

    for (const [i, call] of toolCalls.entries()) {
      const tool = byName.get(call.name);
      if (!tool) {
        results[i] = {
          id: call.id,
          name: call.name,
          content: `Error: unknown tool "${call.name}". Available tools: ${tools.map((t) => t.name).join(', ')}.`,
          isError: true,
        };
        continue;
      }
      let args;
      try {
        args = parseArgs(call.arguments);
      } catch (err) {
        results[i] = { id: call.id, name: call.name, content: `Error: invalid JSON arguments for ${call.name}: ${err.message}`, isError: true };
        continue;
      }
      const task = { index: i, tool, call, args };
      if (tool.readOnly && tool.name !== 'bash_output') parallel.push(task);
      else sequential.push(task);
    }

    const exec = async (task) => {
      const { index, tool, call, args } = task;
      const started = Date.now();
      this.emit({
        type: 'tool_start',
        toolCallId: call.id,
        name: tool.name,
        args: sanitizeArgs(args),
        title: toolTitle(tool.name, args),
        readOnly: tool.readOnly,
      });

      // PreToolUse hooks can veto a call; the model sees why.
      const pre = await fireHooks('PreToolUse', { file: args.file_path || args.path || '', projectId: this.project.id, args }, { toolName: tool.name, emit: (e) => this.emit(e) });
      if (pre.blocked) {
        const blocked = `Error: blocked by a PreToolUse hook — ${pre.reason}`;
        this.emit({ type: 'tool_end', toolCallId: call.id, name: tool.name, ok: false, summary: 'blocked by hook', durationMs: Date.now() - started });
        results[index] = { id: call.id, name: tool.name, content: blocked, isError: true };
        return;
      }

      try {
        const out = await tool.run(args, {});
        const text = typeof out === 'string' ? out : out.text;
        const truncated = text.length > config.agent.toolOutputLimit ? true : out.truncated;
        const finalText = text.length > config.agent.toolOutputLimit ? hardTruncate(text) : text;
        this.emit({
          type: 'tool_end',
          toolCallId: call.id,
          name: tool.name,
          ok: !out.isError,
          summary: summarize(tool.name, out, args),
          display: out.display || null,
          durationMs: Date.now() - started,
          truncated,
        });
        if (['write', 'edit', 'multiedit', 'notebook_edit'].includes(tool.name) && args.file_path) this.filesChanged.add(args.file_path);
        await fireHooks('PostToolUse', { file: args.file_path || args.path || '', projectId: this.project.id, ok: !out.isError, output: text.slice(0, 2000) }, { toolName: tool.name, emit: (e) => this.emit(e) });
        results[index] = { id: call.id, name: tool.name, content: finalText, isError: Boolean(out.isError), display: out.display };
      } catch (err) {
        const message = err?.message || String(err);
        this.emit({ type: 'tool_end', toolCallId: call.id, name: tool.name, ok: false, summary: message.slice(0, 200), durationMs: Date.now() - started });
        results[index] = { id: call.id, name: tool.name, content: `Error: ${message}`, isError: true };
      }
    };

    if (parallel.length) await Promise.all(parallel.map(exec));
    for (const task of sequential) await exec(task);

    const failed = results.filter((r) => r?.isError).length;
    if (failed) this.emit({ type: 'notice', level: 'warn', text: `${failed} tool call(s) failed — the agent will adapt.` });
    return results.map((r) => r || { id: 'unknown', name: 'unknown', content: 'Error: tool did not run', isError: true });
  }

  // ------------------------------------------------------------ subagents ---
  async runSubagent({ description, prompt, subagentType }) {
    const maxIter = config.agent.maxSubagentIterations;
    const messages = [{ role: 'user', content: prompt }];
    const tools = toolsForMode(buildTools(this.buildToolContext()), 'default', subagentType);
    const steps = [];
    this.emit({ type: 'subagent_start', description, subagent: subagentType });

    for (let i = 0; i < maxIter; i++) {
      if (this.signal.aborted) break;
      const system = await this.systemPrompt({ subagentType });
      const acc = await streamChat({
        provider: this.provider,
        model: this.model,
        messages,
        system,
        tools: toOpenAITools(tools),
        signal: this.signal,
        maxTokens: 8192,
        onEvent: () => {},
      }).catch((err) => {
        this.emit({ type: 'subagent_error', message: err.message });
        return null;
      });
      if (!acc) break;
      messages.push({ role: 'assistant', content: acc.content || '', tool_calls: acc.toolCalls?.length ? acc.toolCalls : undefined });
      if (!acc.toolCalls?.length) {
        this.emit({ type: 'subagent_end', description, steps: steps.length });
        return { summary: acc.content || '(subagent returned no text)', steps: steps.length };
      }
      for (const call of acc.toolCalls) {
        const tool = tools.find((t) => t.name === call.name);
        let content;
        if (!tool) content = `Error: unknown tool ${call.name}`;
        else {
          try {
            const args = parseArgs(call.arguments);
            steps.push({ name: tool.name, args: sanitizeArgs(args) });
            const out = await tool.run(args, {});
            content = String(typeof out === 'string' ? out : out.text).slice(0, 8000);
          } catch (err) {
            content = `Error: ${err.message}`;
          }
        }
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content });
      }
    }
    this.emit({ type: 'subagent_end', description, steps: steps.length });
    return { summary: `Subagent "${description}" hit its step limit. Partial findings:\n${messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n').slice(0, 3000) || '(none)'}`, steps: steps.length };
  }

  // ------------------------------------------------------ context shaping ---
  async shapeContext() {
    const window = config.agent.contextWindow;
    let messages = this.messages.map((m) => ({ ...m }));

    // Tool result trim doesn't need a signal; do it always to keep requests lean.
    const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
    for (const idx of toolIdx.slice(0, Math.max(0, toolIdx.length - 4))) {
      const m = messages[idx];
      if (typeof m.content === 'string' && m.content.length > 3000) {
        messages[idx] = { ...m, content: m.content.slice(0, 1400) + `\n… [trimmed, ${m.content.length - 1400} chars]` };
      }
    }

    const estimate = messages.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) + 8, 0);
    const budget = window * config.agent.compactAt;
    if (estimate < budget) return messages;

    this.emit({ type: 'notice', level: 'info', text: `Context is at ~${Math.round((estimate / window) * 100)}% — compacting history.` });
    return this.compact(messages);
  }

  async compact(messages) {
    const keepTail = 8;
    const head = messages.slice(0, Math.max(0, messages.length - keepTail));
    const tail = messages.slice(-keepTail);
    let summary = '';
    try {
      const res = await streamChat({
        provider: this.provider || 'kilo',
        model: this.model || config.guestModel,
        messages: [
          ...head.map((m) => ({ role: m.role === 'tool' ? 'user' : m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
          { role: 'user', content: COMPACT_PROMPT },
        ],
        system: 'You compress agent transcripts. Be precise, keep file paths, commands, errors and decisions. Never invent details.',
        maxTokens: 2048,
        signal: this.signal,
        onEvent: () => {},
      });
      summary = res.content?.trim() || '';
    } catch (err) {
      log.debug('compaction failed: ' + err.message);
    }
    if (!summary) {
      summary = `(Automatic summary unavailable. Earlier conversation was dropped. Steps completed: ${this.filesChanged.size} files touched: ${[...this.filesChanged].join(', ') || 'none'}.)`;
    }
    this.emit({ type: 'compaction', summaryLength: summary.length, dropped: head.length });
    const compacted = [
      { role: 'user', content: `[Conversation summary — earlier turns were compacted]\n${summary}` },
      { role: 'assistant', content: 'Understood. I have the earlier context. Continuing from here.' },
      ...tail,
    ];
    this.messages = compacted;
    return compacted;
  }
}

const COMPACT_PROMPT = `Summarise this engineering session so another agent can continue the work without the full transcript. Include, using short bullets:
1. The user's goal and any constraints.
2. What was built or changed (file paths).
3. Commands run and their key output (especially failures).
4. Current state: what works, what is broken, what is left.
5. Important decisions, versions and gotchas.
Be specific and terse. No pleasantries.`;

// ---------------------------------------------------------------- helpers ---
function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  const text = String(raw).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    // Some models emit trailing commas or single quotes.
    try {
      return JSON.parse(text.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"'));
    } catch {
      throw new Error('arguments are not valid JSON');
    }
  }
}

function hardTruncate(text) {
  const limit = config.agent.toolOutputLimit;
  return text.slice(0, limit * 0.7) + `\n\n… [${text.length - limit} characters truncated by the harness] …\n\n` + text.slice(-Math.floor(limit * 0.2));
}

function sanitizeArgs(args) {
  const clone = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (/content|new_string|old_string|source/i.test(k) && typeof v === 'string' && v.length > 400) clone[k] = v.slice(0, 400) + '…';
    else clone[k] = v;
  }
  return clone;
}

function toolTitle(name, args) {
  switch (name) {
    case 'bash':
      return args.description || String(args.command || '').slice(0, 100);
    case 'read':
    case 'write':
    case 'edit':
    case 'multiedit':
      return args.file_path || '';
    case 'grep':
      return `${args.pattern || ''}${args.glob ? ` (${args.glob})` : ''}`;
    case 'glob':
      return args.pattern || '';
    case 'task':
      return args.description || 'subagent';
    case 'deploy':
      return `deploy → ${args.target}`;
    case 'db_query':
    case 'db_exec':
      return String(args.sql || '').slice(0, 100);
    default:
      return '';
  }
}

function summarize(name, out, args) {
  const display = out.display || {};
  if (display.kind === 'diff') {
    const added = (display.diff.match(/^\+/gm) || []).length;
    const removed = (display.diff.match(/^-/gm) || []).length;
    return `+${added} −${removed} · ${display.path}`;
  }
  if (name === 'bash') return `exit ${display.exitCode ?? 0} · ${Math.round((display.durationMs || 0) / 100) / 10}s`;
  if (name === 'read') return `${display.lines || 0} lines · ${display.path || ''}`;
  const text = String(out.text || '');
  return text.split('\n')[0].slice(0, 140);
}

/** Pair up assistant tool_calls with tool results; drop orphans. */
export function repairToolPairs(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const ids = new Set(m.tool_calls.map((t) => t.id));
      const following = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        following.push(messages[j]);
        j++;
      }
      const answered = new Set(following.map((t) => t.tool_call_id));
      const complete = [...ids].every((id) => answered.has(id));
      if (complete) {
        out.push(m, ...following);
      } else {
        out.push({ role: 'assistant', content: m.content || EMPTY });
        for (const t of following) if (ids.has(t.tool_call_id)) out.push(t);
      }
      i = j - 1;
      continue;
    }
    if (m.role === 'tool') continue; // orphan tool message
    out.push(m);
  }
  return out;
}

/** Recover tool calls that a weaker model printed as text. */
export function extractTextToolCalls(text, toolNames) {
  const names = new Set(toolNames);
  const calls = [];
  let cleaned = text;
  const patterns = [
    /```(?:json)?\s*(\{[\s\S]{0,6000}?\})\s*```/g,
    /<tool_call>\s*(\{[\s\S]{0,6000}?\})\s*<\/tool_call>/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) && calls.length < 6) {
      try {
        const obj = JSON.parse(m[1]);
        const name = obj.name || obj.tool || obj.function?.name;
        const args = obj.arguments || obj.args || obj.parameters || obj.function?.arguments || {};
        if (name && names.has(name)) {
          calls.push({ id: `call_text_${calls.length}_${Date.now().toString(36)}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
          cleaned = cleaned.replace(m[0], '');
        }
      } catch {}
    }
  }
  return { calls, cleaned: cleaned.trim() };
}

// ------------------------------------------------------------- run manager --
export const runs = new Map();
const activeThreads = new Set();

export function getRun(id) {
  return runs.get(id) || null;
}

export function createRun({ project, thread, user, guest }) {
  if (activeThreads.has(thread.id)) {
    const err = new Error('A run is already in progress for this session');
    err.status = 409;
    err.code = 'run_in_progress';
    throw err;
  }
  const run = new Run({ id: randomId('run_', 10), projectId: project.id, threadId: thread.id, userId: user?.id || null, guest: !user });
  runs.set(run.id, run);
  activeThreads.add(thread.id);
  const cleanup = () => {
    activeThreads.delete(thread.id);
    setTimeout(() => runs.delete(run.id), 15 * 60_000).unref?.();
  };
  return { run, cleanup };
}

export function runningForThread(threadId) {
  for (const run of runs.values()) if (run.threadId === threadId && run.status === 'running') return run;
  return null;
}

export async function shutdownRuns() {
  for (const run of runs.values()) {
    try {
      run.stop();
      run.status = 'stopped';
      run.closeSubscribers();
    } catch {}
  }
  for (const bg of backgroundShells.values()) {
    try {
      bg.kill();
    } catch {}
  }
  try {
    shutdownMcp();
  } catch {}
  await fsp.rm(path.join(config.dataDir, 'tmp'), { recursive: true, force: true }).catch(() => {});
}

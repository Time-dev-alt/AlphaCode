/**
 * AlphaCode — client-side app.
 *
 * Everything below runs in the tab: storage (IndexedDB), files (OPFS), the
 * shell, SQLite (WASM), the agent harness and deploys. The only network calls
 * are the user's own model provider and (optionally) the OAuth endpoint that
 * mints a GitHub token in a Pages Function.
 */
import { createStore, uid } from '../engine/store.js';
import { createFsAsync, isBinaryPath, normPath } from '../engine/fs.js';
import { Shell } from '../engine/shell.js';
import { openDatabase, saveDatabase, dbFiles, loadEngine } from '../engine/db.js';
import { createPreview, connectGitHub, deployProject, whoAmI, publishToGitHub, importUrl, DEPLOY_TARGETS } from '../engine/deploy.js';
import { Harness, Run } from '../engine/harness.js';
import { FREE_MODELS, PROVIDERS, GUEST_MODEL } from '../engine/providers.js';
import { runPython, pipInstall, loadPython, pythonReady } from '../engine/python.js';
import { createNodeSession } from '../engine/node/session.js';
import { JobManager } from '../engine/jobs.js';
import { loadHooks } from '../engine/hooks.js';
import { runWasi, compileC, canCompileC, RUNTIME_MATRIX } from '../engine/native.js';
import { connectAll, contentToText } from '../engine/mcp.js';
import { mountWorkspace, refreshPreview, renderJobs, renderHistory } from './workspace.js';
import { zipSync, download } from '../engine/zip.js';
import { TerminalView } from '../../public/assets/term.js';
import { $, $$, el, icon, paintIcons, toast, md, renderDiff, timeAgo, bytes, escapeHtml, copyText, debounce } from './ui.js';

const state = {
  store: null,
  fs: null,
  shell: null,
  settings: {},
  projects: [],
  project: null,
  thread: null,
  threads: [],
  messages: [],
  files: [],
  view: 'chat',
  run: null,
  harness: null,
  running: false,
  mode: 'default',
  model: GUEST_MODEL,
  contextWindow: 200_000,
  lastUsage: null,
  dbs: new Map(),
  dbPath: '',
  termView: null,
  editorPath: '',
  editorDirty: false,
  github: null,
  deployments: [],
  pendingClaim: '',
  bootedAt: Date.now(),
  node: null,
  jobs: null,
  mcp: { clients: [], tools: [], errors: [] },
  hooks: null,
};


/* --------------------------------------------------------------- MCP / runtime -- */

/** Connect configured MCP servers and expose their tools to the harness. */
async function loadMcp() {
  const configs = state.settings.mcp || [];
  if (!configs.length) {
    state.mcp = { clients: [], tools: [], errors: [] };
    return state.mcp;
  }
  setStatus('connecting MCP servers…');
  const { clients, errors } = await connectAll(configs, { onLog: (line) => toast(line, errors.length ? 'warn' : 'info') });
  const tools = clients.flatMap(({ client, tools: list }) =>
    list.map((tool) => ({
      name: tool.name,
      description: tool.description,
      readOnly: false,
      schema: tool.inputSchema,
      async run(args) {
        const result = await client.callTool(tool.rawName, args);
        return { text: contentToText(result.content), display: { kind: 'mcp', server: tool.server } };
      },
    })),
  );
  state.mcp = { clients: clients.map((c) => c.client), tools, errors };
  setStatus('ready');
  return state.mcp;
}

/** Create a project from a template and, if it has one, run its starter prompt. */
async function startFromTemplate(template) {
  // Reuse the current project when it is still untouched (the common case right
  // after opening the app), so a template never leaves an empty project behind.
  const current = state.project;
  const existing = current ? await state.fs.list(current.id).catch(() => []) : [];
  const project = current && existing.length === 0 ? current : await createProject(template.name, { silent: true });
  if (project === current) {
    state.project = await state.store.updateProject(current.id, { name: template.name }).catch(() => current);
    $('#project-name').textContent = template.name;
    await refreshProjects();
  }
  for (const [path, content] of Object.entries(template.files || {})) await state.fs.write(project.id, path, content);
  await refreshFiles();
  refreshPreview({ force: true });
  toast(`Started “${template.name}”`, 'ok');
  if (template.prompt) {
    const prompt = $('#prompt');
    prompt.value = template.prompt;
    prompt.focus();
    $('#btn-send').click();
  } else {
    $('#prompt').focus();
  }
}

/* ------------------------------------------------------------------ boot -- */

async function boot() {
  paintIcons();
  state.store = await createStore();
  // Probe for real storage instead of trusting feature detection: OPFS throws
  // inside partitioned frames, and losing the user's files silently is worse
  // than a slower IndexedDB backend.
  state.fs = await createFsAsync();
  state.storage = state.fs.mode;
  state.settings = await state.store.settings();
  state.mode = state.settings.mode || 'default';
  state.model = state.settings.model || GUEST_MODEL;
  state.github = state.settings.github || null;

  wireGlobal();
  await refreshProjects();
  const last = state.settings.lastProject;
  const projects = state.projects;
  if (location.hash.startsWith('#/claim/')) {
    await handleClaimRoute();
  } else if (location.hash.startsWith('#/p/')) {
    await handlePreviewRoute();
  }
  if (projects.length) await openProject(projects.find((p) => p.id === last)?.id || projects[0].id);
  else await createProject('My first app', { silent: true });
  state.jobs = new JobManager({
    spawnWorker: () => new Worker(__WORKER_URL__, { type: 'module' }),
    writeFile: (path, content) => state.fs.write(state.project.id, path, content),
    snapshot: () => state.fs.snapshot(state.project.id),
    onEvent: (event) => {
      if (event.type === 'job_start' || event.type === 'job_end') {
        renderJobs(state.jobs.list().map((job) => state.jobs.describe(job)));
        toast(event.type === 'job_start' ? `Started %${event.job.id} in the background` : `%${event.job.id} ${event.job.status}`, event.type === 'job_start' ? 'info' : 'ok');
      }
    },
  });
  if (state.shell) {
    state.shell.jobs = state.jobs;
    state.shell.node = state.node;
  }
  mountWorkspace({
    getState: () => state,
    saveSettings: async (patch) => {
      state.settings = await state.store.saveSettings(patch);
      return state.settings;
    },
    toast,
    setView,
    refreshFiles,
    onSend: () => $('#btn-send').click(),
    onPublish: () => {
      setView('deploy');
      $('#modal').hidden = true;
    },
    onTemplate: async (template) => {
      await startFromTemplate(template);
    },
  });
  setStatus('ready');
  renderChrome();
  if (!state.settings.seenWelcome) {
    state.settings = await state.store.saveSettings({ seenWelcome: true });
    renderWelcome();
  }
}

async function refreshProjects() {
  state.projects = await state.store.projects();
  renderProjects();
}

function renderProjects() {
  const host = $('#project-list');
  host.innerHTML = '';
  if (!state.projects.length) {
    host.innerHTML = '<div class="hint pad">No projects yet.</div>';
    return;
  }
  for (const p of state.projects) {
    const row = el('div', { class: `list-item ${p.id === state.project?.id ? 'active' : ''}` });
    row.innerHTML = `${icon('folder', 14)}<div class="name">${escapeHtml(p.name)}</div><div class="meta">${timeAgo(p.updatedAt)}</div>
      <button class="icon-btn sm" title="Delete">${icon('trash', 13)}</button>`;
    row.onclick = (e) => {
      if (e.target.closest('.icon-btn')) return;
      openProject(p.id);
      closeDrawer();
    };
    row.querySelector('.icon-btn').onclick = async () => {
      if (!confirm(`Delete "${p.name}" and its files? This cannot be undone.`)) return;
      await state.store.deleteProject(p.id);
      await state.fs.remove(p.id, '');
      await refreshProjects();
      if (state.project?.id === p.id) {
        state.project = null;
        const next = state.projects[0];
        if (next) await openProject(next.id);
        else await createProject('My first app', { silent: true });
      }
    };
    host.append(row);
  }
}

async function renderSessions() {
  const host = $('#session-list');
  host.innerHTML = '';
  if (!state.project) return;
  state.threads = await state.store.threads(state.project.id);
  for (const t of state.threads) {
    const row = el('div', { class: `list-item ${t.id === state.thread?.id ? 'active' : ''}` });
    row.innerHTML = `${icon('chat', 14)}<div class="name">${escapeHtml(t.title)}</div><div class="meta">${timeAgo(t.updatedAt)}</div>`;
    row.onclick = () => openThread(t.id);
    host.append(row);
  }
}

async function createProject(name, { silent, files = null } = {}) {
  const { project, thread } = await state.store.createProject({ name });
  state.settings = await state.store.saveSettings({ lastProject: project.id });
  await refreshProjects();
  state.project = project;
  state.thread = thread;
  state.messages = [];
  if (files) {
    for (const [path, content] of Object.entries(files)) await state.fs.write(project.id, path, content);
  }
  state.node = createNodeSession({
    fs: state.fs,
    projectId: project.id,
    onStdout: (text) => state.termView?.write?.(text),
    onStderr: (text) => state.termView?.write?.(text),
    env: { NODE_ENV: 'development' },
  });
  attachShell();
  await renderSessions();
  renderTranscript();
  if (!silent) toast(`Created “${project.name}”`, 'ok');
  return project;
}

/** Bind the shell (and its python/sqlite bridges) to the current project. */
function attachShell() {
  if (!state.project) return;
  state.shell = new Shell({
    fs: state.fs,
    projectId: state.project.id,
    node: state.node,
    jobs: state.jobs,
    runPython: async (code, { file } = {}) => {
      const files = await state.fs.snapshot(state.project.id).catch(() => ({}));
      let captured = '';
      const result = await runPython({
        code,
        file,
        files,
        onOutput: (text) => {
          captured += text;
        },
        onFiles: async (changed) => {
          for (const [path, content] of Object.entries(changed)) {
            await state.fs.write(state.project.id, path, content).catch(() => {});
          }
          refreshFiles();
        },
      });
      return captured || result.output || '';
    },
    runPip: async (packages) => {
      let captured = '';
      const result = await pipInstall(packages, { onOutput: (t) => (captured += t) });
      return { code: result.code, installed: result.installed || [], output: captured };
    },
    runWasm: async (path, args) => {
      const bytes = await state.fs.read(state.project.id, path).catch(() => null);
      if (!bytes) return { code: 1, output: `wasm: ${path} not found\n` };
      const files = await state.fs.snapshot(state.project.id).catch(() => ({}));
      const encoder = new TextEncoder();
      const fileMap = {};
      for (const [name, text] of Object.entries(files)) fileMap[name] = encoder.encode(typeof text === 'string' ? text : '');
      let output = '';
      const result = await runWasi(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
        args: [path, ...args],
        files: fileMap,
        onStdout: (text) => (output += text),
        onStderr: (text) => (output += text),
        onWriteFile: (name, data) => {
          state.fs.write(state.project.id, name, new TextDecoder().decode(data)).catch(() => {});
        },
      });
      return { code: result.code ?? 0, output };
    },
    compileNative: async (path, language) => {
      if (!canCompileC(state.settings)) {
        return {
          code: 1,
          output:
            'cc: no C toolchain is configured.\n' +
            '  • C/C++ needs clang+lld+sysroot (~60 MB) — set a compile endpoint in Settings → Runtime, or\n' +
            '  • compile elsewhere (zig cc --target=wasm32-wasi) and run the .wasm here: wasm main.wasm\n',
        };
      }
      try {
        const source = await state.fs.readText(state.project.id, path);
        const wasm = await compileC({ source, language, filename: path, settings: state.settings });
        const out = path.replace(/\.(c|cpp|cc|cxx)$/, '.wasm');
        await state.fs.write(state.project.id, out, new Uint8Array(wasm));
        return { code: 0, output: `compiled ${path} → ${out} (${(wasm.byteLength / 1024).toFixed(0)} KB)\nrun it: wasm ${out}\n` };
      } catch (err) {
        return { code: 1, output: `cc: ${err.message}\n${err.hint ? `${err.hint}\n` : ''}` };
      }
    },
    runSql: async (dbPath, sql) => {
      const db = await getDb(dbPath);
      const out = db.exec(sql);
      await saveDatabase(state.fs, state.project.id, db);
      return JSON.stringify(out, null, 2);
    },
  });
  state.termView = null;
}

async function openProject(id) {
  state.project = await state.store.project(id);
  if (!state.project) return;
  state.settings = await state.store.saveSettings({ lastProject: id });
  state.threads = await state.store.threads(id);
  state.thread = state.threads[0] || (await state.store.createThread(id, 'New session'));
  await openThread(state.thread.id);
  await refreshFiles();
  await renderDbs();
  await renderDeployments();
  state.dbs.clear();
  state.dbPath = '';
  state.editorPath = '';
  $('#editor').value = '';
  $('#editor-path').textContent = 'No file selected';
  state.node = createNodeSession({
    fs: state.fs,
    projectId: id,
    onStdout: (text) => state.termView?.write?.(text),
    onStderr: (text) => state.termView?.write?.(text),
  });
  attachShell();
  $('#project-name').textContent = state.project.name;
  state.hooks = await loadHooks({ fs: state.fs, projectId: id, settings: state.settings }).catch(() => null);
  await loadMcp();
  if (state.view === 'terminal') mountTerminal(true);
  refreshPreview();
}

async function openThread(id) {
  state.thread = (await state.store.thread(id)) || state.thread;
  state.messages = await state.store.messages(id);
  renderTranscript();
  await renderSessions();
}

/* ------------------------------------------------------------- transcript -- */

function transInner() {
  let inner = $('#transcript-inner');
  if (!inner) {
    const host = $('#transcript');
    host.innerHTML = '';
    inner = el('div', { class: 'transcript-inner', id: 'transcript-inner' });
    host.append(inner);
    if (!state.messages.length) renderWelcome();
  }
  return inner;
}

function renderWelcome() {
  const inner = transInner();
  if (inner.querySelector('.welcome')) return;
  const box = el('div', { class: 'welcome' });
  box.innerHTML = `
    <h1>What should we build?</h1>
    <p class="lede">A coding agent that runs entirely in this tab — files in your browser, a real shell, SQLite, and deploys to <em>your</em> Cloudflare, Vercel or Netlify.</p>
    <div class="cards">
      <button data-prompt="Build a landing page for a product called Northwind, with a hero, features and a footer."><b>Landing page</b><span>Static site, instant preview</span></button>
      <button data-prompt="Create a todo app with localStorage persistence and a clean dark UI."><b>Todo app</b><span>Interactive, no backend</span></button>
      <button data-prompt="Create a SQLite database for a small shop (products, orders, order_items) with seed data, and query it."><b>SQLite schema</b><span>Real database, in the browser</span></button>
      <button data-prompt="Look at the project files and write an ALPHACODE.md describing the structure and how to run it."><b>Explain the project</b><span>Reads your workspace</span></button>
    </div>`;
  for (const b of box.querySelectorAll('[data-prompt]')) b.onclick = () => send(b.dataset.prompt);
  inner.append(box);
}

function clearTranscript() {
  $('#transcript').innerHTML = '';
  const inner = el('div', { class: 'transcript-inner', id: 'transcript-inner' });
  $('#transcript').append(inner);
  state.messages = [];
}

function renderTranscript() {
  const host = $('#transcript');
  host.innerHTML = '';
  const inner = el('div', { class: 'transcript-inner', id: 'transcript-inner' });
  host.append(inner);
  if (!state.messages.length) {
    renderWelcome();
    return;
  }
  for (const m of state.messages) {
    if (m.role === 'user') appendUser(m.content?.text || '');
    else if (m.role === 'assistant' && m.content?.text?.trim()) appendAssistant(m.content.text);
    else if (m.role === 'tool') {
      const card = appendTool({ name: m.content?.name || 'tool', title: '', args: {} });
      finishTool(card, { ok: !m.content?.isError, summary: firstLine(m.content?.content), display: m.content?.display, output: m.content?.content });
    }
  }
  scrollTranscript();
}

const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim())?.slice(0, 140) || '';

function scrollTranscript(force) {
  const host = $('#transcript');
  if (!host) return;
  const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 180;
  if (force || nearBottom) host.scrollTop = host.scrollHeight;
}

function appendUser(text) {
  const inner = transInner();
  inner.querySelector('.welcome')?.remove();
  inner.append(el('div', { class: 'msg user', html: `<div class="bubble">${escapeHtml(text).replace(/\n/g, '<br>')}</div>` }));
  scrollTranscript(true);
}

function ensureTurn() {
  const inner = transInner();
  if (state.turn) return state.turn;
  const wrap = el('div', { class: 'turn' });
  const meta = el('div', { class: 'turn-meta' });
  meta.innerHTML = `<span class="dot live"></span><span class="turn-model">thinking…</span>`;
  const body = el('div', { class: 'turn-body' });
  const reasoning = el('details', { class: 'reasoning', html: '<summary>reasoning</summary><p></p>' });
  const tools = el('div', { class: 'turn-tools' });
  wrap.append(meta, reasoning, body, tools);
  inner.append(wrap);
  state.turn = { wrap, meta, body, tools, reasoning, text: '', rendered: '' };
  scrollTranscript(true);
  return state.turn;
}

function appendAssistant(text) {
  const turn = ensureTurn();
  turn.body.innerHTML = md(text);
  turn.meta.querySelector('.turn-model').textContent = `${state.model.split('/').pop()}`;
  turn.meta.querySelector('.dot')?.classList.remove('live');
  state.turn = null;
  scrollTranscript();
}

function appendTool({ name, title, args }) {
  const turn = state.turn || state.lastTurn;
  const host = turn?.tools || transInner();
  const card = el('div', { class: 'tool' });
  card.innerHTML = `<div class="tool-head"><span class="tool-name">${escapeHtml(name)}</span>
    <span class="tool-title">${escapeHtml(title || args?.command || args?.file_path || args?.pattern || '')}</span>
    <span class="grow"></span><span class="tool-sum"></span></div>
    <div class="tool-body" hidden></div>`;
  host.append(card);
  card._out = '';
  scrollTranscript();
  return card;
}

function toolOutput(card, chunk) {
  if (!card) return;
  card._out += chunk;
  const body = card.querySelector('.tool-body');
  if (!body) return;
  body.hidden = false;
  body.textContent = card._out.slice(-6000);
  body.scrollTop = body.scrollHeight;
}

function finishTool(card, { ok, summary, display, output }) {
  if (!card) return;
  card.classList.toggle('ok', ok !== false);
  card.classList.toggle('err', ok === false);
  card.querySelector('.tool-sum').textContent = summary || '';
  const body = card.querySelector('.tool-body');
  if (display?.kind === 'diff' && display.diff) {
    body.hidden = false;
    body.innerHTML = renderDiff(display.diff);
  } else if (output && !card._out) {
    body.hidden = false;
    body.textContent = String(output).slice(0, 4000);
  }
}

function appendNotice(text, kind = 'info') {
  transInner().append(el('div', { class: `notice ${kind}`, text: String(text) }));
  scrollTranscript();
}

function appendPermission(request) {
  const turn = state.turn || state.lastTurn;
  const host = turn?.tools || transInner();
  const card = el('div', { class: 'perm' });
  card.innerHTML = `<h4>${icon('warn', 14)} Permission required</h4>
    <div class="perm-title">${escapeHtml(request.title || request.tool || 'Tool action')}</div>
    ${request.command ? `<div class="perm-cmd"><code>${escapeHtml(request.command)}</code></div>` : ''}
    ${request.risks?.length ? `<div class="hint">Risk: ${escapeHtml(request.risks.join('; '))}</div>` : ''}
    <div class="row"><button class="btn sm primary" data-allow>Allow</button><button class="btn sm danger" data-deny>Deny</button></div>`;
  host.append(card);
  card.querySelector('[data-allow]').onclick = () => {
    state.run?.resolvePermission(request.requestId, { approved: true });
    card.querySelector('.row').innerHTML = '<span class="badge ok">approved</span>';
  };
  card.querySelector('[data-deny]').onclick = () => {
    state.run?.resolvePermission(request.requestId, { approved: false, reason: 'denied by user' });
    card.querySelector('.row').innerHTML = '<span class="badge err">denied</span>';
  };
  scrollTranscript();
}

/* ------------------------------------------------------------------- run --- */

async function send(text) {
  if (!text?.trim() || state.running) return;
  if (await handleSlash(text.trim())) return;
  if (!state.project) await createProject('My first app', { silent: true });

  const inner = transInner();
  inner.querySelector('.welcome')?.remove();
  appendUser(text);
  $('#prompt').value = '';
  autoGrow();
  setRunning(true);

  const run = new Run({ id: uid('run_', 5), threadId: state.thread.id, projectId: state.project.id, mode: state.mode, model: state.model });
  state.run = run;
  state.currentTurn = null;
  const harness = new Harness({
    store: state.store,
    fs: state.fs,
    shell: state.shell,
    project: state.project,
    projectId: state.project.id,
    threadId: state.thread.id,
    mode: state.mode,
    modelRef: state.model,
    requestedModel: state.model,
    settings: () => state.settings,
    signal: run.signal,
    getDb,
    releaseDb: (path) => state.dbs.delete(path),
    deploy: (args) => doDeploy(args.target || 'preview', { projectName: args.projectName }),
    runtimeInfo: () => ({
      mode: 'browser',
      filesystem: state.fs.mode,
      sqlite: true,
      python: RUNTIME_MATRIX.python.how,
      node: RUNTIME_MATRIX.node.how,
      mcp: state.mcp.clients.map((client) => client.name),
      c: canCompileC(state.settings) ? 'compile endpoint configured' : 'not configured (WASI binaries still run)',
      deploy: { github: Boolean(state.github?.token), targets: Object.keys(DEPLOY_TARGETS) },
      storage: navigator.storage?.estimate ? 'available' : 'unknown',
    }),
    confirm: (req) => run.requestPermission(req),
    beforeMutation: async (label) => {
      if (Date.now() - (state.lastCheckpoint || 0) < 30_000) return;
      state.lastCheckpoint = Date.now();
      const files = await state.fs.snapshot(state.project.id);
      await state.store.snapshot(state.project.id, files, label || 'auto');
    },
    emit: (event) => run.emit(event),
    node: state.node,
    jobs: state.jobs,
    mcpTools: state.mcp.tools,
    hooks: state.hooks,
    snapshot: async () => {
      const files = await state.fs.snapshot(state.project.id);
      return files;
    },
  });
  state.harness = harness;

  run.onEvent(handleEvent);
  run.status = 'running';
  try {
    const result = await harness.send(text);
    run.emit({ type: 'done', finishReason: result.finishReason, steps: harness.usage.calls, usage: harness.usage, filesChanged: [...harness.filesChanged] });
  } catch (err) {
    if (err?.name !== 'AbortError') run.emit({ type: 'error', message: err.message });
    else run.emit({ type: 'done', finishReason: 'stopped', steps: harness.usage.calls, usage: harness.usage });
  } finally {
    run.status = 'done';
    setRunning(false);
    state.run = null;
    state.lastTurn = null;
    await refreshFiles();
    await renderSessions();
    await renderDeployments();
    if (state.view === 'db') await renderDbs();
  }
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'model':
      $('#chip-model-txt').textContent = `${ev.model.split('/').pop()}`;
      setStatus(`calling ${ev.label || ev.provider}…`);
      break;
    case 'text':
      ensureTurn().text += ev.text;
      onTextFlush();
      break;
    case 'text_done':
      if (state.turn) {
        state.turn.body.innerHTML = md(ev.text || state.turn.text);
        state.turn.rendered = ev.text || state.turn.text;
      }
      break;
    case 'reasoning': {
      const turn = ensureTurn();
      turn.reasoning.hidden = false;
      turn.reasoning.querySelector('p').textContent = (turn.reasoning.querySelector('p').textContent + ev.text).slice(-2000);
      break;
    }
    case 'tool_start': {
      const turn = ensureTurn();
      turn.body.innerHTML = md(turn.text);
      const card = appendTool({ name: ev.name, title: ev.title, args: ev.args });
      state.toolCards = state.toolCards || new Map();
      state.toolCards.set(ev.toolCallId, card);
      state.activeTool = card;
      turn.meta.querySelector('.turn-model').textContent = `${ev.name}…`;
      setStatus(`${ev.name}…`);
      break;
    }
    case 'tool_output':
      toolOutput(state.activeTool, ev.text);
      break;
    case 'tool_end': {
      const card = state.toolCards?.get(ev.toolCallId) || state.activeTool;
      finishTool(card, ev);
      state.toolCards?.delete(ev.toolCallId);
      if (state.activeTool === card) state.activeTool = null;
      break;
    }
    case 'todos':
      renderTodos(ev.todos);
      break;
    case 'plan':
      appendNotice(`Plan submitted:\n${ev.plan}`, 'plan');
      break;
    case 'permission':
    case 'permission_pending':
      appendPermission(ev.request || ev);
      break;
    case 'permission_timeout':
      appendNotice('Permission request timed out — the action was denied.', 'warn');
      break;
    case 'notice':
      appendNotice(ev.text, ev.level === 'warn' ? 'warn' : 'info');
      break;
    case 'provider_error':
      appendNotice(`${PROVIDERS[ev.provider]?.label || ev.provider}: ${ev.message}`, 'warn');
      break;
    case 'usage': {
      state.lastUsage = ev.usage;
      const pct = Math.min(100, Math.round(((ev.usage?.input || 0) / (ev.usage?.contextWindow || 200_000)) * 100));
      const meter = $('#ctx-meter');
      meter.textContent = `${pct}%`;
      meter.title = `${(ev.usage?.input || 0).toLocaleString()} of ${(ev.usage?.contextWindow || 200_000).toLocaleString()} tokens`;
      meter.classList.toggle('hot', pct >= 80);
      break;
    }
    case 'compaction':
      appendNotice(`Compacted ${ev.dropped} earlier messages to free context.`, 'info');
      break;
    case 'subagent_start':
      appendNotice(`Subagent (${ev.subagent}): ${ev.description} — working…`, 'info');
      break;
    case 'subagent_end':
      appendNotice(`Subagent finished: ${ev.description} (${ev.steps} steps)`, 'info');
      break;
    case 'done': {
      const turn = state.turn;
      if (turn) {
        if (!turn.text.trim() && !turn.tools.childElementCount) turn.body.innerHTML = '<p class="muted">(no output)</p>';
        const stats = el('div', { class: 'turn-stats' });
        const u = ev.usage || {};
        stats.textContent = `${ev.steps || 0} model calls · ${(u.input || 0).toLocaleString()} in / ${(u.output || 0).toLocaleString()} out${ev.filesChanged?.length ? ` · ${ev.filesChanged.length} files touched` : ''}${ev.finishReason === 'stopped' ? ' · stopped' : ''}`;
        turn.wrap.append(stats);
        turn.meta.querySelector('.dot')?.classList.remove('live');
      }
      state.lastTurn = state.turn;
      state.turn = null;
      setStatus('ready');
      refreshPreview({ force: Boolean(ev.filesChanged?.length) });
      break;
    }
    case 'error':
      appendNotice(ev.message, 'err');
      setStatus('ready');
      break;
    default:
      break;
  }
  scrollTranscript();
}

const onTextFlush = debounce(() => {
  if (state.turn) state.turn.body.innerHTML = md(state.turn.text);
  scrollTranscript();
}, 90);

function renderTodos(todos) {
  let box = $('#todo-box');
  if (!box) {
    box = el('div', { class: 'todo-box', id: 'todo-box' });
    transInner().append(box);
  }
  box.innerHTML = `<h5>Plan</h5>${todos
    .map((t) => `<div class="todo ${t.status}"><span class="mark">${t.status === 'completed' ? icon('check', 12) : t.status === 'in_progress' ? icon('play', 10) : '○'}</span>${escapeHtml(t.content)}</div>`)
    .join('')}`;
}

function setRunning(running) {
  state.running = running;
  $('#btn-send').hidden = running;
  $('#btn-stop').hidden = !running;
  $('#status-dot').className = `dot ${running ? 'live' : 'ok'}`;
  if (running) {
    setStatus('working…');
    state.turn = null;
    state.lastTurn = state.lastTurn || null;
  }
}

function setStatus(text) {
  const node = $('#status-text');
  if (node) node.textContent = text;
}

/* ----------------------------------------------------------------- files --- */

async function refreshFiles() {
  if (!state.project) return;
  state.files = await state.fs.tree(state.project.id);
  renderTree();
  if (state.previewTimer) clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(() => refreshPreview(), 250);
  const where = STORAGE_LABEL[state.storage] || 'in this browser';
  const count = state.files.filter((f) => !f.dir).length;
  $('#storage-note').textContent =
    state.storage === 'memory' ? `${count} files · temporary (storage blocked — export before closing)` : `${count} files · ${where}`;
  $('#storage-note').title = state.storage === 'memory'
    ? 'This browser context blocks persistent storage (private mode or a sandboxed frame). Files vanish on reload.'
    : 'Your files never leave this tab. Clearing site data deletes them.';
}

const STORAGE_LABEL = { opfs: 'real files in this browser', indexeddb: 'saved in this browser', memory: 'temporary memory' };

function renderTree() {
  const host = $('#file-tree');
  host.innerHTML = '';
  if (!state.files.length) {
    host.innerHTML = '<div class="hint pad">Empty project. Ask the agent to build something.</div>';
    return;
  }
  for (const node of state.files) {
    const row = el('div', { class: `tree-row ${node.dir ? 'dir' : ''} ${node.path === state.editorPath ? 'active' : ''}` });
    row.style.paddingLeft = `${8 + node.depth * 12}px`;
    row.innerHTML = `${icon(node.dir ? 'folder' : 'file', 13)}<span class="path">${escapeHtml(node.path.split('/').pop())}</span>${node.dir ? '' : `<span class="size">${bytes(node.size || 0)}</span>`}`;
    if (!node.dir) row.onclick = () => openFile(node.path);
    host.append(row);
  }
}

async function openFile(path) {
  if (isBinaryPath(path)) {
    toast(`${path} is binary — export the project to inspect it`, 'warn');
    return;
  }
  try {
    const text = await state.fs.readText(state.project.id, path);
    $('#editor').value = text;
    $('#editor-path').textContent = path;
    $('#btn-save-file').hidden = false;
    state.editorPath = path;
    state.editorDirty = false;
    renderTree();
    setView('files');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function saveFile() {
  if (!state.editorPath) return;
  await state.fs.write(state.project.id, state.editorPath, $('#editor').value);
  state.editorDirty = false;
  toast(`Saved ${state.editorPath}`, 'ok', 1600);
  await refreshFiles();
}

/* -------------------------------------------------------------- terminal --- */

function mountTerminal(force) {
  const host = $('#term-host');
  if (!state.termView || force) {
    host.innerHTML = '';
    if (!state.shell) return;
    state.termView = new TerminalView(host, {
      cols: 100,
      rows: 26,
      onInput: (data) => handleTermInput(data),
      onResize: () => {},
      onBell: () => {},
    });
    state.termBuf = '';
    state.termView.write('\u001b[1;36mAlphaCode shell\u001b[0m — project files, real commands. Type \u001b[1mhelp\u001b[0m.\r\n\r\n');
    prompt();
  }
  state.termView.focus?.();
}

function prompt() {
  const cwd = state.shell?.cwd || '';
  state.termView.write(`\u001b[1;32m/${cwd || ''}\u001b[0m \u001b[1;34m$\u001b[0m `);
}

async function handleTermInput(data) {
  const view = state.termView;
  if (!state.shell || !view) return;
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      view.write('\r\n');
      const line = state.termBuf;
      state.termBuf = '';
      if (line.trim() === 'clear') {
        view.clear?.();
      }
      const { output } = await state.shell.run(line, {
        onOutput: (chunk) => view.write(chunk.replace(/\n/g, '\r\n')),
      });
      if (output && !output.endsWith('\n')) view.write('\r\n');
      prompt();
      continue;
    }
    if (ch === '\u007f' || ch === '\b') {
      if (state.termBuf.length) {
        state.termBuf = state.termBuf.slice(0, -1);
        view.write('\b \b');
      }
      continue;
    }
    if (ch === '\u0003') {
      view.write('^C\r\n');
      state.termBuf = '';
      prompt();
      continue;
    }
    if (ch === '\u000c') {
      view.clear?.();
      prompt();
      continue;
    }
    if (ch === '\t') continue;
    if (ch >= ' ') {
      state.termBuf += ch;
      view.write(ch);
    }
  }
}

/* -------------------------------------------------------------- database --- */

async function getDb(path) {
  const key = `${state.project.id}:${path}`;
  if (state.dbs.has(key)) {
    const cached = state.dbs.get(key);
    if (cached) return cached;
  }
  const db = await openDatabase(state.fs, state.project.id, path);
  state.dbs.set(key, db);
  return db;
}

async function renderDbs() {
  const files = await dbFiles(state.fs, state.project.id);
  const host = $('#db-list');
  host.innerHTML = '';
  if (!files.length) {
    host.innerHTML = '<div class="hint pad">No <code>.sqlite</code> files yet. Ask the agent, or press +.</div>';
    return;
  }
  for (const f of files) {
    const row = el('div', { class: `list-item ${f.path === state.dbPath ? 'active' : ''}` });
    row.innerHTML = `${icon('database', 14)}<div class="name">${escapeHtml(f.path)}</div><div class="meta">${bytes(f.size)}</div>`;
    row.onclick = () => openDb(f.path);
    host.append(row);
  }
}

async function openDb(path) {
  state.dbPath = path;
  $('#db-path').textContent = path;
  await renderDbs();
  await showSchema();
}

async function showSchema() {
  if (!state.dbPath) return;
  const db = await getDb(state.dbPath);
  const schema = db.schema();
  const host = $('#db-result');
  if (!schema.length) {
    host.innerHTML = '<div class="hint">Empty database — run a CREATE TABLE statement.</div>';
    return;
  }
  host.innerHTML = schema
    .map(
      (t) => `<details class="schema"><summary><b>${escapeHtml(t.name)}</b> <span class="hint">${t.count} rows · ${t.columns.length} cols</span></summary>
      <table class="grid"><thead><tr><th>column</th><th>type</th><th>not null</th><th>pk</th></tr></thead>
      <tbody>${t.columns.map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.type || '')}</td><td>${c.notNull ? 'yes' : ''}</td><td>${c.pk ? 'yes' : ''}</td></tr>`).join('')}</tbody></table>
      ${t.indexes.length ? `<div class="hint">indexes: ${t.indexes.map((i) => escapeHtml(i.name)).join(', ')}</div>` : ''}</details>`,
    )
    .join('');
}

async function runSql() {
  if (!state.dbPath) {
    state.dbPath = prompt('Database file path', 'app.sqlite') || '';
    if (!state.dbPath) return;
    $('#db-path').textContent = state.dbPath;
  }
  const sql = $('#db-sql').value;
  const host = $('#db-result');
  try {
    const db = await getDb(state.dbPath);
    const result = db.exec(sql);
    await saveDatabase(state.fs, state.project.id, db);
    $('#db-status').textContent = `${result.type === 'write' ? `${result.changes} rows changed` : `${result.rows.length} rows`}`;
    if (result.type === 'rows') {
      host.innerHTML = result.columns.length
        ? `<table class="grid"><thead><tr>${result.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
           <tbody>${result.rows.map((r) => `<tr>${result.columns.map((c) => `<td>${escapeHtml(String(r[c] ?? 'NULL'))}</td>`).join('')}</tr>`).join('')}</tbody></table>`
        : '<div class="hint">No rows.</div>';
    } else {
      host.innerHTML = `<div class="hint">${result.statements.length} statement(s) executed · ${result.changes} row(s) changed</div>`;
    }
    await renderDbs();
    await refreshFiles();
  } catch (err) {
    host.innerHTML = `<div class="err-box">${escapeHtml(err.message)}</div>`;
  }
}

/* ---------------------------------------------------------------- deploy --- */

async function doDeploy(target, { projectName, open = true } = {}) {
  if (!state.project) throw new Error('Open a project first');
  const files = await state.fs.snapshot(state.project.id);
  const result = await deployProject({
    target,
    files,
    projectName: projectName || state.project.name,
    githubToken: state.github?.token || '',
    onProgress: (line) => appendNotice(line, 'info'),
  });
  const row = await state.store.addDeployment({ projectId: state.project.id, ...result });
  state.deployments.unshift(row);
  await renderDeployments();
  if (target === 'preview' && result.previewHtml) {
    state.settings = await state.store.saveSettings({ lastPreview: { html: result.previewHtml, claimId: result.claimId, projectId: state.project.id } });
    if (open) window.open(URL.createObjectURL(new Blob([result.previewHtml], { type: 'text/html' })), '_blank');
  } else if (open && /^https?:/.test(result.url)) {
    window.open(result.url, '_blank');
  }
  toast(target === 'preview' ? 'Preview ready' : `Opening ${target} import…`, 'ok');
  return result;
}

async function renderDeployments() {
  if (!state.project) return;
  state.deployments = await state.store.deployments(state.project.id);
  const host = $('#deploy-list');
  if (!host) return;
  host.innerHTML = '';
  if (!state.deployments.length) {
    host.innerHTML = '<div class="hint pad">Nothing deployed yet.</div>';
    return;
  }
  for (const d of state.deployments) {
    const row = el('div', { class: 'dep-row' });
    const badge = d.provider === 'preview' ? '<span class="tag warn">preview</span>' : '<span class="tag ok">live</span>';
    row.innerHTML = `<span class="tag info">${escapeHtml(d.provider)}</span>${badge}
      <span class="mono">${escapeHtml(d.repo || (d.url || '').slice(0, 60))}</span>
      <span class="hint">${timeAgo(d.createdAt)}</span><div class="grow"></div>
      ${d.claimId ? `<button class="btn sm" data-claim="${d.claimId}">Claim URL</button>` : ''}
      ${d.url ? `<button class="btn sm" data-open="${escapeHtml(d.url)}">Open</button>` : ''}`;
    const claim = row.querySelector('[data-claim]');
    if (claim) claim.onclick = () => claimPreview(d);
    const open = row.querySelector('[data-open]');
    if (open) open.onclick = () => window.open(d.url, '_blank');
    host.append(row);
  }
  renderGithub();
}

function renderGithub() {
  const connected = Boolean(state.github?.token);
  $('#chip-github').hidden = !connected;
  if (connected) $('#chip-github-txt').textContent = state.github.login || 'github';
  $('#github-state').textContent = connected ? `connected as ${state.github.login || 'you'}` : 'not connected';
  $('#btn-connect-github').textContent = connected ? 'Reconnect GitHub' : 'Connect GitHub';
}

async function claimPreview(deployment) {
  const url = `${location.origin}/#/p/${deployment.claimId}`;
  await copyText(url);
  toast('Preview URL claimed — it now opens from this browser', 'ok', 4200);
}

async function handlePreviewRoute() {
  const id = location.hash.split('/').pop();
  const last = state.settings.lastPreview;
  if (last?.claimId === id && last.html) {
    document.body.innerHTML = `<iframe title="preview" style="position:fixed;inset:0;width:100%;height:100%;border:0" src="data:text/html;charset=utf-8,${encodeURIComponent(last.html)}"></iframe>`;
  }
}

async function handleClaimRoute() {
  const id = location.hash.split('/').pop();
  history.replaceState(null, '', '/');
  state.pendingClaim = id;
}

/* -------------------------------------------------------------- settings --- */

function openSettings() {
  const body = $('#modal-body');
  const heading = $('#modal-title');
  if (heading) heading.textContent = 'Settings';
  const keys = state.settings.keys || {};
  const rows = Object.values(PROVIDERS)
    .filter((p) => !p.offline)
    .map(
      (p) => `<div class="field">
        <label>${escapeHtml(p.label)} ${p.keyless ? '<span class="tag">keyless fallback</span>' : ''}</label>
        <div class="row">
          <input type="password" data-key="${p.id}" placeholder="${p.keyless ? 'optional' : 'API key'}" value="${keys[p.id]?.key ? '••••••••' : ''}" autocomplete="off">
          <input type="text" data-model="${p.id}" placeholder="model (optional)" value="${escapeHtml(keys[p.id]?.model || '')}">
        </div>
        ${p.docs ? `<div class="hint">${p.note || ''} · <a href="${p.docs}" target="_blank" rel="noopener">get a key</a></div>` : ''}
      </div>`,
    )
    .join('');

  body.innerHTML = `
    <section>
      <h3>Model access</h3>
      <p class="hint">Requests go from this browser straight to the provider. Keys are stored only in this browser's IndexedDB — there is no AlphaCode server to leak them.</p>
      <div class="field"><label>Default model</label>
        <select id="set-model">
          ${Object.entries(FREE_MODELS).map(([prov, models]) => `<optgroup label="${PROVIDERS[prov].label}">${models.map((m) => `<option value="${m.id}" ${state.model === m.id ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}</optgroup>`).join('')}
        </select>
      </div>
      <div class="field"><label>Permission mode</label>
        <select id="set-mode">
          <option value="default" ${state.mode === 'default' ? 'selected' : ''}>default — ask before shell & deletes</option>
          <option value="accept-edits" ${state.mode === 'accept-edits' ? 'selected' : ''}>accept edits — auto-write files</option>
          <option value="plan" ${state.mode === 'plan' ? 'selected' : ''}>plan — read-only</option>
          <option value="bypass" ${state.mode === 'bypass' ? 'selected' : ''}>bypass — never ask</option>
        </select>
      </div>
      <label class="check"><input type="checkbox" id="set-demo" ${state.settings.demo !== false ? 'checked' : ''}> use the offline demo model when no key works</label>
      <div class="fields">${rows}</div>
    </section>
    <section>
      <h3>Runtimes</h3>
      <p class="hint">Everything below executes inside this tab. First use downloads what it needs; after that it is cached.</p>
      <div class="runtime-grid">
        ${Object.entries(RUNTIME_MATRIX)
          .map(([name, info]) => `<div class="runtime ${info.real ? 'real' : 'partial'}">
            <div class="row"><strong>${escapeHtml(name)}</strong>${info.real ? '<span class="tag ok">real</span>' : '<span class="tag">needs setup</span>'}</div>
            <div class="hint">${escapeHtml(info.how)}</div>
            <div class="hint dim">${escapeHtml(info.notes)}</div>
          </div>`)
          .join('')}
      </div>
      <div class="field"><label>C compiler endpoint (optional)</label>
        <input type="text" id="set-cc" placeholder="https://your-compiler.example.com/compile" value="${escapeHtml(state.settings.cCompilerEndpoint || '')}">
        <div class="hint">C/C++ needs clang+lld+sysroot (~60 MB). Point this at a service you run, or compile elsewhere and run the .wasm with <code>wasm main.wasm</code>.</div>
      </div>
      <div class="row">
        <button class="btn" id="set-python">${state.pythonReady ? 'Python loaded' : 'Load Python now'}</button>
        <button class="btn" id="set-node">Check Node runtime</button>
      </div>
    </section>

    <section>
      <h3>MCP servers</h3>
      <p class="hint">Connect remote MCP servers (Gemini, Claude, GitHub, Linear…). Their tools appear to the agent as <code>mcp__server__tool</code>. Requests go straight from this browser to the server.</p>
      <div id="mcp-list">${(state.settings.mcp || [])
        .map((server, index) => `<div class="field mcp-row">
          <div class="row">
            <input type="text" data-mcp-name="${index}" placeholder="name" value="${escapeHtml(server.name || '')}">
            <input type="text" data-mcp-url="${index}" placeholder="https://server.example.com/mcp" value="${escapeHtml(server.url || '')}">
            <button class="icon-btn sm" data-mcp-remove="${index}" data-icon="trash" title="Remove"></button>
          </div>
          <div class="row">
            <input type="password" data-mcp-token="${index}" placeholder="Bearer token (optional)" value="${server.token ? '••••••' : ''}" autocomplete="off">
            <label class="check"><input type="checkbox" data-mcp-relay="${index}" ${server.useRelay ? 'checked' : ''}> route through relay (CORS)</label>
          </div>
        </div>`)
        .join('')}</div>
      <div class="row">
        <button class="btn" id="set-mcp-add" data-icon="plus">Add server</button>
        <button class="btn primary" id="set-mcp-connect" data-icon="link">Connect all</button>
      </div>
      <div class="hint" id="mcp-state">${state.mcp.clients.length ? `connected: ${state.mcp.clients.map((c) => c.name).join(', ')}` : 'none connected'}</div>
    </section>

    <section>
      <h3>Hooks</h3>
      <p class="hint">Project hooks live in <code>.alphacode/hooks.js</code>. A hook can block a tool, rewrite its arguments, or add a note for the model — the browser equivalent of Claude Code's hooks.</p>
      <textarea id="set-hooks" class="editor" style="min-height:120px" spellcheck="false" placeholder="export default { pre_tool: [{ match: 'bash', run: () => ({ block: 'no shell' }) }] }">${escapeHtml(state.settings.hooks || '')}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn" id="set-hooks-save">Save hooks</button><span class="hint">Saved in this browser and reapplied on the next turn.</span></div>
    </section>

    <section>
      <h3>Your data</h3>
      <p class="hint">Projects, files and keys live in this browser. Export before clearing site data.</p>
      <div class="row">
        <button class="btn" id="set-export">Export all projects</button>
        <button class="btn danger" id="set-wipe">Delete everything</button>
      </div>
    </section>`;

  $('#set-export').onclick = exportAll;
  $('#set-wipe').onclick = async () => {
    if (!confirm('Delete every project, file and key in this browser?')) return;
    indexedDB.deleteDatabase('alphacode');
    if (navigator.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('projects', { recursive: true }).catch(() => {});
    }
    location.reload();
  };
  $('#modal').hidden = false;
  paintIcons(body);

  $('#set-cc').onchange = async (e) => {
    state.settings = await state.store.saveSettings({ cCompilerEndpoint: e.target.value.trim() });
  };
  $('#set-python').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'loading…';
    try {
      await ensurePython();
      state.pythonReady = true;
      e.target.textContent = 'Python loaded';
      toast('CPython is ready in this tab', 'ok');
    } catch (err) {
      e.target.textContent = 'Load Python now';
      e.target.disabled = false;
      toast(err.message, 'err');
    }
  };
  $('#set-node').onclick = async () => {
    const files = await state.fs.snapshot(state.project.id).catch(() => ({}));
    const sample = Object.keys(files).find((f) => f.endsWith('.js'));
    toast(`Node runtime ready${sample ? ` — try: node ${sample}` : ''}`, 'ok');
  };
  $('#set-mcp-add').onclick = async () => {
    const list = [...(state.settings.mcp || []), { name: '', url: '', headers: {} }];
    state.settings = await state.store.saveSettings({ mcp: list });
    openSettings();
  };
  $('#set-mcp-connect').onclick = async () => {
    const list = (state.settings.mcp || []).map((server) => ({ ...server }));
    if (!list.length) return toast('Add a server first', 'warn');
    const status = $('#mcp-state');
    status.textContent = 'connecting…';
    await loadMcp();
    status.textContent = state.mcp.clients.length
      ? `connected: ${state.mcp.clients.map((c) => `${c.name} (${state.mcp.tools.filter((t) => t.name.startsWith(`mcp__${c.name}__`)).length} tools)`).join(', ')}`
      : `none connected — ${state.mcp.errors[0]?.error || 'check the URL'}`;
  };
  body.querySelectorAll('[data-mcp-remove]').forEach((button) => {
    button.onclick = async () => {
      const list = [...(state.settings.mcp || [])];
      list.splice(Number(button.dataset.mcpRemove), 1);
      state.settings = await state.store.saveSettings({ mcp: list });
      openSettings();
    };
  });
  body.querySelectorAll('[data-mcp-name],[data-mcp-url],[data-mcp-token],[data-mcp-relay]').forEach((input) => {
    input.onchange = async () => {
      const list = [...(state.settings.mcp || [])];
      const index = Number(input.dataset.mcpName ?? input.dataset.mcpUrl ?? input.dataset.mcpToken ?? input.dataset.mcpRelay);
      const server = { name: '', url: '', headers: {}, ...list[index] };
      if (input.dataset.mcpName !== undefined) server.name = input.value.trim();
      if (input.dataset.mcpUrl !== undefined) server.url = input.value.trim();
      if (input.dataset.mcpToken !== undefined && !input.value.startsWith('••')) {
        server.token = input.value.trim();
        server.headers = { ...(server.headers || {}), ...(server.token ? { Authorization: `Bearer ${server.token}` } : {}) };
      }
      if (input.dataset.mcpRelay !== undefined) server.useRelay = input.checked;
      list[index] = server;
      state.settings = await state.store.saveSettings({ mcp: list });
    };
  });
  $('#set-hooks-save').onclick = async () => {
    state.settings = await state.store.saveSettings({ hooks: $('#set-hooks').value });
    state.hooks = await loadHooks({ fs: state.fs, projectId: state.project.id, settings: state.settings }).catch(() => null);
    toast('Hooks saved', 'ok');
  };
  $('#set-model').onchange = async (e) => {
    state.model = e.target.value;
    state.settings = await state.store.saveSettings({ model: state.model });
    renderChrome();
  };
  $('#set-mode').onchange = async (e) => {
    state.mode = e.target.value;
    state.settings = await state.store.saveSettings({ mode: state.mode });
    $('#btn-mode').textContent = `mode: ${state.mode}`;
  };
  $('#set-demo').onchange = async (e) => {
    state.settings = await state.store.saveSettings({ demo: e.target.checked });
  };
  let saveTimer;
  body.querySelectorAll('[data-key],[data-model]').forEach((input) => {
    input.oninput = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const next = { ...(state.settings.keys || {}) };
        body.querySelectorAll('[data-key]').forEach((k) => {
          const id = k.dataset.key;
          const value = k.value.startsWith('••') ? next[id]?.key : k.value.trim();
          const model = body.querySelector(`[data-model="${id}"]`)?.value.trim() || '';
          if (!value && !model) delete next[id];
          else next[id] = { key: value || '', model };
        });
        state.settings = await state.store.saveSettings({ keys: next });
      }, 350);
    };
  });
}

async function exportAll() {
  const files = {};
  for (const p of state.projects) {
    for (const f of await state.fs.list(p.id)) {
      if (isBinaryPath(f.path)) continue;
      files[`${p.name.replace(/[^\w.-]+/g, '-')}/${f.path}`] = await state.fs.readText(p.id, f.path).catch(() => '');
    }
  }
  const size = download('alphacode-projects.zip', zipSync(files));
  toast(`Exported ${Object.keys(files).length} files (${bytes(size)})`, 'ok');
}

async function exportProject() {
  if (!state.project) return;
  const files = await state.fs.snapshot(state.project.id);
  const size = download(`${state.project.name.replace(/[^\w.-]+/g, '-') || 'project'}.zip`, zipSync(files));
  toast(`Exported ${Object.keys(files).length} files (${bytes(size)})`, 'ok');
}

/* ---------------------------------------------------------------- python --- */

async function ensurePython() {
  return loadPython({ onProgress: (step) => setStatus(step.message) });
}

/* ----------------------------------------------------------------- views --- */

function setView(view) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  if (view === 'files') refreshFiles();
  if (view === 'terminal') mountTerminal();
  if (view === 'db') renderDbs();
  if (view === 'deploy') renderDeployments();
  closeDrawer();
}

function renderChrome() {
  $('#chip-model-txt').textContent = state.model.split('/').pop();
  $('#btn-model').textContent = `model: ${state.model.split('/').pop()}`;
  $('#btn-mode').textContent = `mode: ${state.mode}`;
  const ready = ['node', 'python', 'npm'].filter((name) => RUNTIME_MATRIX[name]?.real);
  const chip = $('#chip-runtime-txt');
  if (chip) chip.textContent = `${ready.join(' · ')} · in-tab`;
  const chipEl = $('#chip-runtime');
  if (chipEl) chipEl.title = ready.map((name) => `${name}: ${RUNTIME_MATRIX[name].how}`).join('\n');
  renderGithub();
}

const SLASH = [
  { cmd: '/help', desc: 'commands and shortcuts' },
  { cmd: '/clear', desc: 'clear this session' },
  { cmd: '/model', desc: 'choose a model' },
  { cmd: '/plan', desc: 'switch to plan mode' },
  { cmd: '/preview', desc: 'build a local preview' },
  { cmd: '/deploy', desc: 'open the deploy panel' },
  { cmd: '/db', desc: 'open the database panel' },
  { cmd: '/terminal', desc: 'open the shell' },
  { cmd: '/files', desc: 'open the file tree' },
  { cmd: '/export', desc: 'download the project as a zip' },
  { cmd: '/cost', desc: 'usage and context' },
  { cmd: '/doctor', desc: 'runtime diagnostics' },
  { cmd: '/jobs', desc: 'background processes' },
  { cmd: '/history', desc: 'checkpoints and versions' },
  { cmd: '/mcp', desc: 'MCP servers and tools' },
  { cmd: '/templates', desc: 'start from a template' },
  { cmd: '/init', desc: 'write ALPHACODE.md for this project' },
];

async function handleSlash(text) {
  const [cmd, ...rest] = text.split(/\s+/);
  switch (cmd) {
    case '/help':
      appendAssistant(`**Commands**\n\n${SLASH.map((s) => `- \`${s.cmd}\` — ${s.desc}`).join('\n')}\n\n**Shortcuts** — \`⌘/Ctrl+Enter\` send · \`⇧Tab\` cycle mode · \`Esc\` stop`);
      return true;
    case '/clear':
      await state.store.clearThread(state.thread.id);
      clearTranscript();
      renderWelcome();
      return true;
    case '/model':
      openSettings();
      return true;
    case '/plan':
      state.mode = 'plan';
      state.settings = await state.store.saveSettings({ mode: 'plan' });
      renderChrome();
      toast('Plan mode: read-only tools', 'ok');
      return true;
    case '/preview':
      setView('deploy');
      await doDeploy('preview');
      return true;
    case '/deploy':
      setView('deploy');
      return true;
    case '/db':
      setView('db');
      return true;
    case '/terminal':
      setView('terminal');
      return true;
    case '/files':
      setView('files');
      return true;
    case '/export':
      await exportProject();
      return true;
    case '/cost': {
      const u = state.lastUsage || {};
      appendAssistant(
        `**Usage**\n\n- Model: \`${state.model}\`\n- Model calls: ${u.calls || 0}\n- Tokens: ${(u.input || 0).toLocaleString()} in / ${(u.output || 0).toLocaleString()} out\n- Context: ${(u.contextWindow || 200_000).toLocaleString()} window\n- Billing: none from AlphaCode — you pay your provider directly`,
      );
      return true;
    }
    case '/doctor': {
      const est = await navigator.storage?.estimate?.().catch(() => null);
      appendAssistant(
        `**Doctor**\n\n- Mode: client-side (no AlphaCode server)\n- Filesystem: \`${state.fs.mode}\` (${state.storage || state.fs.mode})\n- Storage used: ${est ? bytes(est.usage || 0) : 'unknown'}\n- SQLite: WASM (sql.js)\n- Python: ${pythonReady() ? 'loaded' : 'on demand (Pyodide)'}\n- Node: ${state.node ? 'runtime attached' : 'not attached'}\n- npm: ${state.node ? 'edge resolver + tarballs in tab' : 'unavailable'}\n- Background jobs: ${state.jobs ? `${state.jobs.list().length} running` : 'no manager'}\n- MCP: ${state.mcp.clients.length ? state.mcp.clients.map((c) => c.name).join(', ') : 'no servers connected'}\n- Hooks: ${state.hooks ? 'loaded' : 'none'}\n- C/C++: ${canCompileC(state.settings) ? 'compile endpoint set' : 'compile elsewhere → run the .wasm'}\n- GitHub: ${state.github?.token ? `connected as ${state.github.login}` : 'not connected'}\n- Model: \`${state.model}\``,
      );
      return true;
    }
    case '/jobs': {
      if (!state.jobs || !state.jobs.list().length) {
        appendAssistant('**No background jobs.** Start one with `npm run dev &` in the terminal, or ask the agent to use `job_start`.');
        return true;
      }
      const rows = state.jobs.list().map((job) => `- \`%${job.id}\` ${job.command} — ${job.status} (${(job.durationMs / 1000).toFixed(1)}s)`);
      appendAssistant(`**Background jobs**\n\n${rows.join('\n')}\n\nUse \`job_output\` in the terminal: \`fg %1\`, or stop one with \`kill %1\`.`);
      return true;
    }
    case '/history':
      $('#history-drawer').hidden = false;
      await renderHistory();
      return true;
    case '/mcp': {
      const lines = state.mcp.clients.length
        ? state.mcp.clients.map((client) => {
            const tools = state.mcp.tools.filter((tool) => tool.name.startsWith(`mcp__${client.name}__`));
            return `- **${client.name}** — ${tools.length} tools: ${tools.slice(0, 6).map((tool) => `\`${tool.name}\``).join(', ')}${tools.length > 6 ? '…' : ''}`;
          })
        : ['No MCP servers connected. Add one in **Settings → MCP servers**.'];
      appendAssistant(`**MCP**\n\n${lines.join('\n')}`);
      return true;
    }
    case '/templates':
      $('#template-sheet').hidden = false;
      return true;
    case '/init':
      await send('Read the project files and write an ALPHACODE.md describing purpose, structure, how to run it, and conventions. Keep it under 40 lines.');
      return true;
    default:
      if (cmd.startsWith('/')) {
        toast(`Unknown command ${cmd} — try /help`, 'warn');
        return true;
      }
      return false;
  }
}

function renderSlashMenu() {
  const menu = $('#slash-menu');
  const value = $('#prompt').value;
  if (!value.startsWith('/')) {
    menu.hidden = true;
    return;
  }
  const items = SLASH.filter((s) => s.cmd.startsWith(value.split(' ')[0]));
  if (!items.length) {
    menu.hidden = true;
    return;
  }
  menu.innerHTML = items.map((s) => `<div class="slash-item" data-cmd="${s.cmd}"><b>${s.cmd}</b><span>${escapeHtml(s.desc)}</span></div>`).join('');
  menu.hidden = false;
  menu.querySelectorAll('.slash-item').forEach((node) => {
    node.onclick = () => {
      $('#prompt').value = `${node.dataset.cmd} `;
      menu.hidden = true;
      $('#prompt').focus();
    };
  });
}

function autoGrow() {
  const ta = $('#prompt');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(220, ta.scrollHeight)}px`;
}

const MODES = ['default', 'accept-edits', 'plan', 'bypass'];

function closeDrawer() {
  $('#sidebar').classList.remove('open');
}

/* --------------------------------------------------------------- wiring --- */

function wireGlobal() {
  $('#btn-send').onclick = () => send($('#prompt').value);
  $('#btn-stop').onclick = () => {
    state.run?.stop();
    setStatus('stopping…');
  };
  const ta = $('#prompt');
  ta.addEventListener('input', () => {
    autoGrow();
    renderSlashMenu();
  });
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      send(ta.value);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.running) state.run?.stop();
      $('#modal').hidden = true;
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      state.mode = MODES[(MODES.indexOf(state.mode) + 1) % MODES.length];
      state.store.saveSettings({ mode: state.mode });
      renderChrome();
      toast(`mode: ${state.mode}`, '', 1400);
    }
  });

  $('#btn-menu').onclick = () => $('#sidebar').classList.toggle('open');
  $('#btn-new-project').onclick = async () => {
    const name = prompt('Project name', 'New project');
    if (!name) return;
    await createProject(name);
    setView('chat');
  };
  $('#btn-new-session').onclick = async () => {
    if (!state.project) return;
    const thread = await state.store.createThread(state.project.id, 'New session');
    await openThread(thread.id);
    setView('chat');
    toast('New session', 'ok', 1400);
  };
  $$('.tab').forEach((t) => (t.onclick = () => setView(t.dataset.view)));
  $('#btn-settings').onclick = openSettings;
  $('#btn-rename-project').onclick = async (event) => {
    event.stopPropagation();
    if (!state.project) return;
    const name = prompt('Project name', state.project.name);
    if (!name || name === state.project.name) return;
    const updated = await state.store.updateProject(state.project.id, { name }).catch(() => null);
    state.project = updated || { ...state.project, name };
    $('#project-name').textContent = state.project.name;
    toast('Renamed', 'ok');
  };
  $('#btn-close-modal').onclick = () => ($('#modal').hidden = true);
  $('#modal').onclick = (e) => {
    if (e.target.id === 'modal') $('#modal').hidden = true;
  };
  $('#btn-export').onclick = exportProject;
  $('#btn-preview').onclick = () => doDeploy('preview');
  $('#btn-refresh-files').onclick = refreshFiles;
  $('#btn-save-file').onclick = saveFile;
  $('#editor').addEventListener('input', () => {
    state.editorDirty = true;
  });
  $('#editor').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      saveFile();
    }
  });
  $('#btn-mode').onclick = () => {
    state.mode = MODES[(MODES.indexOf(state.mode) + 1) % MODES.length];
    state.store.saveSettings({ mode: state.mode });
    renderChrome();
    toast(`mode: ${state.mode}`, '', 1400);
  };
  $('#btn-model').onclick = openSettings;
  $('#btn-db-run').onclick = runSql;
  $('#btn-db-schema').onclick = showSchema;
  $('#btn-new-db').onclick = () => {
    const path = prompt('New database file', 'app.sqlite');
    if (!path) return;
    openDb(path);
  };
  $('#btn-deploy-preview').onclick = () => doDeploy('preview');
  $('#btn-connect-github').onclick = connectGithubFlow;
  $$('[data-deploy]').forEach((b) => (b.onclick = () => deployToProvider(b.dataset.deploy)));

  window.addEventListener('beforeunload', (e) => {
    if (state.running || state.editorDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

async function connectGithubFlow() {
  try {
    toast('Opening GitHub…', '', 1800);
    const result = await connectGitHub({ scope: 'public_repo' });
    const user = await whoAmI(result.token).catch(() => ({ login: result.login || 'you' }));
    state.github = { token: result.token, login: user.login, scope: result.scope };
    state.settings = await state.store.saveSettings({ github: state.github });
    renderGithub();
    toast(`Connected as ${user.login}`, 'ok');
  } catch (err) {
    toast(err.message, 'err', 6000);
  }
}

async function deployToProvider(provider) {
  if (!state.github?.token) {
    toast('Connect GitHub first — one OAuth click, no token to paste', 'warn', 4200);
    return;
  }
  try {
    const result = await doDeploy(provider, { projectName: state.project?.name });
    toast(result.repo ? `Pushed to ${result.repo}` : 'Done', 'ok');
  } catch (err) {
    toast(err.message, 'err', 6000);
  }
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin', `<div class="fatal">AlphaCode failed to start: ${escapeHtml(err.message)}</div>`);
});

// Exposed for the DOM test harness.
window.__alphacode = { state, send, handleEvent, setView, send2: send };

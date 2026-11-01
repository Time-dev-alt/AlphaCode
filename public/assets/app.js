/* AlphaCode SPA — chat harness, files, terminal, database, deploys, settings. */
import { $, $$, el, icon, paintIcons, toast, modal, confirmDialog, md, renderDiff, timeAgo, bytes, escapeHtml, copyText, debounce, toolIcon } from './util.js';
import { TerminalView } from './term.js';

const state = {
  csrf: '',
  user: null,
  guest: true,
  routing: null,
  quota: null,
  providers: {},
  deploy: {},
  runtime: null,
  contextWindow: 200000,
  activeToolId: '',
  projects: [],
  projectId: '',
  project: null,
  thread: null,
  messages: [],
  files: [],
  openDirs: new Set(),
  editorPath: '',
  editorDirty: false,
  model: '',
  mode: 'default',
  models: [],
  view: 'chat',
  running: false,
  runId: '',
  source: null,
  buffers: {},
  turn: null,
  terminals: [],
  termView: null,
  termId: '',
  termSource: null,
  dbFiles: [],
  dbPath: '',
  dbSchema: null,
  dbTable: '',
  connected: false,
  prefs: {},
  slashIndex: 0,
  paletteItems: [],
  paletteIndex: 0,
  attachments: [],
};

/* ------------------------------------------------------------------ api --- */
async function api(path, { method = 'GET', body, signal, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-AlphaCode-CSRF'] = state.csrf;
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin', signal });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text.slice(0, 300) };
  }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = json?.code;
    err.detail = json?.detail;
    throw err;
  }
  return json;
}

function setConnected(ok, text) {
  state.connected = ok;
  const dot = $('#status-dot');
  dot.className = `dot ${ok ? 'ok' : 'err'}`;
  $('#status-text').textContent = text || (ok ? 'connected' : 'offline');
}

/* --------------------------------------------------------------- boot ----- */
async function boot() {
  paintIcons();
  bindGlobal();
  try {
    const data = await api('/api/bootstrap');
    state.csrf = data.csrf;
    state.user = data.user;
    state.guest = data.guest;
    state.routing = data.routing;
    state.quota = data.quota;
    state.providers = data.providers || {};
    state.deploy = data.deploy || {};
    state.runtime = data.runtime;
    state.contextWindow = data.contextWindow || state.contextWindow;
    state.projects = data.projects || [];
    state.prefs = data.prefs || {};
    state.mode = state.prefs.mode || 'default';
    state.model = state.prefs.model || '';
    setConnected(true, 'ready');
    if (data.instance?.mock) {
      const chip = document.createElement('span');
      chip.className = 'chip warn';
      chip.title = 'No outbound model access in this sandbox — the harness is running its built-in demo provider. Add a BYOK key and run the same build with network access for real models.';
      chip.style.marginLeft = '6px';
      chip.textContent = 'demo provider';
      document.querySelector('.chips')?.append(chip);
    }
    renderAuth();
    renderQuota();
    renderProjects();
    renderRuntimeStatus();
    if (state.projects.length) await loadProject(state.projects[0].id);
    else await createProject('My first app', { silent: true });
    loadModels().catch(() => {});
    if (!localStorage.getItem('ac_welcomed')) {
      localStorage.setItem('ac_welcomed', '1');
      renderWelcome();
    }
  } catch (err) {
    setConnected(false, 'connection failed');
    toast(err.message, 'err', 6000);
  }
}

function renderRuntimeStatus() {
  const rt = state.runtime;
  const node = $('#status-runtime');
  if (rt) {
    node.textContent = `node ${rt.node?.version || '?'} · npm ${rt.npm?.version || '?'} · py ${rt.python?.version || '?'}`;
  }
}

function renderAuth() {
  const btn = $('#btn-auth');
  if (state.user) {
    btn.textContent = state.user.email.split('@')[0];
    btn.title = `${state.user.email} — click for account`;
    btn.classList.add('ghost');
  } else {
    btn.textContent = 'Sign in';
    btn.classList.remove('ghost');
  }
}

function renderQuota() {
  const q = state.quota || {};
  const box = $('#quota-box');
  const label = $('#quota-label');
  const bar = $('#quota-bar');
  const hint = $('#quota-hint');
  const chip = $('#chip-quota-txt');
  const chipEl = $('#chip-quota');
  if (q.unlimited || q.limit === null) {
    label.textContent = state.guest ? 'guest · free' : 'unlimited';
    bar.style.width = state.guest ? '18%' : '100%';
    bar.className = '';
    hint.textContent = state.guest ? 'Free forever on the Kilo router. Sign in for 40/day on platform keys.' : 'Bring your own key for unlimited use.';
    chip.textContent = state.guest ? 'free tier' : 'BYOK';
    chipEl.className = 'chip';
    if (box) box.style.display = '';
    return;
  }
  const used = q.used || 0;
  const limit = q.limit || 1;
  const left = Math.max(0, limit - used);
  label.textContent = `${left}/${limit} left`;
  const pct = Math.min(100, (used / limit) * 100);
  bar.style.width = `${Math.max(3, 100 - pct)}%`;
  bar.className = pct > 90 ? 'err' : pct > 70 ? 'warn' : '';
  hint.textContent = `Resets in ${hoursUntilReset()}h · fallback: Free Kilo router`;
  chip.textContent = `${left} left today`;
  chipEl.className = `chip ${pct > 90 ? 'err' : pct > 70 ? 'warn' : ''}`;
}

function hoursUntilReset() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.round((next - now) / 3600000));
}

/* ------------------------------------------------------------ projects ---- */
async function loadProject(id) {
  if (state.projectId && state.projectId !== id) resetTerminal();
  state.projectId = id;
  setView('chat');
  try {
    const data = await api(`/api/projects/${id}`);
    state.project = data.project;
    state.thread = data.activeThread;
    state.messages = data.messages;
    state.files = data.files || [];
    state.dbFiles = data.databases || [];
    state.projectGit = data.git;
    state.projectPins = data.pins || {};
    state.projectDeploy = data.deploy || {};
    state.running = Boolean(data.running);
    $('#project-name').textContent = data.project.name;
    renderProjects();
    renderSessions(data.threads);
    renderTranscript();
    renderFileTree();
    renderDbFiles();
    renderDeploy(data.deployments || []);
    renderGit(data.git);
    document.title = `${data.project.name} — AlphaCode`;
    if (state.running) setRunning(true);
  } catch (err) {
    toast(err.message, 'err');
    state.projects = state.projects.filter((p) => p.id !== id);
    renderProjects();
  }
}

async function createProject(name, { silent = false } = {}) {
  const project = await api('/api/projects', { method: 'POST', body: { name } });
  state.projects.unshift({ id: project.project.id, name: project.project.name, updatedAt: Date.now() });
  renderProjects();
  if (!silent) toast('Project created', 'ok', 2000);
  await loadProject(project.project.id);
  return project;
}

function renderProjects() {
  const host = $('#project-list');
  host.innerHTML = '';
  if (!state.projects.length) {
    host.innerHTML = '<div class="hint" style="padding:10px 6px">No projects yet.</div>';
    return;
  }
  for (const p of state.projects) {
    const row = el('div', { class: `list-item ${p.id === state.projectId ? 'active' : ''}` });
    row.innerHTML = `${icon('folder', 14)}<div class="name">${escapeHtml(p.name)}</div><div class="meta">${timeAgo(p.updatedAt)}</div>
      <button class="icon-btn sm del" title="Delete project">${icon('trash', 13)}</button>`;
    row.onclick = (e) => {
      if (e.target.closest('.del')) return;
      loadProject(p.id);
      closeDrawer();
    };
    row.querySelector('.del').onclick = async () => {
      if (await confirmDialog(`Delete "${p.name}" and its files? This cannot be undone.`, { danger: true, confirmLabel: 'Delete' })) {
        await api(`/api/projects/${p.id}`, { method: 'DELETE' });
        state.projects = state.projects.filter((x) => x.id !== p.id);
        renderProjects();
        if (state.projectId === p.id) {
          if (state.projects.length) await loadProject(state.projects[0].id);
          else await createProject('My first app', { silent: true });
        }
      }
    };
    host.append(row);
  }
}

function renderSessions(threads = []) {
  const host = $('#session-list');
  host.innerHTML = '';
  if (!threads.length) {
    host.innerHTML = '<div class="hint" style="padding:8px 6px">No sessions yet.</div>';
    return;
  }
  for (const t of threads) {
    const row = el('div', { class: `list-item ${state.thread?.id === t.id ? 'active' : ''}` });
    row.innerHTML = `${icon('chat', 14)}<div class="name">${escapeHtml(t.title || 'Session')}</div><div class="meta">${timeAgo(t.updatedAt)}</div>`;
    row.onclick = async () => {
      const data = await api(`/api/projects/${state.projectId}?thread=${t.id}`);
      state.thread = data.activeThread;
      state.messages = data.messages;
      renderTranscript();
      renderSessions(data.threads);
      closeDrawer();
    };
    host.append(row);
  }
}

/* ------------------------------------------------------------ transcript -- */
function renderTranscript() {
  const host = $('#transcript');
  host.innerHTML = '';
  const inner = el('div', { class: 'transcript-inner', id: 'transcript-inner' });
  host.append(inner);
  let lastAssistant = null;
  for (const m of state.messages) {
    if (m.role === 'user') {
      appendUser(m.content?.text || '');
      lastAssistant = null;
    } else if (m.role === 'assistant') {
      if (m.content?.toolCalls?.length) {
        // tool-call-only assistant message: keep a meta line for context
        lastAssistant = null;
      }
      if (m.content?.text?.trim()) {
        lastAssistant = appendAssistantText(m.content.text, { reasoning: m.content.reasoning, model: m.meta?.model });
      }
    } else if (m.role === 'tool') {
      appendToolCard({
        name: m.content?.name || 'tool',
        title: summarizeArgs(m.content?.name, m.content?.toolCallId),
        ok: !m.content?.isError,
        summary: firstLine(m.content?.content),
        output: m.content?.content,
        display: m.content?.display,
        done: true,
      });
    }
  }
  scrollTranscript(true);
  if (!state.messages.length) renderWelcome();
}

function transInner() {
  return $('#transcript-inner') || (() => {
    const inner = el('div', { class: 'transcript-inner', id: 'transcript-inner' });
    $('#transcript').append(inner);
    return inner;
  })();
}

function renderWelcome() {
  const inner = transInner();
  if (inner.querySelector('.welcome')) return;
  const box = el('div', { class: 'welcome msg assistant' });
  const suggestions = [
    'Build a SaaS landing page with pricing and dark mode',
    'Scaffold a REST API with Express, tests and a SQLite schema',
    'Fix the bugs in this project and add a CI workflow',
    'Deploy this project to Cloudflare and give me the URL',
  ];
  box.innerHTML = `
    <div class="msg-meta"><span class="who">α</span><b>AlphaCode</b><span>agent harness</span></div>
    <div class="md">
      <h2 style="margin-top:2px">What are we building?</h2>
      <p>I can read, write and run code in a real shell, edit databases, and deploy to Cloudflare, Netlify or Vercel.</p>
      <div class="suggestions">${suggestions.map((s) => `<button class="chip suggestion">${escapeHtml(s)}</button>`).join('')}</div>
      <p class="small muted">Tip: press <span class="kbd">⌘K</span> for commands, <span class="kbd">⇧Tab</span> to change mode, <span class="kbd">/</span> for slash commands.</p>
    </div>`;
  inner.append(box);
  box.querySelectorAll('.suggestion').forEach((btn) => {
    btn.onclick = () => {
      $('#prompt').value = btn.textContent;
      autoGrow();
      $('#prompt').focus();
    };
  });
  paintIcons(box);
}

function clearWelcome() {
  $$('.welcome').forEach((n) => n.remove());
}

function scrollTranscript(force = false) {
  const host = $('#transcript');
  if (!host) return;
  const near = host.scrollHeight - host.scrollTop - host.clientHeight < 160;
  if (force || near) host.scrollTop = host.scrollHeight;
}

function appendUser(text) {
  clearWelcome();
  const wrap = el('div', { class: 'msg user' });
  wrap.append(el('div', { class: 'bubble', text }));
  transInner().append(wrap);
  scrollTranscript();
}

function appendAssistantText(text = '', { reasoning = '', model = '' } = {}) {
  const wrap = el('div', { class: 'msg assistant' });
  const meta = el('div', { class: 'msg-meta' });
  meta.innerHTML = `<span class="who">α</span><b>AlphaCode</b>${model ? `<span>· ${escapeHtml(model.split('/').pop())}</span>` : ''}`;
  wrap.append(meta);
  if (reasoning) {
    const details = el('details', { class: 'thinking' });
    details.innerHTML = `<summary>thinking · ${reasoning.length} chars</summary>${escapeHtml(reasoning)}`;
    wrap.append(details);
  }
  const body = el('div', { class: 'md body' });
  body.innerHTML = md(text || '');
  wrap.append(body);
  transInner().append(wrap);
  scrollTranscript();
  return { wrap, body };
}

function ensureTurn() {
  if (state.turn?.wrap?.isConnected) return state.turn;
  const wrap = el('div', { class: 'msg assistant' });
  const meta = el('div', { class: 'msg-meta' });
  meta.innerHTML = `<span class="who">α</span><b>AlphaCode</b><span class="turn-model"></span><span class="spin" hidden></span>`;
  const thinking = el('details', { class: 'thinking', hidden: true });
  thinking.innerHTML = '<summary>thinking</summary><div class="think-body"></div>';
  const body = el('div', { class: 'md body' });
  const tools = el('div', { class: 'turn-tools' });
  tools.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:8px';
  wrap.append(meta, thinking, body, tools);
  transInner().append(wrap);
  state.turn = { wrap, meta, body, tools, thinking, text: '', reasoning: '', rendered: '', model: '' };
  clearWelcome();
  scrollTranscript();
  return state.turn;
}

function updateTurnText(delta) {
  const turn = ensureTurn();
  turn.text += delta;
  if (turn.text.length - turn.rendered.length > 24 || turn.text.length < turn.rendered.length) {
    turn.body.innerHTML = md(turn.text);
    turn.rendered = turn.text;
    scrollTranscript();
  }
  scheduleTurnFlush();
}

let turnFlushTimer = null;
function scheduleTurnFlush() {
  if (turnFlushTimer) return;
  turnFlushTimer = setTimeout(() => {
    turnFlushTimer = null;
    if (state.turn && state.turn.text !== state.turn.rendered) {
      state.turn.body.innerHTML = md(state.turn.text);
      state.turn.rendered = state.turn.text;
      scrollTranscript();
    }
  }, 140);
}

function updateTurnReasoning(delta) {
  const turn = ensureTurn();
  turn.reasoning += delta;
  turn.thinking.hidden = false;
  turn.thinking.querySelector('summary').textContent = `thinking · ${turn.reasoning.length} chars`;
  const body = turn.thinking.querySelector('.think-body');
  body.textContent = turn.reasoning.slice(-4000);
  if (turn.thinking.open) body.scrollTop = body.scrollHeight;
}

function appendToolCard({ name, title, args, ok = null, summary = '', output = '', display = null, done = false }) {
  const tools = state.turn?.tools || transInner();
  const card = el('div', { class: `tool-card ${done ? '' : 'running'}` });
  const head = el('div', { class: 'tool-head' });
  head.innerHTML = `<div class="tool-ico">${icon(toolIcon(name), 12)}</div><div class="tool-name">${escapeHtml(name)}</div>
    <div class="tool-title">${escapeHtml(title || '')}</div><div class="grow"></div>
    <div class="tool-status">${done ? (ok ? `<span class="tool-ok">✓</span>` : `<span class="tool-fail">✕</span>`) : '<span class="spin"></span>'}</div>`;
  const body = el('div', { class: 'tool-body' });
  const out = el('pre', { class: 'tool-out' });
  if (output) out.textContent = output;
  body.append(out);
  card.append(head, body);
  head.onclick = () => card.classList.toggle('open');
  tools.append(card);
  scrollTranscript();
  return { card, head, body, out, setOutput: (text) => (out.textContent = text), appendOutput: (text) => (out.textContent += text) };
}

function finishToolCard(handle, { ok, summary, display, name, args, output }) {
  if (!handle) return;
  handle.card.classList.remove('running');
  const status = handle.head.querySelector('.tool-status');
  status.innerHTML = ok ? '<span class="tool-ok">✓</span>' : '<span class="tool-fail">✕</span>';
  if (summary) handle.head.querySelector('.tool-title').textContent = summary;
  const body = handle.body;
  body.innerHTML = '';
  if (display?.kind === 'diff' && display.diff) {
    body.innerHTML = renderDiff(display.diff);
  } else if (display?.kind === 'db_rows' && display.rows) {
    body.innerHTML = renderTable(display.columns, display.rows);
  } else if (display?.kind === 'todos' && display.todos) {
    body.innerHTML = renderTodos(display.todos);
    renderTodosInline(display.todos);
  } else if (display?.kind === 'deploy' && display.url) {
    body.innerHTML = deployResultHtml(display);
  } else if (display?.kind === 'plan' && display.plan) {
    body.innerHTML = `<div class="plan-card"><h4>Plan</h4><div class="md">${md(display.plan)}</div></div>`;
  } else if (output) {
    const pre = el('pre', { class: 'tool-out', text: output });
    body.append(pre);
  } else if (name === 'bash' && args?.command) {
    const pre = el('pre', { class: 'tool-out', text: `$ ${args.command}` });
    body.append(pre);
  }
  if (ok === false) handle.card.classList.add('failed');
  if (!body.innerHTML.trim() && !body.childNodes.length) {
    body.innerHTML = `<div class="small muted">${escapeHtml(summary || 'done')}</div>`;
  }
  scrollTranscript();
}

function renderTable(columns, rows) {
  if (!rows?.length) return '<div class="db-empty">No rows</div>';
  const cols = columns?.length ? columns : Object.keys(rows[0]);
  return `<div style="overflow:auto;max-height:320px"><table class="db-grid"><thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((r) => `<tr>${cols.map((c) => `<td>${r[c] === null ? '<span class="db-null">NULL</span>' : escapeHtml(String(r[c]).slice(0, 120))}</td>`).join('')}</tr>`).join('')}
  </tbody></table></div>`;
}

function renderTodos(todos) {
  return `<div class="todo-list">${todos
    .map(
      (t) =>
        `<div class="todo ${t.status}"><span class="box">${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '•' : ''}</span><span>${escapeHtml(t.content)}</span></div>`,
    )
    .join('')}</div>`;
}

function renderTodosInline(todos) {
  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos.find((t) => t.status === 'in_progress') || todos.find((t) => t.status === 'pending');
  $('#status-text').textContent = `todos ${done}/${todos.length}${active ? ' · ' + active.content.slice(0, 48) : ''}`;
}

function deployResultHtml(display) {
  return `<div style="display:flex;flex-direction:column;gap:8px">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span class="tag ok">live</span>
      <a href="${escapeHtml(display.url)}" target="_blank" rel="noopener noreferrer" class="mono">${escapeHtml(display.url)}</a>
      <button class="btn sm" data-copy="${escapeHtml(display.url)}">Copy</button>
      ${display.claimUrl ? `<a class="btn sm" href="${escapeHtml(display.claimUrl)}" target="_blank" rel="noopener noreferrer">Claim URL</a>` : ''}
    </div>
    ${display.claimable ? `<div class="hint">Unclaimed preview — the user must claim it to keep the app. Expires ${timeAgo(display.expiresAt) === 'just now' ? 'in 7 days' : new Date(display.expiresAt).toLocaleString()}.</div>` : ''}
    <div class="hint">${display.files || 0} files · ${escapeHtml(display.framework || 'static')}${display.provider ? ' · ' + escapeHtml(display.provider) : ''}</div>
  </div>`;
}

function appendNotice(text, level = 'info') {
  const inner = state.turn?.tools || transInner();
  const node = el('div', { class: `notice ${level}` });
  node.innerHTML = `${icon(level === 'err' ? 'alert' : level === 'warn' ? 'alert' : 'wifi', 13)}<span>${escapeHtml(text)}</span>`;
  inner.append(node);
  scrollTranscript();
}

function appendPlan(plan) {
  const inner = state.turn?.tools || transInner();
  const node = el('div', { class: 'plan-card' });
  node.innerHTML = `<h4>Proposed plan</h4><div class="md">${md(plan)}</div>
    <div class="perm-actions"><button class="btn sm primary" data-action="approve-plan">Approve &amp; execute</button><button class="btn sm" data-action="dismiss-plan">Keep planning</button></div>`;
  inner.append(node);
  node.querySelector('[data-action="approve-plan"]').onclick = () => {
    setMode('acceptEdits');
    toast('Plan approved — send a message to start executing', 'ok');
    $('#prompt').focus();
  };
  node.querySelector('[data-action="dismiss-plan"]').onclick = () => node.remove();
  $('#pill-plan').hidden = false;
}

function appendPermission(request) {
  const inner = state.turn?.tools || transInner();
  const node = el('div', { class: 'perm-card' });
  node.innerHTML = `<h4>Permission required</h4>
    <div>${escapeHtml(request.title || request.kind || 'Tool action')}</div>
    ${request.command ? `<div class="perm-cmd">${escapeHtml(request.command)}</div>` : ''}
    ${request.risks?.length ? `<div class="hint">Why: ${escapeHtml(request.risks.join('; '))}</div>` : ''}
    <div class="perm-actions"><button class="btn sm primary" data-allow="1">Allow once</button><button class="btn sm danger" data-deny="1">Deny</button></div>`;
  inner.append(node);
  node.querySelector('[data-allow]').onclick = async () => {
    await api(`/api/runs/${state.runId}/permission`, { method: 'POST', body: { requestId: request.requestId, approved: true } });
    node.querySelector('.perm-actions').innerHTML = '<span class="badge ok">approved</span>';
  };
  node.querySelector('[data-deny]').onclick = async () => {
    await api(`/api/runs/${state.runId}/permission`, { method: 'POST', body: { requestId: request.requestId, approved: false } });
    node.querySelector('.perm-actions').innerHTML = '<span class="badge err">denied</span>';
  };
  scrollTranscript();
}

/* ------------------------------------------------------------------ run --- */
async function sendMessage(text) {
  if (!text.trim() || state.running) return;
  const attachments = state.attachments;
  state.attachments = [];
  renderAttachments();
  clearWelcome();
  appendUser(text + (attachments.length ? `\n\n[attached: ${attachments.map((a) => a.name).join(', ')}]` : ''));
  $('#prompt').value = '';
  autoGrow();
  setRunning(true);
  state.turn = null;
  state.buffers = {};
  ensureTurn();
  try {
    const res = await api(`/api/projects/${state.projectId}/chat`, {
      method: 'POST',
      body: { text, model: state.model, mode: state.mode, threadId: state.thread?.id, attachments },
    });
    state.runId = res.runId;
    state.thread = { ...(state.thread || {}), id: res.threadId };
    attachRun(res.runId);
  } catch (err) {
    setRunning(false);
    if (err.code === 'daily_limit') {
      appendNotice(err.message, 'warn');
      openAuth('signin');
    } else if (err.code === 'run_in_progress') {
      appendNotice('A run is already in progress for this session.', 'warn');
    } else {
      appendNotice(err.message, 'err');
    }
  }
}

function attachRun(runId) {
  if (state.source) state.source.close();
  const es = new EventSource(`/api/runs/${runId}/stream`);
  state.source = es;
  es.addEventListener('event', (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleRunEvent(data);
  });
  es.addEventListener('state', () => {
    if (state.running) setRunning(false);
  });
  es.onerror = () => {
    if (state.running) {
      setRunning(false);
      appendNotice('Stream closed. Reload the project to see the full transcript.', 'warn');
    }
    es.close();
  };
}

function handleRunEvent(ev) {
  switch (ev.type) {
    case 'start':
      break;
    case 'model': {
      const turn = ensureTurn();
      turn.model = ev.model;
      const label = `${ev.model.split('/').pop()}`;
      turn.meta.querySelector('.turn-model').textContent = `· ${label}${ev.via === 'byok' ? ' · BYOK' : ev.via === 'guest' ? ' · free' : ''}`;
      $('#status-model').textContent = `${ev.provider}/${ev.model}`;
      $('#pill-model-txt').textContent = ev.model.split('/').pop();
      break;
    }
    case 'text':
      updateTurnText(ev.text);
      break;
    case 'text_done':
      if (state.turn && state.turn.text.trim()) {
        state.turn.body.innerHTML = md(state.turn.text);
        state.turn.rendered = state.turn.text;
      }
      break;
    case 'reasoning':
      updateTurnReasoning(ev.text);
      break;
    case 'tool_start': {
      const turn = ensureTurn();
      const handle = appendToolCard({ name: ev.name, title: ev.title, args: ev.args });
      turn.tools.append(handle.card);
      state.buffers[ev.toolCallId] = handle;
      state.activeToolId = ev.toolCallId;
      break;
    }
    case 'tool_output': {
      const handle = state.buffers[state.activeToolId] || Object.values(state.buffers).pop();
      if (handle) handle.appendOutput(ev.text);
      break;
    }
    case 'tool_end': {
      const handle = state.buffers[ev.toolCallId];
      finishToolCard(handle, { ok: ev.ok, summary: ev.summary, display: ev.display, name: ev.name, output: null });
      delete state.buffers[ev.toolCallId];
      if (state.activeToolId === ev.toolCallId) state.activeToolId = '';
      break;
    }
    case 'todos':
      renderTodosInline(ev.todos);
      break;
    case 'plan':
      appendPlan(ev.plan);
      break;
    case 'permission':
    case 'permission_pending':
      appendPermission(ev);
      break;
    case 'permission_timeout':
      appendNotice('Permission request timed out — the action was denied.', 'warn');
      break;
    case 'notice':
      appendNotice(ev.text, ev.level === 'warn' ? 'warn' : 'info');
      break;
    case 'provider_error':
      break;
    case 'usage': {
      const used = ev.usage?.input || 0;
      const window = ev.usage?.contextWindow || state.contextWindow || 200000;
      const ctxPct = Math.max(0, Math.min(100, Math.round((used / window) * 100)));
      const meter = $('#ctx-meter');
      meter.textContent = `${ctxPct}%`;
      meter.title = `${used.toLocaleString()} of ${window.toLocaleString()} context tokens`;
      meter.classList.toggle('hot', ctxPct >= 80);
      break;
    }
    case 'compaction':
      appendNotice(`Compacted ${ev.dropped} earlier messages to free context.`, 'info');
      break;
    case 'deploy_progress': {
      const handle = state.buffers[state.activeToolId] || Object.values(state.buffers).pop();
      if (handle) handle.appendOutput(ev.text + '\n');
      else appendNotice(ev.text, 'info');
      break;
    }
    case 'subagent_start':
      appendNotice(`Subagent (${ev.subagent || 'general'}): ${ev.description}`, 'info');
      break;
    case 'reasoning_done':
      if (state.turn?.reasoning) state.turn.reasoning.dataset.done = '1';
      break;
    case 'subagent_end':
      appendNotice(`Subagent finished: ${ev.description || 'task'} (${ev.steps || 0} steps)`, 'info');
      break;
    case 'subagent_error':
      appendNotice(`Subagent failed: ${ev.message || 'unknown error'}`, 'warn');
      break;
    case 'done': {
      setRunning(false);
      if (state.turn) {
        if (!state.turn.text.trim() && !state.turn.tools.childNodes.length) {
          state.turn.body.innerHTML = '<p class="muted">No output.</p>';
        }
        const stats = el('div', { class: 'small muted' });
        stats.style.cssText = 'margin-top:8px;font-family:var(--mono);font-size:10.5px';
        const u = ev.usage || {};
        stats.textContent = `${ev.steps || 0} steps · ${u.calls || 0} model calls · ${(u.input || 0).toLocaleString()} in / ${(u.output || 0).toLocaleString()} out tokens${ev.filesChanged?.length ? ` · ${ev.filesChanged.length} files touched` : ''}${ev.finishReason === 'max_iterations' ? ' · step limit reached' : ''}`;
        state.turn.wrap.append(stats);
        state.turn.meta.querySelector('.spin')?.setAttribute('hidden', '');
      }
      if (ev.quota) {
        state.quota = ev.quota;
        renderQuota();
      }
      refreshProjectQuiet();
      break;
    }
    case 'error':
      setRunning(false);
      appendNotice(ev.message, 'err');
      break;
    default:
      break;
  }
  scrollTranscript();
}

function setRunning(running) {
  state.running = running;
  $('#btn-send').hidden = running;
  $('#btn-stop').hidden = !running;
  $('#composer').classList.toggle('disabled', false);
  const status = $('#status-text');
  if (running) {
    status.textContent = 'agent working…';
    $('#status-dot').className = 'dot live';
  } else {
    $('#status-dot').className = 'dot ok';
    status.textContent = 'ready';
  }
}

async function stopRun() {
  if (!state.runId) return;
  await api(`/api/runs/${state.runId}/stop`, { method: 'POST' }).catch(() => {});
  setRunning(false);
  toast('Stopped', '', 1500);
}

async function refreshProjectQuiet() {
  try {
    const data = await api(`/api/projects/${state.projectId}`);
    state.files = data.files || [];
    state.messages = data.messages;
    state.dbFiles = data.databases || [];
    state.projectDeploy = data.deploy || {};
    state.deploy = { ...state.deploy, ...(data.deploy || {}) };
    renderFileTree();
    renderDbFiles();
    renderSessions(data.threads);
    if (state.view === 'deploy') renderDeploy(data.deployments);
    if (state.view === 'files') renderGit(data.git);
  } catch {}
}

/* ---------------------------------------------------------------- models -- */
async function loadModels(force = false) {
  if (state.models.length && !force) return state.models;
  const data = await api('/api/models');
  state.models = data.providers || [];
  if (!state.model) {
    const first = state.models.find((p) => p.available && p.models.length);
    state.model = first?.models[0]?.ref || data.routing?.defaultModel || '';
    $('#pill-model-txt').textContent = state.model ? state.model.split('/').pop() : 'auto';
  }
  return state.models;
}

function openModelPicker() {
  loadModels(true)
    .then((providers) => {
      const list = el('div', { class: 'model-list' });
      const render = () => {
        list.innerHTML = '';
        if (!providers.length) {
          list.innerHTML = '<div class="hint">No providers configured. Add a BYOK key in Settings.</div>';
          return;
        }
        for (const p of providers) {
          const group = el('div', { class: 'model-group' });
          group.textContent = `${p.label}${p.byok ? ' · your key' : p.free ? ' · free' : ''}${p.available ? '' : ' · unavailable'}`;
          list.append(group);
          if (!p.available) {
            list.append(el('div', { class: 'hint', style: 'padding:2px 8px 6px' }, p.reason || 'Not configured'));
            continue;
          }
          for (const m of p.models.slice(0, 80)) {
            const row = el('div', { class: `model-row ${state.model === m.ref ? 'active' : ''}` });
            row.innerHTML = `<span class="dot ${m.free ? 'ok' : ''}"></span><div class="id">${escapeHtml(m.id)}</div><div class="grow"></div>${m.context ? `<span class="badge">${Math.round(m.context / 1000)}k</span>` : ''}`;
            row.onclick = () => {
              state.model = m.ref;
              $('#pill-model-txt').textContent = m.id.split('/').pop();
              $('#status-model').textContent = m.ref;
              savePrefs({ model: m.ref });
              m.close();
              toast(`Model: ${m.ref}`, 'ok', 1800);
            };
            list.append(row);
          }
        }
      };
      render();
      const footer = el('div', { style: 'display:flex;gap:8px;align-items:center' });
      const refresh = el('button', { class: 'btn sm', text: 'Refresh catalogue' });
      refresh.onclick = async () => {
        providers = await loadModels(true);
        render();
      };
      const note = el('span', { class: 'hint', text: 'Free models only for platform keys' });
      footer.append(refresh, note);
      const m = modal({ title: 'Choose a model', body: list, footer, wide: true });
    })
    .catch((err) => toast(err.message, 'err'));
}

/* -------------------------------------------------------------- settings -- */
function openSettings() {
  const body = el('div', { class: 'settings-inner' });
  body.innerHTML = '<div class="hint">Loading…</div>';
  const m = modal({ title: 'Settings', body, wide: true });
  api('/api/settings')
    .then((s) => renderSettings(body, s))
    .catch((err) => (body.innerHTML = `<div class="perm-card">${escapeHtml(err.message)}</div>`));
}

function renderSettings(body, s) {
  const providers = s.providers || {};
  const deploy = s.deploy || {};
  const byokRows = Object.entries(providers)
    .filter(([, p]) => p.byokAllowed !== false)
    .map(([id, p]) => {
      const connected = p.byok;
      return `<div class="field">
        <label>${escapeHtml(p.label)} ${connected ? `<span class="badge ok">key set ${escapeHtml(p.keyMask || '')}</span>` : p.platformConfigured ? '<span class="badge info">platform key</span>' : '<span class="badge">not set</span>'}</label>
        <div class="row">
          <input type="password" data-byok-key="${id}" placeholder="${connected ? 'replace key…' : 'paste API key'}" autocomplete="off">
          <button class="btn sm" data-byok-save="${id}">Save</button>
          ${connected ? `<button class="btn sm danger" data-byok-clear="${id}">Remove</button>` : ''}
        </div>
        <div class="row">
          <input type="text" data-byok-model="${id}" placeholder="default model id (optional)" value="${escapeHtml(p.model || '')}">
          <input type="text" data-byok-base="${id}" placeholder="base URL override (optional)" value="${escapeHtml(p.baseUrl || '')}">
        </div>
        <div class="hint">${escapeHtml(p.docs || '')}</div>
      </div>`;
    })
    .join('');

  const deployRows = ['cloudflare', 'netlify', 'vercel']
    .map((p) => {
      const d = deploy[p] || {};
      const tokens = (s.deployTokens || {})[p] || {};
      return `<div class="field">
        <label>${p[0].toUpperCase() + p.slice(1)} ${d.connected ? `<span class="badge ok">connected (${escapeHtml(d.source)})</span>` : '<span class="badge">no token</span>'}</label>
        <div class="row"><input type="password" data-deploy-token="${p}" placeholder="${d.connected ? 'replace token…' : 'API token'}" autocomplete="off">
        <button class="btn sm" data-deploy-save="${p}">Save</button></div>
        ${p === 'cloudflare' ? `<input type="text" data-deploy-account="${p}" placeholder="Cloudflare account id" value="${escapeHtml(tokens.accountId || '')}">` : ''}
        ${p === 'vercel' ? `<input type="text" data-deploy-team="${p}" placeholder="Vercel team id (optional)" value="${escapeHtml(tokens.teamId || '')}">` : ''}
        <div class="hint">Without a token, deployments become claimable preview URLs.</div>
      </div>`;
    })
    .join('');

  const rt = state.runtime || {};
  body.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>Account</h3><div class="grow"></div>${state.user ? `<span class="badge ok">${escapeHtml(state.user.email)}</span>` : '<span class="badge warn">guest</span>'}</div>
      <div class="card-b">
        <div class="kv"><span>Tier</span><b>${state.guest ? 'Guest — free Kilo router' : 'Signed in'}</b></div>
        <div class="kv"><span>Daily allowance</span><b>${state.quota?.unlimited ? 'unlimited (BYOK)' : `${state.quota?.used || 0}/${state.quota?.limit || 40} used`}</b></div>
        <div class="kv"><span>Routing</span><b>${(state.routing?.chain || []).join(' → ') || 'kilo'}</b></div>
        <div class="row" style="display:flex;gap:8px">
          ${state.user ? '<button class="btn sm" id="set-logout">Sign out</button>' : '<button class="btn sm primary" id="set-signin">Sign in</button>'}
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h3>Model providers (BYOK)</h3><p>Bring your own key — unlimited, never counted against the daily limit.</p></div>
      <div class="card-b" id="byok-fields">${byokRows || '<div class="hint">No providers available.</div>'}</div>
    </div>
    <div class="card">
      <div class="card-h"><h3>Deploy tokens</h3><p>Encrypted at rest. Add a token to publish straight to your account.</p></div>
      <div class="card-b" id="deploy-fields">${deployRows}</div>
    </div>
    <div class="card">
      <div class="card-h"><h3>Runtime</h3><p>Node, npm, Python and tooling detected on this instance.</p></div>
      <div class="card-b">
        <div class="kv"><span>Node.js</span><b>${escapeHtml(rt.node?.version || '?')} ${rt.node?.latest ? `<span class="badge ${rt.node.upToDate ? 'ok' : 'warn'}">${rt.node.upToDate ? 'latest' : 'latest ' + escapeHtml(rt.node.latest)}</span>` : ''}</b></div>
        <div class="kv"><span>npm</span><b>${escapeHtml(rt.npm?.version || '?')} ${rt.npm?.latest ? `<span class="badge ${rt.npm.upToDate ? 'ok' : 'warn'}">${rt.npm.upToDate ? 'latest' : 'latest ' + escapeHtml(rt.npm.latest)}</span>` : ''}</b></div>
        <div class="kv"><span>Python</span><b>${escapeHtml(rt.python?.version || '?')}${rt.python?.uv ? ' · uv' : ''}</b></div>
        <div class="kv"><span>Tools</span><b>${Object.entries(rt.tools || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || '—'}</b></div>
        <div class="row" style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm" id="rt-refresh">Re-detect</button>
          <button class="btn sm" id="rt-node">Install latest Node</button>
          <button class="btn sm" id="rt-npm">Update npm</button>
        </div>
        <div id="rt-log" class="deploy-log" style="display:none"></div>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h3>Security</h3></div>
      <div class="card-b">
        <div class="kv"><span>Keys at rest</span><b>AES-256-GCM</b></div>
        <div class="kv"><span>Passwords</span><b>scrypt (N=16384)</b></div>
        <div class="kv"><span>Sessions</span><b>HttpOnly · SameSite=Lax · CSRF</b></div>
        <div class="kv"><span>Workspace</span><b>path-sandboxed + git checkpoints</b></div>
        <div class="kv"><span>Preview content</span><b>CSP sandbox (opaque origin)</b></div>
      </div>
    </div>`;

  body.querySelector('#set-logout')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.reload();
  });
  body.querySelector('#set-signin')?.addEventListener('click', () => openAuth('signin'));

  body.querySelectorAll('[data-byok-save]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.byokSave;
      const key = body.querySelector(`[data-byok-key="${id}"]`).value.trim();
      const model = body.querySelector(`[data-byok-model="${id}"]`).value.trim();
      const baseUrl = body.querySelector(`[data-byok-base="${id}"]`).value.trim();
      if (!key) return toast('Paste a key first', 'warn');
      try {
        const res = await api('/api/settings', { method: 'PUT', body: { byok: { [id]: { key, model, baseUrl } } } });
        toast(`${id} key saved`, 'ok');
        state.providers = res.providers;
        await loadModels(true);
        renderSettings(body, await api('/api/settings'));
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  });
  body.querySelectorAll('[data-byok-clear]').forEach((btn) => {
    btn.onclick = async () => {
      await api('/api/settings', { method: 'PUT', body: { byok: { [btn.dataset.byokClear]: null } } });
      toast('Key removed', 'ok');
      renderSettings(body, await api('/api/settings'));
    };
  });
  body.querySelectorAll('[data-deploy-save]').forEach((btn) => {
    btn.onclick = async () => {
      const p = btn.dataset.deploySave;
      const token = body.querySelector(`[data-deploy-token="${p}"]`).value.trim();
      const accountId = body.querySelector(`[data-deploy-account="${p}"]`)?.value.trim() || '';
      const teamId = body.querySelector(`[data-deploy-team="${p}"]`)?.value.trim() || '';
      try {
        const res = await api('/api/settings', { method: 'PUT', body: { deployTokens: { [p]: { token, accountId, teamId } } } });
        state.deploy = res.deploy;
        toast(`${p} token saved`, 'ok');
        renderSettings(body, await api('/api/settings'));
        renderDeployTargets();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  });
  body.querySelector('#rt-refresh')?.addEventListener('click', async () => {
    const res = await api('/api/runtime?refresh=1');
    state.runtime = res.runtime;
    renderRuntimeStatus();
    toast('Runtime re-detected', 'ok');
    renderSettings(body, await api('/api/settings'));
  });
  const installRuntime = async (kind) => {
    const log = body.querySelector('#rt-log');
    log.style.display = '';
    log.textContent = `Installing ${kind}…\n`;
    try {
      const res = await api('/api/runtime/install', { method: 'POST', body: { kind } });
      log.textContent += (res.logs || []).join('\n') + '\n✔ done';
      toast(`${kind} installed`, 'ok');
    } catch (err) {
      log.textContent += `\n✕ ${err.message}`;
      toast(err.message, 'err', 6000);
    }
  };
  body.querySelector('#rt-node')?.addEventListener('click', () => installRuntime('node'));
  body.querySelector('#rt-npm')?.addEventListener('click', () => installRuntime('npm'));
}

async function savePrefs(patch) {
  state.prefs = { ...state.prefs, ...patch };
  try {
    await api('/api/settings', { method: 'PUT', body: { prefs: patch } });
  } catch {}
}

/* ------------------------------------------------------------------ auth -- */
function openAuth(mode = 'signin') {
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
  body.innerHTML = `
    <div class="auth-tabs"><button data-mode="signin" class="${mode === 'signin' ? 'active' : ''}">Sign in</button><button data-mode="signup" class="${mode === 'signup' ? 'active' : ''}">Create account</button></div>
    <form id="auth-form" style="display:flex;flex-direction:column;gap:10px">
      <div class="field"><label>Email</label><input type="email" id="auth-email" required autocomplete="email"></div>
      <div class="field"><label>Password</label><input type="password" id="auth-password" required minlength="8" autocomplete="current-password"></div>
      <div class="hint">Signing in gives you 40 agent requests per day on platform keys (OpenRouter → OpenCode → Google AI Studio), then the free Kilo router. Your guest projects move with you.</div>
      <button class="btn primary" type="submit" id="auth-submit">Sign in</button>
    </form>
    <div style="text-align:center" class="hint">or <a href="#" id="auth-guest">continue as guest</a> — free forever on Kilo</div>`;
  const m = modal({ title: 'AlphaCode account', body });
  let currentMode = mode;
  body.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.onclick = () => {
      currentMode = btn.dataset.mode;
      body.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
      body.querySelector('#auth-submit').textContent = currentMode === 'signup' ? 'Create account' : 'Sign in';
      body.querySelector('#auth-password').autocomplete = currentMode === 'signup' ? 'new-password' : 'current-password';
    };
  });
  body.querySelector('#auth-guest').onclick = (e) => {
    e.preventDefault();
    m.close();
    toast('Browsing as guest — free Kilo router, no sign-in needed', '', 3000);
  };
  body.querySelector('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const email = body.querySelector('#auth-email').value.trim();
    const password = body.querySelector('#auth-password').value;
    try {
      await api(currentMode === 'signup' ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: { email, password } });
      toast(currentMode === 'signup' ? 'Account created' : 'Signed in', 'ok');
      m.close();
      await rebootstrap();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  setTimeout(() => body.querySelector('#auth-email')?.focus(), 60);
}

async function rebootstrap() {
  const data = await api('/api/bootstrap');
  state.user = data.user;
  state.guest = data.guest;
  state.csrf = data.csrf;
  state.quota = data.quota;
  state.routing = data.routing;
  state.providers = data.providers || {};
  state.projects = data.projects || [];
  renderAuth();
  renderQuota();
  renderProjects();
  if (state.projects.length) await loadProject(state.projects[0].id);
}

/* ----------------------------------------------------------------- files -- */
function renderFileTree() {
  const host = $('#file-tree');
  host.innerHTML = '';
  const files = state.files || [];
  if (!files.length) {
    host.innerHTML = '<div class="hint" style="padding:10px">No files yet. Ask the agent to build something.</div>';
    return;
  }
  const tree = buildTree(files);
  renderNodes(tree, host, 0);
}

function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push(f);
  }
  return root;
}

function renderNodes(node, host, depth) {
  for (const [name, child] of node.dirs) {
    const path = childPath(node, name);
    const row = el('div', { class: 'tree-row' });
    row.style.paddingLeft = `${6 + depth * 12}px`;
    row.innerHTML = `<span class="chev">${state.openDirs.has(name) ? '▾' : '▸'}</span>${icon('folder', 13)}<span class="nm">${escapeHtml(name)}</span>`;
    row.onclick = () => {
      if (state.openDirs.has(name)) state.openDirs.delete(name);
      else state.openDirs.add(name);
      renderFileTree();
    };
    host.append(row);
    if (state.openDirs.has(name)) renderNodes(child, host, depth + 1);
  }
  for (const f of node.files) {
    const row = el('div', { class: `tree-row ${state.editorPath === f.path ? 'active' : ''}` });
    row.style.paddingLeft = `${6 + depth * 12 + 14}px`;
    row.innerHTML = `${icon('file', 13)}<span class="nm">${escapeHtml(f.name)}</span>${f.size ? `<span class="sz">${bytes(f.size)}</span>` : ''}`;
    row.onclick = () => openFile(f.path);
    host.append(row);
  }
}

function childPath() {
  return '';
}

let openFileSeq = 0;
async function openFile(path) {
  const seq = ++openFileSeq;
  try {
    const data = await api(`/api/projects/${state.projectId}/file?path=${encodeURIComponent(path)}`);
    if (seq !== openFileSeq) return;
    state.editorPath = path;
    state.editorDirty = false;
    $('#editor-path').textContent = data.path;
    $('#editor-meta').textContent = `${data.content.split('\n').length} lines · ${bytes(data.size)}`;
    const editor = $('#editor');
    editor.value = data.content;
    editor.disabled = false;
    $('#btn-save-file').disabled = true;
    renderFileTree();
    if (window.innerWidth <= 760) $('#tree-pane').classList.add('hide');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function saveFile() {
  if (!state.editorPath) return;
  const content = $('#editor').value;
  try {
    await api(`/api/projects/${state.projectId}/file`, { method: 'PUT', body: { path: state.editorPath, content } });
    state.editorDirty = false;
    $('#btn-save-file').disabled = true;
    toast('Saved', 'ok', 1400);
    const data = await api(`/api/projects/${state.projectId}/files`);
    state.files = data.files;
    renderFileTree();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function runSearch() {
  const q = $('#search-input').value.trim();
  if (!q) return;
  try {
    const data = await api(`/api/projects/${state.projectId}/search?q=${encodeURIComponent(q)}`);
    const host = $('#search-results');
    host.innerHTML = '';
    if (!data.results.length) {
      host.innerHTML = '<div class="hint" style="padding:12px">No matches.</div>';
      return;
    }
    for (const r of data.results) {
      const hit = el('div', { class: 'search-hit' });
      hit.innerHTML = `<b>${escapeHtml(r.path)}:${r.line}</b>\n${escapeHtml(r.text.trim().slice(0, 200))}`;
      hit.onclick = () => {
        showPane('editor');
        openFile(r.path);
      };
      host.append(hit);
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

function renderGit(git) {
  if (!git) return;
  const status = $('#git-status');
  if (status) {
    status.textContent = git.branch ? `branch ${git.branch} · ${git.changes?.length || 0} changed` : 'git not initialised';
  }
  const host = $('#git-log');
  if (!host) return;
  host.innerHTML = '';
  for (const c of git.log || []) {
    const row = el('div', { class: 'git-item' });
    row.innerHTML = `<code>${escapeHtml(c.sha)}</code><div class="grow">${escapeHtml(c.subject)}</div><span class="small muted">${escapeHtml(c.when)}</span>
      <button class="btn sm" data-sha="${escapeHtml(c.sha)}">Restore</button>`;
    row.querySelector('button').onclick = async () => {
      if (!(await confirmDialog(`Restore the workspace to ${c.sha}? Uncommitted changes are lost.`, { danger: true, confirmLabel: 'Restore' }))) return;
      await api(`/api/projects/${state.projectId}/git/rewind`, { method: 'POST', body: { sha: c.sha } });
      toast('Workspace restored', 'ok');
      await refreshProjectQuiet();
    };
    host.append(row);
  }
  if (!(git.log || []).length) host.innerHTML = '<div class="hint">No checkpoints yet.</div>';
}

/* -------------------------------------------------------------- terminal -- */
async function ensureTerminal() {
  if (state.termView) {
    state.termView.fit();
    state.termView.focus();
    return;
  }
  const node = $('#terminal');
  state.termView = new TerminalView(node, {
    cols: 100,
    rows: 30,
    onInput: (data) => sendTerminal(data),
    onResize: (cols, rows) => {
      if (state.termId) api(`/api/terminal/${state.termId}/resize`, { method: 'POST', body: { cols, rows } }).catch(() => {});
    },
    onBell: () => {},
  });
  $('#term-status').textContent = 'connecting…';
  try {
    const { cols, rows } = state.termView.measure();
    const res = await api(`/api/projects/${state.projectId}/terminal`, { method: 'POST', body: { cols, rows } });
    state.termId = res.terminal.id;
    $('#term-status').textContent = `${res.terminal.backend} · ${cols}×${rows}`;
    attachTerminal(res.terminal.id);
  } catch (err) {
    $('#term-status').textContent = 'unavailable';
    state.termView.write(`\r\n\x1b[31m${err.message}\x1b[0m\r\n`);
  }
}

function attachTerminal(id) {
  if (state.termSource) state.termSource.close();
  const es = new EventSource(`/api/terminal/${id}/stream`);
  state.termSource = es;
  es.addEventListener('output', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      state.termView?.write(data.data);
    } catch {}
  });
  es.addEventListener('ready', (ev) => {
    const info = JSON.parse(ev.data);
    $('#term-status').textContent = `${info.backend} · ${info.cols}×${info.rows}`;
    state.termView?.focus();
  });
  es.addEventListener('exit', () => {
    $('#term-status').textContent = 'exited';
  });
  es.onerror = () => {
    $('#term-status').textContent = 'disconnected';
  };
}

function sendTerminal(data) {
  if (!state.termId) return;
  api(`/api/terminal/${state.termId}/input`, { method: 'POST', body: { data } }).catch(() => {});
}

function resetTerminal() {
  state.termSource?.close();
  state.termSource = null;
  if (state.termId) api(`/api/terminal/${state.termId}`, { method: 'DELETE' }).catch(() => {});
  state.termId = '';
  state.termView = null;
  const host = $('#terminal');
  if (host) host.innerHTML = '';
  const status = $('#term-status');
  if (status) status.textContent = 'disconnected';
}

async function newTerminal() {
  if (state.termSource) state.termSource.close();
  if (state.termId) await api(`/api/terminal/${state.termId}`, { method: 'DELETE' }).catch(() => {});
  state.termId = '';
  state.termView?.clear();
  state.termView = null;
  await ensureTerminal();
}

async function killTerminal() {
  if (!state.termId) return;
  await api(`/api/terminal/${state.termId}`, { method: 'DELETE' }).catch(() => {});
  state.termSource?.close();
  state.termId = '';
  $('#term-status').textContent = 'killed';
  state.termView?.clear();
  state.termView?.write('\r\n\x1b[38;5;244m[session ended]\x1b[0m\r\n');
}

/* ------------------------------------------------------------- database --- */
function renderDbFiles() {
  const select = $('#db-select');
  if (!select) return;
  select.innerHTML = '';
  if (!state.dbFiles.length) {
    select.innerHTML = '<option value="">no database</option>';
    return;
  }
  for (const f of state.dbFiles) {
    const opt = el('option', { value: f.path, text: `${f.path} (${bytes(f.size)})` });
    select.append(opt);
  }
  if (!state.dbPath || !state.dbFiles.some((f) => f.path === state.dbPath)) state.dbPath = state.dbFiles[0].path;
  select.value = state.dbPath;
  select.onchange = () => {
    state.dbPath = select.value;
    loadDbSchema();
  };
}

async function loadDbSchema() {
  if (!state.dbPath) {
    $('#db-tables').innerHTML = '<div class="hint" style="padding:8px">No SQLite database in this project yet.<br><br>Ask AlphaCode to create one, e.g. “create a SQLite schema for a blog”.</div>';
    $('#db-status').textContent = 'no database';
    return;
  }
  try {
    const schema = await api(`/api/projects/${state.projectId}/database/schema?path=${encodeURIComponent(state.dbPath)}`);
    state.dbSchema = schema;
    $('#db-status').textContent = `${schema.tables.length} tables · sqlite ${schema.version}`;
    const host = $('#db-tables');
    host.innerHTML = '';
    for (const t of schema.tables) {
      const row = el('div', { class: `db-table ${state.dbTable === t.name ? 'active' : ''}` });
      row.innerHTML = `<span>${t.type === 'view' ? '◫' : '▤'} ${escapeHtml(t.name)}</span><small>${t.rows}</small>`;
      row.onclick = () => {
        state.dbTable = t.name;
        loadDbTable(t.name);
        renderDbFiles();
        loadDbSchema();
      };
      host.append(row);
    }
    if (!schema.tables.length) host.innerHTML = '<div class="hint" style="padding:8px">No tables yet.</div>';
  } catch (err) {
    $('#db-status').textContent = err.message;
  }
}

async function loadDbTable(table) {
  try {
    const data = await api(`/api/projects/${state.projectId}/database/rows?path=${encodeURIComponent(state.dbPath)}&table=${encodeURIComponent(table)}&limit=100`);
    const host = $('#db-result');
    host.innerHTML = `<div class="small muted" style="margin-bottom:8px">${data.total} rows · double-click a cell to edit</div>`;
    const wrap = el('div', { style: 'overflow:auto' });
    const tableEl = el('table', { class: 'db-grid' });
    tableEl.innerHTML = `<thead><tr><th>#</th>${data.columns.filter((c) => c !== '__rowid').map((c) => `<th>${escapeHtml(c)}</th>`).join('')}<th></th></tr></thead>`;
    const tbody = el('tbody');
    for (const row of data.rows) {
      const tr = el('tr');
      tr.append(el('td', { text: row.__rowid }));
      for (const c of data.columns.filter((x) => x !== '__rowid')) {
        const td = el('td', { class: 'editable', text: row[c] === null ? '' : String(row[c]) });
        td.title = row[c] === null ? 'NULL' : String(row[c]);
        td.ondblclick = async () => {
          const next = prompt(`Edit ${c}`, row[c] === null ? '' : String(row[c]));
          if (next === null) return;
          await api(`/api/projects/${state.projectId}/database/row`, {
            method: 'POST',
            body: { path: state.dbPath, table, rowid: row.__rowid, values: { [c]: next }, action: 'update' },
          });
          loadDbTable(table);
        };
        tr.append(td);
      }
      const del = el('button', { class: 'icon-btn sm', title: 'Delete row', html: icon('trash', 13) });
      del.onclick = async () => {
        if (!(await confirmDialog('Delete this row?', { danger: true, confirmLabel: 'Delete' }))) return;
        await api(`/api/projects/${state.projectId}/database/row`, { method: 'POST', body: { path: state.dbPath, table, rowid: row.__rowid, action: 'delete' } });
        loadDbTable(table);
      };
      const td = el('td');
      td.append(del);
      tr.append(td);
      tbody.append(tr);
    }
    tableEl.append(tbody);
    wrap.append(tableEl);
    host.append(wrap);
  } catch (err) {
    $('#db-result').innerHTML = `<div class="perm-card">${escapeHtml(err.message)}</div>`;
  }
}

async function runSql(write = false) {
  const sql = $('#db-sql').value.trim();
  if (!sql || !state.dbPath) return;
  try {
    const endpoint = write ? 'exec' : 'query';
    const data = await api(`/api/projects/${state.projectId}/database/${endpoint}`, { method: 'POST', body: { path: state.dbPath, sql } });
    const host = $('#db-result');
    if (data.type === 'rows') {
      host.innerHTML = `<div class="small muted" style="margin-bottom:8px">${data.rowCount} rows · ${data.durationMs}ms</div>`;
      host.insertAdjacentHTML('beforeend', renderTable(data.columns, data.rows));
    } else {
      host.innerHTML = `<div class="badge ok">${data.changes ?? 0} rows changed</div>`;
      loadDbSchema();
      if (state.dbTable) loadDbTable(state.dbTable);
    }
  } catch (err) {
    $('#db-result').innerHTML = `<div class="perm-card">${escapeHtml(err.message)}</div>`;
  }
}

/* ---------------------------------------------------------------- deploy -- */
function renderDeployTargets() {
  const host = $('#deploy-targets');
  if (!host) return;
  const caps = state.deploy || {};
  const targets = [
    { id: 'cloudflare', label: 'Cloudflare Pages', note: 'Direct upload · global edge', connected: caps.cloudflare?.connected },
    { id: 'netlify', label: 'Netlify', note: 'Digest deploy · instant rollbacks', connected: caps.netlify?.connected },
    { id: 'vercel', label: 'Vercel', note: 'Production deployment', connected: caps.vercel?.connected },
    { id: 'preview', label: 'Claimable preview', note: 'No token needed — claim to keep', connected: true, always: true },
  ];
  host.innerHTML = '';
  for (const t of targets) {
    const card = el('div', { class: 'deploy-card' });
    card.innerHTML = `<h4>${icon(t.id === 'preview' ? 'globe' : 'rocket', 15)} ${t.label}
        <span class="tag ${t.connected ? 'ok' : ''}">${t.connected ? (t.always ? 'ready' : 'connected') : 'no token'}</span></h4>
      <p>${t.note}</p>
      <div class="status">${t.connected ? '<span class="dot ok"></span> ready' : '<span class="dot warn"></span> will create a claimable URL instead'}</div>
      <button class="btn sm ${t.connected && !t.always ? 'primary' : ''}">Deploy</button>`;
    card.querySelector('button').onclick = () => deploy(t.id, card);
    host.append(card);
  }
}

async function deploy(target, card) {
  const projectName = state.project?.name || 'alphacode-app';
  const btn = card?.querySelector('button');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> deploying…';
  }
  const log = el('div', { class: 'deploy-log', text: 'starting…' });
  $('#deploy-history')?.prepend(log);
  try {
    const res = await api(`/api/projects/${state.projectId}/deploy`, { method: 'POST', body: { target, projectName } });
    log.textContent += `\n✔ ${res.url}`;
    toast(`Deployed: ${res.url}`, 'ok', 6000);
    const inner = log;
    inner.insertAdjacentHTML('afterend', `<div class="dep-row">${deployResultHtml(res.display)}</div>`);
    if (res.claimUrl) {
      inner.insertAdjacentHTML('afterend', `<div class="dep-row"><span class="tag warn">unclaimed</span><span>Preview needs to be claimed</span><a class="btn sm" href="${escapeHtml(res.claimUrl)}" target="_blank" rel="noopener noreferrer">Claim URL</a><button class="btn sm" data-copy="${escapeHtml(new URL(res.claimUrl, location.origin).href)}">Copy link</button></div>`);
    }
    const data = await api(`/api/projects/${state.projectId}`);
    renderDeploy(data.deployments || []);
  } catch (err) {
    log.textContent += `\n✕ ${err.message}`;
    toast(err.message, 'err', 6000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Deploy';
    }
  }
}

function renderDeploy(deployments = []) {
  const host = $('#deploy-history');
  if (host) {
    host.innerHTML = '';
    if (!deployments.length) host.innerHTML = '<div class="hint">No deployments yet.</div>';
    for (const d of deployments) {
      const row = el('div', { class: 'dep-row' });
      const status = d.claimed ? '<span class="tag ok">claimed</span>' : d.provider === 'local' ? '<span class="tag warn">unclaimed</span>' : '<span class="tag ok">live</span>';
      row.innerHTML = `<span class="tag info">${escapeHtml(d.provider)}</span>${status}
        <a href="${escapeHtml(d.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.url)}</a>
        <span class="small muted">${timeAgo(d.createdAt || d.created_at)}</span><div class="grow"></div>
        ${d.claimUrl && !d.claimed ? `<a class="btn sm" href="${escapeHtml(d.claimUrl)}" target="_blank" rel="noopener noreferrer">Claim</a>` : ''}
        <button class="btn sm" data-copy="${escapeHtml(d.url)}">Copy</button>`;
      host.append(row);
    }
  }
  renderDeployTargets();
}

/* ---------------------------------------------------------------- views --- */
function setView(view) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view === 'settings' ? 'settings' : view}`));
  $$('.rail button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'terminal') {
    setTimeout(() => {
      ensureTerminal();
      state.termView?.fit();
    }, 40);
  }
  if (view === 'files') renderFileTree();
  if (view === 'db') {
    renderDbFiles();
    loadDbSchema();
  }
  if (view === 'deploy') {
    renderDeployTargets();
    api(`/api/projects/${state.projectId}`)
      .then((d) => renderDeploy(d.deployments || []))
      .catch(() => {});
  }
  if (view === 'settings') {
    const host = $('#settings-inline');
    host.innerHTML = '';
    const inner = el('div', { class: 'settings-inner' });
    host.append(inner);
    api('/api/settings').then((s) => renderSettings(inner, s));
  }
}

/* -------------------------------------------------------------- palette --- */
const COMMANDS = [
  { id: 'new-project', label: 'New project', hint: '⌘⇧P', run: promptNewProject },
  { id: 'new-session', label: 'New session', hint: '', run: newSession },
  { id: 'model', label: 'Change model', hint: '⌘⇧M', run: openModelPicker },
  { id: 'deploy', label: 'Deploy project', hint: '', run: () => (setView('deploy'), $('#btn-deploy-now')?.focus()) },
  { id: 'terminal', label: 'Open terminal', hint: '⌘⇧T', run: () => setView('terminal') },
  { id: 'files', label: 'Open files', hint: '', run: () => setView('files') },
  { id: 'database', label: 'Open database', hint: '', run: () => setView('db') },
  { id: 'settings', label: 'Settings', hint: '⌘,', run: openSettings },
  { id: 'signin', label: 'Sign in / create account', hint: '', run: () => openAuth('signin') },
  { id: 'compact', label: 'Compact conversation', hint: '/compact', run: () => sendMessage('/compact') },
  { id: 'clear', label: 'Clear session', hint: '/clear', run: () => sendMessage('/clear') },
  { id: 'checkpoint', label: 'Create checkpoint', hint: '', run: createCheckpoint },
  { id: 'export', label: 'Export project (.tar.gz)', hint: '', run: exportProject },
  { id: 'install', label: 'Install dependencies', hint: '', run: installDeps },
  { id: 'stop', label: 'Stop the agent', hint: 'Esc', run: stopRun },
];

function openPalette(prefill = '') {
  const root = $('#modal-root');
  const bg = el('div', { class: 'modal-bg' });
  const box = el('div', { class: 'palette' });
  const input = el('input', { type: 'text', placeholder: 'Type a command or search…', value: prefill });
  const list = el('div', { class: 'palette-list' });
  box.append(input, list);
  bg.append(box);
  root.append(bg);
  let items = COMMANDS;
  const render = () => {
    const q = input.value.toLowerCase().trim();
    items = COMMANDS.filter((c) => c.label.toLowerCase().includes(q));
    list.innerHTML = '';
    items.forEach((c, i) => {
      const row = el('div', { class: `pal-item ${i === state.paletteIndex ? 'active' : ''}` });
      row.innerHTML = `${icon('play', 13)}<span>${escapeHtml(c.label)}</span><span class="k">${escapeHtml(c.hint || '')}</span>`;
      row.onclick = () => {
        destroy();
        c.run();
      };
      list.append(row);
    });
    if (!items.length) list.innerHTML = '<div class="hint" style="padding:10px">No matching command</div>';
  };
  const destroy = () => {
    bg.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') destroy();
    else if (e.key === 'ArrowDown') {
      state.paletteIndex = Math.min(items.length - 1, state.paletteIndex + 1);
      render();
    } else if (e.key === 'ArrowUp') {
      state.paletteIndex = Math.max(0, state.paletteIndex - 1);
      render();
    } else if (e.key === 'Enter') {
      const c = items[state.paletteIndex];
      destroy();
      c?.run();
    }
  };
  input.oninput = () => {
    state.paletteIndex = 0;
    render();
  };
  document.addEventListener('keydown', onKey);
  bg.addEventListener('mousedown', (e) => {
    if (e.target === bg) destroy();
  });
  render();
  setTimeout(() => input.focus(), 30);
}

/* --------------------------------------------------------- composer/mode -- */
const MODES = [
  { id: 'default', label: 'default', hint: 'Edits auto-approved, risky commands ask' },
  { id: 'acceptEdits', label: 'accept edits', hint: 'Everything auto-approved except blocked commands' },
  { id: 'plan', label: 'plan', hint: 'Read-only research, produces a plan' },
  { id: 'bypass', label: 'bypass', hint: 'No prompts at all — use with care' },
];

function setMode(mode) {
  state.mode = mode;
  const m = MODES.find((x) => x.id === mode) || MODES[0];
  $('#chip-mode-txt').textContent = m.label;
  $('#pill-mode-txt').textContent = m.label;
  $('#chip-mode').className = `chip ${mode === 'plan' ? 'acc' : mode === 'bypass' ? 'err' : ''}`;
  savePrefs({ mode });
  toast(`Mode: ${m.label} — ${m.hint}`, '', 2200);
}

function cycleMode() {
  const idx = MODES.findIndex((m) => m.id === state.mode);
  setMode(MODES[(idx + 1) % MODES.length].id);
}

function autoGrow() {
  const ta = $('#prompt');
  ta.style.height = 'auto';
  ta.style.height = Math.min(220, ta.scrollHeight) + 'px';
}

const SLASH = [
  { cmd: '/help', desc: 'Show commands and shortcuts' },
  { cmd: '/clear', desc: 'Clear this session' },
  { cmd: '/compact', desc: 'Summarise to free context' },
  { cmd: '/context', desc: 'Show context + token usage' },
  { cmd: '/model', desc: 'Choose a model' },
  { cmd: '/plan', desc: 'Switch to plan mode' },
  { cmd: '/deploy', desc: 'Deploy the project' },
  { cmd: '/db', desc: 'Open the database explorer' },
  { cmd: '/terminal', desc: 'Open the real shell' },
  { cmd: '/init', desc: 'Create ALPHACODE.md project memory' },
  { cmd: '/rewind', desc: 'Open checkpoints' },
  { cmd: '/export', desc: 'Download the project' },
  { cmd: '/claim', desc: 'Claim a preview URL' },
];

function renderSlashMenu(filter = '') {
  const menu = $('#slash-menu');
  const q = filter.toLowerCase();
  const items = SLASH.filter((s) => s.cmd.includes(q) || s.desc.toLowerCase().includes(q));
  if (!items.length || !filter.startsWith('/')) {
    menu.hidden = true;
    return;
  }
  menu.hidden = false;
  menu.innerHTML = items.map((s, i) => `<div class="slash-item ${i === state.slashIndex ? 'active' : ''}" data-cmd="${s.cmd}"><b>${s.cmd}</b><span>${escapeHtml(s.desc)}</span></div>`).join('');
  menu.querySelectorAll('.slash-item').forEach((node) => {
    node.onclick = () => {
      $('#prompt').value = node.dataset.cmd + ' ';
      menu.hidden = true;
      $('#prompt').focus();
      autoGrow();
    };
  });
}

async function handleSlash(text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  switch (cmd) {
    case '/help':
      appendAssistantText(
        `**Commands**\n\n${SLASH.map((s) => `- \`${s.cmd}\` — ${s.desc}`).join('\n')}\n\n**Shortcuts**\n\n- \`⌘K\` command palette\n- \`⇧Tab\` cycle agent mode\n- \`⌘Enter\` send\n- \`⌘S\` save file\n- \`Esc\` stop the agent`,
      );
      return true;
    case '/clear':
      await api(`/api/projects/${state.projectId}/threads/${state.thread.id}/clear`, { method: 'POST' });
      state.messages = [];
      renderTranscript();
      toast('Session cleared', 'ok');
      return true;
    case '/context': {
      const usage = state.turn ? '' : '';
      appendAssistantText(`**Context**\n\n- Model: \`${state.model || 'auto'}\`\n- Messages: ${state.messages.length}\n- Mode: \`${state.mode}\`\n- Daily requests: ${state.quota?.unlimited ? 'unlimited' : `${state.quota?.used || 0}/${state.quota?.limit || 40}`}\n\nUse \`/compact\` to summarise older turns.`);
      return true;
    }
    case '/compact':
      await sendMessage('Summarise our conversation so far and continue.');
      return true;
    case '/model':
      openModelPicker();
      return true;
    case '/plan':
      setMode('plan');
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
    case '/rewind':
      setView('files');
      showPane('git');
      return true;
    case '/export':
      exportProject();
      return true;
    case '/claim': {
      const url = rest.join(' ');
      const token = url.split('/claim/')[1] || url;
      if (!token) {
        appendAssistantText('Paste a claim link: `/claim https://…/claim/TOKEN`');
        return true;
      }
      try {
        await api(`/api/claim/${encodeURIComponent(token)}`, { method: 'POST' });
        toast('Deployment claimed', 'ok');
        await rebootstrap();
      } catch (err) {
        if (err.status === 401) openAuth('signin');
        else toast(err.message, 'err');
      }
      return true;
    }
    case '/init':
      await sendMessage('Create an ALPHACODE.md project memory file describing this project: purpose, commands (install/dev/build/test), conventions and gotchas. Keep it short.');
      return true;
    default:
      return false;
  }
}

/* --------------------------------------------------------------- actions -- */
async function promptNewProject() {
  const name = prompt('Project name', 'New project');
  if (!name) return;
  await createProject(name);
  toast('Project created', 'ok');
}

async function newSession() {
  const res = await api(`/api/projects/${state.projectId}/threads`, { method: 'POST', body: { title: 'New session' } });
  state.thread = { id: res.thread.id, title: res.thread.title };
  state.messages = [];
  renderTranscript();
  const data = await api(`/api/projects/${state.projectId}`);
  renderSessions(data.threads);
  setView('chat');
  toast('New session', 'ok', 1500);
}

async function createCheckpoint() {
  await api(`/api/projects/${state.projectId}/git/checkpoint`, { method: 'POST', body: { label: 'manual checkpoint' } });
  toast('Checkpoint created', 'ok');
  refreshProjectQuiet();
}

function exportProject() {
  window.open(`/api/projects/${state.projectId}/export`, '_blank');
}

async function installDeps() {
  toast('Installing dependencies…', '', 2000);
  try {
    const res = await api(`/api/projects/${state.projectId}/install-deps`, { method: 'POST' });
    toast(res.ok ? 'Dependencies installed' : 'Install finished with warnings', res.ok ? 'ok' : 'warn', 4000);
  } catch (err) {
    toast(err.message, 'err', 6000);
  }
}

function showPane(name) {
  $$('#files-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#search-pane').hidden = name !== 'search';
  $('#git-pane').hidden = name !== 'git';
  $('#tree-pane').style.display = name === 'tree' ? '' : 'none';
  if (name === 'git') {
    api(`/api/projects/${state.projectId}/git`).then(renderGit).catch(() => {});
  }
  if (window.innerWidth <= 760) {
    if (name === 'tree') $('#tree-pane').classList.remove('hide');
    else $('#tree-pane').classList.add('hide');
  }
}

function renderAttachments() {
  const hint = $('#composer-hint');
  if (!state.attachments.length) {
    hint.textContent = '⏎ send · ⇧⏎ newline';
    return;
  }
  hint.textContent = state.attachments.map((a) => a.name).join(', ').slice(0, 80);
}

function closeDrawer() {
  $('#panel').classList.remove('open');
}

/* --------------------------------------------------------------- binding -- */
function bindGlobal() {
  // nav
  $$('.rail button').forEach((btn) => {
    btn.onclick = () => {
      if (btn.dataset.view === 'settings') return openSettings();
      setView(btn.dataset.view);
    };
  });
  $('#btn-drawer').onclick = () => $('#panel').classList.toggle('open');
  $('#btn-palette').onclick = () => openPalette();
  $('#btn-settings').onclick = () => openSettings();
  $('#btn-auth').onclick = () => (state.user ? openSettings() : openAuth('signin'));
  $('#btn-project').onclick = () => {
    if (window.innerWidth <= 980) $('#panel').classList.toggle('open');
    else openPalette('project');
  };
  $('#btn-new-project').onclick = promptNewProject;
  $('#btn-new-session').onclick = newSession;
  $('#btn-deploy-top').onclick = () => setView('deploy');
  $('#btn-deploy-now').onclick = () => deploy('preview');
  $('#btn-send').onclick = () => sendText();
  $('#btn-stop').onclick = stopRun;
  $('#pill-model').onclick = openModelPicker;
  $('#chip-model').onclick = openModelPicker;
  $('#pill-mode').onclick = cycleMode;
  $('#chip-mode').onclick = cycleMode;
  $('#pill-plan').onclick = () => {
    const plan = $('.plan-card');
    if (plan) plan.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  $('#chip-quota').onclick = () => (state.guest ? openAuth('signup') : openSettings());
  $('#btn-attach').onclick = () => $('#file-input').click();
  $('#file-input').onchange = async (e) => {
    for (const file of e.target.files) {
      if (file.size > 400_000) {
        toast(`${file.name} is too large to attach (max 400 KB)`, 'warn');
        continue;
      }
      const text = await file.text();
      state.attachments.push({ name: file.name, size: file.size, text });
    }
    renderAttachments();
  };

  const prompt = $('#prompt');
  prompt.addEventListener('input', () => {
    autoGrow();
    const value = prompt.value;
    if (value.startsWith('/')) renderSlashMenu(value.split('\n')[0]);
    else $('#slash-menu').hidden = true;
  });
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      const menuOpen = !$('#slash-menu').hidden;
      if (menuOpen) {
        const active = $('#slash-menu .slash-item.active') || $('#slash-menu .slash-item');
        if (active) {
          e.preventDefault();
          prompt.value = active.dataset.cmd + ' ';
          $('#slash-menu').hidden = true;
          autoGrow();
          return;
        }
      }
      e.preventDefault();
      sendText();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      if (!$('#slash-menu').hidden) {
        e.preventDefault();
        state.slashIndex = (state.slashIndex + 1) % ($$('#slash-menu .slash-item').length || 1);
        renderSlashMenu(prompt.value);
      }
    } else if (e.key === 'Escape') {
      $('#slash-menu').hidden = true;
    }
  });

  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openPalette();
    } else if (meta && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      openModelPicker();
    } else if (meta && e.key === ',') {
      e.preventDefault();
      openSettings();
    } else if (e.key === 'Tab' && e.shiftKey && document.activeElement === document.body) {
      e.preventDefault();
      cycleMode();
    } else if (e.key === 'Escape' && state.running && !$('.modal-bg')) {
      stopRun();
    } else if (meta && e.key === 's') {
      e.preventDefault();
      if (state.view === 'files' && state.editorDirty) saveFile();
    } else if (meta && e.key === 'Enter') {
      const p = $('#prompt');
      if (document.activeElement === p) {
        e.preventDefault();
        sendText();
      }
    }
  });

  document.addEventListener('click', (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      copyText(copy.dataset.copy);
      return;
    }
    if (e.target.closest('.copy-code')) {
      const code = e.target.closest('pre')?.querySelector('code');
      if (code) copyText(code.textContent);
    }
  });

  // files
  $$('#files-tabs .tab').forEach((tab) => {
    tab.onclick = () => showPane(tab.dataset.tab);
  });
  $('#editor').addEventListener('input', () => {
    state.editorDirty = true;
    $('#btn-save-file').disabled = false;
    const lines = $('#editor').value.split('\n').length;
    $('#editor-meta').textContent = `${lines} lines · unsaved`;
  });
  $('#btn-save-file').onclick = saveFile;
  $('#btn-export').onclick = exportProject;
  $('#btn-install-deps').onclick = installDeps;
  $('#btn-search').onclick = runSearch;
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });
  $('#btn-checkpoint').onclick = createCheckpoint;

  // terminal
  $('#btn-term-new').onclick = newTerminal;
  $('#btn-term-kill').onclick = killTerminal;
  window.addEventListener('resize', debounce(() => {
    if (state.view === 'terminal') state.termView?.fit();
  }, 250));

  // db
  $('#btn-db-run').onclick = () => runSql(false);
  $('#btn-db-write').onclick = () => runSql(true);
  $('#btn-db-refresh').onclick = () => loadDbSchema();
  $('#db-sql').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runSql(false);
  });

  // deploy
  $('#btn-deploy-now').onclick = () => deploy('preview');
}

async function sendText() {
  let text = $('#prompt').value.trim();
  if (!text) return;
  if (state.running) {
    toast('The agent is still working — press stop first', 'warn');
    return;
  }
  if (state.attachments.length) {
    const attachText = state.attachments.map((a) => `\n\n--- attached file: ${a.name} ---\n${a.text}`).join('');
    text += attachText;
  }
  if (text.startsWith('/')) {
    const handled = await handleSlash(text);
    if (handled) {
      $('#prompt').value = '';
      autoGrow();
      state.attachments = [];
      renderAttachments();
      return;
    }
  }
  sendMessage(text);
}

/* ---------------------------------------------------------------- start --- */
boot();
window.__alphacode = { state, api, deploy, openPalette, openSettings };

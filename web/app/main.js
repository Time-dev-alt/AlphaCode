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
import { createPreview, connectGitHub, deployProject, whoAmI, publishToGitHub, importUrl, deployPreflight, DEPLOY_TARGETS } from '../engine/deploy.js';
import { Harness, Run } from '../engine/harness.js';
import { canVerify, verifyDecision, verificationPrompt, keyOf, verifySummary } from '../engine/agent/verify.js';
import { getGovernor } from '../engine/agent/governor.js';
import { toModelMessages } from '../engine/agent/history.js';
import { renderScaffold } from '../engine/agent/scaffolds.js';
import { FREE_MODELS, PROVIDERS, GUEST_MODEL } from '../engine/providers.js';
import { fetchModels, mergeCatalog, probeModels, describeProbe } from '../engine/agent/catalog.js';
import { toolchainStatus } from '../engine/wasm-toolchains.js';
import { bootWebContainer, installInContainer, startDevInContainer, inspectSandbox, setIsolationCookie, SandboxUnavailable } from '../engine/node/webcontainer.js';
import { projectFingerprint, loadContainerCache, saveContainerCache, clearContainerCaches, containerCacheSize } from '../engine/node/container-cache.js';
import { runPython, pipInstall, loadPython, pythonReady } from '../engine/python.js';
import { createNodeSession } from '../engine/node/session.js';
import { nodepodStatus, NODEPOD_VERSION } from '../engine/node/nodepod.js';
import { JobManager } from '../engine/jobs.js';
import { loadHooks } from '../engine/hooks.js';
import { runWasi, compileC, canCompileC, RUNTIME_MATRIX } from '../engine/native.js';
import { connectAll, contentToText } from '../engine/mcp.js';
import { mountWorkspace, refreshPreview, renderJobs, renderHistory, setLayout, setMobilePane, pickAttachment, setPromptValue, previewErrors, clearPreviewErrors, waitForPreviewReport, clearVisualEdit, syncPaneToView } from './workspace.js';
import { zipSync, download } from '../engine/zip.js';
import { TerminalView } from '../../public/assets/term.js';
import {
  mountFiles,
  refreshFileTree,
  openFile,
  saveActiveFile,
  downloadProjectZip,
  pickFiles,
  newFile,
  importRepo,
  mountFolder,
  resumeMount,
  unmountFolder,
  syncMount,
  mountInfo,
} from './files.js';
import {
  mountActivity,
  resetActivity,
  activityStarted,
  pushActivity,
  patchActivity,
  finishActivity,
  setCollapsed as setActivityCollapsed,
  activityForTool,
  currentStep,
  settleStep,
  noteActivity,
  setThought,
  markToggled,
} from './activity.js';
import { $, $$, el, icon, paintIcons, toast, md, renderDiff, timeAgo, bytes, escapeHtml, copyText, debounce, askText, askConfirm } from './ui.js';

const isMobile = () => window.matchMedia('(max-width: 820px)').matches;

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
  attachments: [],
  activityByTool: new Map(),
  reasoningStep: null,
  github: null,
  deployments: [],
  pendingClaim: '',
  bootedAt: Date.now(),
  node: null,
  jobs: null,
  mcp: { clients: [], tools: [], errors: [] },
  hooks: null,
  // WebContainers state: the instance lives for the tab, the URL in the preview.
  wc: null,
  containerUrl: '',
  // Last answer from `probeModels()` — the status pill's router chip.
  routerHealth: null,
  routerProbedAt: 0,
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

  // A scaffolded template is a finished app, not a prompt: write it here, for
  // free, and let the user look at it before deciding whether the model is
  // needed at all. This is the cheapest possible first turn — zero requests.
  if (template.scaffold) {
    const rendered = renderScaffold(template.scaffold, { brand: template.brand || project.name });
    for (const [path, content] of Object.entries(rendered.files)) await state.fs.write(project.id, path, content);
    await refreshFiles();
    refreshPreview({ force: true });
    toast(`“${template.name}” is ready — describe any change to iterate`, 'ok', 3400);
    $('#prompt')?.focus();
    return;
  }

  await refreshFiles();
  refreshPreview({ force: true });
  toast(`Started “${template.name}”`, 'ok');
  if (template.prompt) {
    const prompt = $('#prompt');
    prompt.value = template.prompt;
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    prompt.focus();
    send(template.prompt);
  } else {
    $('#prompt').focus();
  }
}


/* --------------------------------------------------------------- theme --- */

const THEME_KEY = 'alphacode-theme';
const GOVERNOR_KEY = 'alphacode-governor';

/**
 * Remember provider cooldowns across reloads.
 *
 * Reloading the page does not un-rate-limit a provider, so pretending it does
 * just means burning a request to find out. Only the cooldowns are stored —
 * never key material.
 */
function restoreGovernor() {
  try {
    const saved = JSON.parse(localStorage.getItem(GOVERNOR_KEY) || 'null');
    if (!saved) return;
    getGovernor().restore(saved);
  } catch {
    /* a corrupt entry should never stop the app from booting */
  }
}

function persistGovernor() {
  try {
    const governor = getGovernor();
    governor.budget = Number(state.settings?.requestBudget) || governor.budget;
    localStorage.setItem(GOVERNOR_KEY, JSON.stringify(governor.serialize()));
    state.requestPressure = governor.snapshot();
  } catch {
    /* storage is a nicety here */
  }
}

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme, { persist = true } = {}) {
  document.documentElement.dataset.theme = theme;
  const button = $('#btn-theme');
  if (button) {
    button.dataset.icon = theme === 'light' ? 'sun' : 'moon';
    button.innerHTML = icon(theme === 'light' ? 'sun' : 'moon', 17);
    button.title = theme === 'light' ? 'Switch to dark (⌘⇧L)' : 'Switch to light (⌘⇧L)';
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#fbfaf8' : '#0a0b0d');
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode — the theme just will not persist */
    }
  }
}

const toggleTheme = () => applyTheme(currentTheme() === 'light' ? 'dark' : 'light');

/* ---------------------------------------------------------- runtime panel --- */

function renderRuntimePanel() {
  const panel = $('#runtime-panel');
  if (!panel) return;
  const jobs = state.jobs?.list() || [];
  const rows = [
    ['server', 'Node runtime', state.node ? 'ready' : 'idle', Boolean(state.node), RUNTIME_MATRIX.node.how],
    ['package', 'npm', state.node ? 'registry' : 'offline', Boolean(state.node), RUNTIME_MATRIX.npm.how],
    ['cpu', 'Python', pythonReady() ? 'loaded' : 'on demand', RUNTIME_MATRIX.python.real, RUNTIME_MATRIX.python.how],
    ['database', 'SQLite', 'wasm', true, 'sql.js in this tab'],
    ['activity', 'Background jobs', `${jobs.length}`, jobs.length > 0, 'Web Workers with pids'],
    ['link', 'MCP servers', `${state.mcp.clients.length}`, state.mcp.clients.length > 0, state.mcp.clients.map((c) => c.name).join(', ') || 'none connected'],
    ['github', 'GitHub', state.github?.token ? 'connected' : 'not connected', Boolean(state.github?.token), 'OAuth, no tokens pasted'],
  ];
  panel.innerHTML = `
    <h4>Runtime — all of it runs here</h4>
    ${rows
      .map(
        ([glyph, name, status, on, desc]) => `<div class="runtime-row ${on ? 'on' : ''}">
          <span style="color:var(--fg-3)">${icon(glyph, 14)}</span>
          <span class="name">${escapeHtml(name)} <span class="desc">${escapeHtml(desc)}</span></span>
          <span class="state">${escapeHtml(status)}</span>
        </div>`,
      )
      .join('')}
    <div class="runtime-foot"><button class="link" id="btn-runtime-settings">${icon('sliders', 13)} Runtime settings</button></div>`;
  panel.querySelector('#btn-runtime-settings').onclick = () => {
    panel.hidden = true;
    openSettings();
  };
  panel.hidden = false;
}

/* ------------------------------------------------------------- palette ---- */

function commands() {
  const close = () => ($('#palette').hidden = true);
  const go = (view) => () => {
    setView(view);
    close();
  };
  return [
    { group: 'Workspace', name: 'New project', icon: 'plus', run: async () => { close(); $('#btn-new-project').click(); } },
    { group: 'Workspace', name: 'Templates', icon: 'grid', sub: '⌘⇧T', run: async () => { close(); $('#template-sheet').hidden = false; } },
    { group: 'Workspace', name: 'New session', icon: 'message', run: async () => { close(); $('#btn-new-session').click(); } },
    { group: 'Workspace', name: 'Version history', icon: 'history', sub: '⌘⇧H', run: async () => { close(); $('#btn-history').click(); } },
    { group: 'Workspace', name: 'Switch to Code mode', icon: 'terminal', sub: '⌘⇧2', run: async () => { close(); setLayout('code'); } },
    { group: 'Workspace', name: 'Switch to Build mode', icon: 'wand', sub: '⌘⇧1', run: async () => { close(); setLayout('build'); } },
    { group: 'Views', name: 'Chat', icon: 'message', run: go('chat') },
    { group: 'Views', name: 'Files', icon: 'files', run: go('files') },
    { group: 'Views', name: 'Terminal', icon: 'terminal', sub: '⌘J', run: go('terminal') },
    { group: 'Views', name: 'Database', icon: 'database', run: go('db') },
    { group: 'Views', name: 'Deploy', icon: 'rocket', run: go('deploy') },
    { group: 'Actions', name: 'Send message', icon: 'arrow-up', sub: '⌘↵', run: async () => { close(); send($('#prompt').value); } },
    { group: 'Actions', name: 'Attach a file', icon: 'paperclip', run: async () => { close(); $('#btn-attach').click(); } },
    { group: 'Files', name: 'Export project as a ZIP', icon: 'download', sub: 'files', run: async () => { close(); setView('files'); downloadProjectZip(); } },
    { group: 'Files', name: 'New file', icon: 'plus', run: async () => { close(); setView('files'); newFile(); } },
    { group: 'Files', name: 'Upload files', icon: 'upload', run: async () => { close(); setView('files'); pickFiles(); } },
    { group: 'Files', name: 'Mount a folder from this computer', icon: 'folder-plus', run: async () => { close(); setView('files'); mountFolder(); } },
    { group: 'Files', name: 'Sync the mounted folder now', icon: 'folder-sync', run: async () => { close(); setView('files'); syncMount('pull'); } },
    { group: 'Files', name: 'Write the project into the mounted folder', icon: 'hard-drive', run: async () => { close(); setView('files'); syncMount('push'); } },
    { group: 'Files', name: 'Disconnect the mounted folder', icon: 'unplug', run: async () => { close(); unmountFolder(); } },
    { group: 'Files', name: 'Import a GitHub repository', icon: 'github', run: async () => { close(); setView('files'); importRepo(); } },
    { group: 'Files', name: 'Install packages (npm install)', icon: 'package', run: async () => { close(); runNpmInstall(); } },
    { group: 'Files', name: 'Save the open file', icon: 'check', sub: '⌘S', run: async () => { close(); saveActiveFile(); } },
    { group: 'Actions', name: 'Focus the terminal', icon: 'terminal', run: async () => { close(); setView('terminal'); focusTerminal(); } },
    { group: 'Actions', name: 'Show installed packages', icon: 'boxes', run: async () => { close(); setView('terminal'); focusTerminal(); runShellLine('npm ls'); } },
    { group: 'Actions', name: 'Export every project as JSON', icon: 'download', run: async () => { close(); exportProject(); } },
    { group: 'Actions', name: 'Toggle theme', icon: currentTheme() === 'light' ? 'moon' : 'sun', sub: '⌘⇧L', run: async () => { close(); toggleTheme(); } },
    { group: 'Actions', name: 'Runtime status', icon: 'cpu', run: async () => { close(); renderRuntimePanel(); } },
    { group: 'Actions', name: 'Settings', icon: 'sliders', run: async () => { close(); openSettings(); } },
    { group: 'Assist', name: 'Explain this project', icon: 'files', run: async () => { close(); send('Read the project files and explain the structure, how it runs, and what to work on next. Be brief.'); } },
    { group: 'Assist', name: 'Find and fix the preview errors', icon: 'bug', run: async () => { close(); $('#btn-fix-errors')?.click(); } },
  ];
}

let paletteItems = [];
let paletteIndex = 0;

function renderPalette(query = '') {
  const host = $('#palette-list');
  const q = query.trim().toLowerCase();
  const all = commands();
  paletteItems = q ? all.filter((c) => `${c.name} ${c.group}`.toLowerCase().includes(q)) : all;
  paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
  if (!paletteItems.length) {
    host.innerHTML = `<div class="palette-group">Nothing matches “${escapeHtml(query)}”</div>`;
    return;
  }
  let group = '';
  host.innerHTML = paletteItems
    .map((item, index) => {
      const head = item.group !== group ? `<div class="palette-group">${item.group}</div>` : '';
      group = item.group;
      return `${head}<div class="palette-item ${index === paletteIndex ? 'active' : ''}" data-index="${index}">
        ${icon(item.icon || 'dot', 15)}<span>${escapeHtml(item.name)}</span>${item.sub ? `<span class="sub">${item.sub}</span>` : ''}</div>`;
    })
    .join('');
  host.querySelectorAll('[data-index]').forEach((node) => {
    node.onclick = () => runPaletteItem(Number(node.dataset.index));
    node.onmouseenter = () => {
      paletteIndex = Number(node.dataset.index);
      host.querySelectorAll('.palette-item').forEach((other) => other.classList.toggle('active', other === node));
    };
  });
  host.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
}

function runPaletteItem(index) {
  const item = paletteItems[index];
  if (!item) return;
  $('#palette').hidden = true;
  item.run();
}

function openPalette() {
  const modal = $('#palette');
  if (!modal) return;
  modal.hidden = false;
  paletteIndex = 0;
  const input = $('#palette-input');
  input.value = '';
  renderPalette('');
  setTimeout(() => input.focus(), 20);
}

function wirePalette() {
  const modal = $('#palette');
  if (!modal) return;
  modal.onclick = (event) => {
    if (event.target.id === 'palette') modal.hidden = true;
  };
  const input = $('#palette-input');
  input.oninput = () => renderPalette(input.value);
  input.onkeydown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      paletteIndex = Math.min(paletteIndex + 1, paletteItems.length - 1);
      renderPalette(input.value);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      paletteIndex = Math.max(paletteIndex - 1, 0);
      renderPalette(input.value);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runPaletteItem(paletteIndex);
    } else if (event.key === 'Escape') {
      modal.hidden = true;
    }
  };
}

/* ---------------------------------------------------------------- help ---- */

function openShortcuts() {
  $('#modal-title').textContent = 'Shortcuts';
  $('#modal-body').closest('.modal-card')?.classList.remove('settings');
  $('#modal-body').innerHTML = `
    <section>
      <h3>Everywhere</h3>
      <div class="shortcut-list">
        ${[
          ['⌘K', 'Command menu'],
          ['⌘/ ', 'Focus the prompt'],
          ['⌘↵', 'Send'],
          ['Esc', 'Stop the agent / close panels'],
          ['⇧Tab', 'Cycle permission mode'],
          ['⌘⇧L', 'Light / dark'],
          ['⌘⇧1 · ⌘⇧2', 'Build · Code'],
          ['⌘⇧H', 'Version history'],
          ['⌘⇧T', 'Templates'],
        ]
          .map(([key, what]) => `<div class="shortcut"><kbd>${key}</kbd><span>${what}</span></div>`)
          .join('')}
      </div>
    </section>
    <section>
      <h3>In the terminal</h3>
      <div class="shortcut-list">
        ${[
          ['node file.js', 'Run a module in the in-tab Node runtime'],
          ['npm install x', 'Real packages, resolved at the edge'],
          ['python file.py', 'CPython via Pyodide'],
          ['sqlite3 db.sqlite "…"', 'Query a real database'],
          ['cmd &', 'Run in the background'],
          ['jobs · fg %1 · kill %1', 'List, attach, stop'],
        ]
          .map(([key, what]) => `<div class="shortcut"><kbd>${key}</kbd><span>${what}</span></div>`)
          .join('')}
      </div>
    </section>`;
  $('#modal').hidden = false;
}

/* ------------------------------------------------------------------ boot -- */

/**
 * Measure the notch once and hand it to CSS as a variable.
 *
 * Reading env() inside a declaration is not safe: engines that parse it but
 * cannot resolve it throw away the whole declaration at computed-value time
 * (which silently collapses the bottom bar). A measured pixel value cannot fail.
 */
function detectSafeArea() {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;height:env(safe-area-inset-bottom,0px);pointer-events:none;opacity:0;z-index:-1';
  const top = document.createElement('div');
  top.style.cssText = 'position:fixed;left:0;right:0;top:0;height:env(safe-area-inset-top,0px);pointer-events:none;opacity:0;z-index:-1';
  document.body.append(probe, top);
  const bottom = Math.round(probe.getBoundingClientRect().height) || 0;
  const upper = Math.round(top.getBoundingClientRect().height) || 0;
  probe.remove();
  top.remove();
  const root = document.documentElement;
  root.style.setProperty('--safe-bottom', `${bottom}px`);
  root.style.setProperty('--safe-top', `${upper}px`);
  root.style.setProperty('--nav-offset', `${58 + bottom}px`);
  root.style.setProperty('--side-top', `${12 + upper}px`);
}

async function boot() {
  detectSafeArea();
  paintIcons();
  state.store = await createStore();
  // Probe for real storage instead of trusting feature detection: OPFS throws
  // inside partitioned frames, and losing the user's files silently is worse
  // than a slower IndexedDB backend.
  state.fs = await createFsAsync();
  state.storage = state.fs.mode;
  state.settings = await state.store.settings();
  // New people get file writes without a prompt; that is the whole promise of
  // "describe it and watch it appear". Shell, deletes and deploys still ask.
  state.mode = state.settings.mode || 'accept-edits';
  state.model = state.settings.model || GUEST_MODEL;
  state.github = state.settings.github || null;
  restoreGovernor();

  wireGlobal();
  // These two own the file tree and the activity panel; opening a project
  // refreshes both, so they have to be mounted before that happens.
  mountFiles({
    getState: () => state,
    setView,
    toast,
    ask: (opts) => askText(opts),
    confirm: (opts) => askConfirm(opts),
    onFilesChanged: () => refreshFiles(),
    runCommand: async (line) => {
      setView('terminal');
      const run = async () => {
        const { output } = await state.shell.run(line, { onOutput: (chunk) => state.termView?.write?.(chunk.replace(/\n/g, '\r\n')) });
        return output;
      };
      return run();
    },
  });
  mountActivity();
  trackTranscriptScroll();
  keepTranscriptPinned();
  // A hidden preview is a desktop arrangement. On a phone the preview is a pane,
  // and restoring a desktop preference there would leave a blank screen behind
  // the Preview button.
  setPreviewVisible(state.settings.pane !== 'preview-hidden' || !isMobile(), { persist: false });
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
    focusTerminal: () => focusTerminal(),
    renderAttachments: () => renderAttachments(),
    onSend: () => $('#btn-send').click(),
    onVisualEdit: (active) => {
      // The composer gains a purpose of its own while an element is selected.
      setStatus(active ? 'element selected — adjust it or describe the change' : 'ready');
      $('#composer')?.classList.toggle('editing-element', Boolean(active));
    },
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
  // Fire and forget: the app is usable before this answers, and a router that is
  // down is reported in the pill instead of being discovered by a failed prompt.
  refreshRouterHealth().catch(() => {});
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
    npmEngine: state.settings?.npmEngine || 'builtin',
    npmRegistry: state.settings?.npmRegistry || '',
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
            `${language}: no compiler is configured.\n` +
            '  • turn on “In-browser compilers (WASM)” in Settings → Runtimes (C, C++, Rust in this tab), or\n' +
            '  • set a compile endpoint there, or\n' +
            '  • compile elsewhere and run the result here: wasm main.wasm\n',
        };
      }
      try {
        const source = await state.fs.readText(state.project.id, path);
        const wasm = await compileC({
          source,
          language,
          filename: path,
          settings: state.settings,
          onOutput: (text) => state.termView?.write?.(text),
        });
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
  state.containerUrl = '';
  const frameReset = $('#preview-frame');
  if (frameReset) frameReset.removeAttribute('src');
  state.settings = await state.store.saveSettings({ lastProject: id });
  state.threads = await state.store.threads(id);
  state.thread = state.threads[0] || (await state.store.createThread(id, 'New session'));
  await openThread(state.thread.id);
  await refreshFiles();
  await renderDbs();
  await renderDeployments();
  state.dbs.clear();
  state.dbPath = '';

  refreshFileTree({ keepOpen: false });
  state.node = createNodeSession({
    fs: state.fs,
    projectId: id,
    onStdout: (text) => state.termView?.write?.(text),
    onStderr: (text) => state.termView?.write?.(text),
    npmEngine: state.settings?.npmEngine || 'builtin',
    npmRegistry: state.settings?.npmRegistry || '',
  });
  attachShell();
  // A folder this project was mounted to reconnects without a click when the
  // browser still remembers the permission.
  await resumeMount().catch(() => {});
  refreshFileTree().catch(() => {});
  $('#project-name').textContent = state.project.name;
  state.hooks = await loadHooks({ fs: state.fs, projectId: id, settings: state.settings }).catch(() => null);
  await loadMcp();
  if (state.view === 'terminal') mountTerminal(true);
  refreshPreview();
}

async function openThread(id) {
  state.thread = (await state.store.thread(id)) || state.thread;
  state.messages = await state.store.messages(id);
  // A run in flight owns the transcript; re-rendering from storage mid-stream
  // would cut the streaming turn in half.
  if (!state.running || state.thread?.id !== id) renderTranscript();
  await renderSessions();
}

/* ------------------------------------------------------------- transcript -- */

function transInner() {
  let inner = $('#transcript-inner');
  if (inner) inner.classList.toggle('is-empty', !state.messages.length);
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
  const cards = [
    ['wand', 'Landing page', 'Hero, features, pricing — live in the preview', 'Build a landing page for a product called Northwind. Hero with a gradient, three feature cards, a pricing section with three tiers, and a footer. Responsive and modern.'],
    ['check-circle', 'Todo app', 'Interactive, saves to localStorage', 'Create a todo app with add, complete, delete and filter (all/active/done). Persist to localStorage, add a nice empty state and keyboard support.'],
    ['database', 'SQLite schema', 'A real database you can query', 'Create a SQLite database for a small shop (products, orders, order_items) with seed data, then show me the tables and run a few queries.'],
    ['files', 'Explain this project', 'Reads your workspace and writes a brief', 'Read the project files and write an ALPHACODE.md describing the structure, how to run it and the conventions used. Keep it under 40 lines.'],
  ];
  box.innerHTML = `
    <div class="welcome-eyebrow"><span class="dot ok"></span><span>AlphaCode · running in this tab</span></div>
    <h1 class="welcome-title">What should we <em>build</em>?</h1>
    <p class="welcome-lede">Describe an app in plain words. It gets written, previewed live, and you can keep nudging it until it feels right — <b>files, npm, Python and SQLite all run in your browser</b>, so nothing you type leaves this tab.</p>
    <div class="prompt-cards">
      ${cards
        .map(
          ([glyph, title, sub, prompt]) => `<button class="prompt-card" data-prompt="${escapeHtml(prompt)}">
            <span class="pc-icon">${icon(glyph, 15)}</span>
            <span><span class="pc-title">${escapeHtml(title)}</span><span class="pc-sub">${escapeHtml(sub)}</span></span>
            <span class="pc-arrow">${icon('arrow-right', 14)}</span>
          </button>`,
        )
        .join('')}
    </div>
    <div class="welcome-foot">
      <span><span class="dot ok"></span>node + npm</span>
      <span><span class="dot ok"></span>cpython</span>
      <span><span class="dot ok"></span>sqlite</span>
      <span><span class="dot ok"></span>${escapeHtml(state.storage === 'memory' ? 'temporary storage' : 'files persist here')}</span>
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
  inner.classList.toggle('is-empty', !state.messages.length);
  host.append(inner);
  if (!state.messages.length) {
    renderWelcome();
    return;
  }
  // Replay has to rebuild the same shape a live run produces: each answer gets
  // its own turn, and the tool calls that produced it nest inside it. Appending
  // cards to the transcript root instead would stack them above the history.
  state.turn = null;
  state.lastTurn = null;
  for (const m of state.messages) {
    if (m.role === 'user') {
      state.turn = null;
      appendUser(m.content?.text || '');
    } else if (m.role === 'assistant') {
      // An empty assistant message is the model asking for tools: it belongs to
      // the turn already open, so it must not start a new one.
      if (m.content?.text?.trim()) appendAssistant(m.content.text);
    } else if (m.role === 'tool') {
      const turn = ensureTurn();
      turn.meta.querySelector('.turn-model').textContent = 'history';
      const content = m.content || {};
      const card = appendTool({ name: content.name || 'tool', title: content.title || '', args: {} });
      finishTool(card, {
        ok: !content.isError,
        summary: summaryForStored(content),
        display: content.display,
        output: content.content,
      });
      state.turn = turn;
    }
  }
  // A turn that only ever made tool calls should not keep a live dot.
  state.turn?.meta.querySelector('.dot')?.classList.remove('live');
  state.turn = null;
  state.lastTurn = null;
  for (const stale of inner.querySelectorAll('.turn-meta .dot.live')) stale.classList.remove('live');
  scrollTranscript(true);
}

const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim())?.slice(0, 140) || '';

/** Rebuild the same summary the live run showed, from what was persisted. */
function summaryForStored(content) {
  const display = content.display;
  if (display?.kind === 'diff') {
    const lines = String(display.diff || '').split('\n');
    const added = lines.filter((l) => l.startsWith('+')).length;
    const removed = lines.filter((l) => l.startsWith('-')).length;
    return `+${added} −${removed} · ${display.path || ''}`;
  }
  if (display?.kind === 'diff-many') {
    const files = display.files || [];
    const added = files.reduce((n, f) => n + String(f.diff || '').split('\n').filter((l) => l.startsWith('+')).length, 0);
    const removed = files.reduce((n, f) => n + String(f.diff || '').split('\n').filter((l) => l.startsWith('-')).length, 0);
    return `${files.length} files · +${added} −${removed}`;
  }
  if (display?.kind === 'scaffold') return `${display.label} · ${display.files?.length || 0} files`;
  if (display?.kind === 'read-many') return `${display.count || 0} files read`;
  if (display?.kind === 'bash') return `exit ${display.exitCode}`;
  if (display?.kind === 'files') return `${display.files?.length || 0} files`;
  if (display?.kind === 'search') return `${display.hits?.length || 0} matches`;
  if (display?.kind === 'todos') return `${display.todos?.length || 0} todos`;
  return firstLine(content.content);
}

/**
 * Is the reader at the bottom of the conversation?
 *
 * Tracked via a `scroll` listener instead of measured on demand, because when a
 * new answer arrives the content has already grown — measuring then would always
 * say "not at the bottom" and nothing would follow the stream.
 */
let transcriptPinned = true;

function trackTranscriptScroll() {
  const host = $('#transcript');
  if (!host) return;
  host.addEventListener('scroll', () => {
    transcriptPinned = host.scrollHeight - host.scrollTop - host.clientHeight < 60;
  }, { passive: true });
}

function scrollTranscript(force) {
  const host = $('#transcript');
  if (!host) return;
  if (force) transcriptPinned = true;
  if (transcriptPinned) host.scrollTop = host.scrollHeight;
}

/**
 * Content grows for reasons that never fire a scroll event: an answer streams
 * in, the activity log folds away, a tool card expands. Watching the transcript's
 * size keeps the newest line in view without fighting a reader who scrolled up.
 */
function keepTranscriptPinned() {
  const host = $('#transcript');
  if (!host || typeof ResizeObserver === 'undefined') return;
  const sync = () => {
    if (transcriptPinned) host.scrollTop = host.scrollHeight;
  };
  new ResizeObserver(sync).observe(host);
  const inner = $('#transcript-inner');
  if (inner) new ResizeObserver(sync).observe(inner);
}

/**
 * Attachment chips live in the composer, above the textarea: a file is attached
 * to the message, not pasted into it, so the message you wrote stays readable.
 */
function renderAttachments() {
  const strip = $('#attach-strip');
  if (!strip) return;
  const files = state.attachments || [];
  if (!files.length) {
    strip.hidden = true;
    strip.innerHTML = '';
    return;
  }
  strip.hidden = false;
  strip.innerHTML = files
    .map(
      (file, index) => `<span class="attach-chip ${file.kind}">
        ${file.kind === 'image' && file.url ? `<img src="${file.url}" alt="">` : icon('file', 12)}
        <span class="attach-name">${escapeHtml(file.name)}</span>
        <span class="attach-size">${bytes(file.size)}</span>
        <button class="attach-x" data-detach="${index}" aria-label="Remove ${escapeHtml(file.name)}">${icon('close', 10)}</button>
      </span>`,
    )
    .join('');
  strip.querySelectorAll('[data-detach]').forEach((button) => {
    button.onclick = () => {
      const [removed] = state.attachments.splice(Number(button.dataset.detach), 1);
      if (removed?.url) URL.revokeObjectURL(removed.url);
      renderAttachments();
      syncSendState();
    };
  });
}

/** Fold attachment text into what the model receives, keeping the bubble clean. */
function messageWithAttachments(text) {
  const files = state.attachments || [];
  if (!files.length) return text;
  const blocks = files
    .map((file) => {
      if (file.kind === 'image') return `--- ${file.name} (image) ---\n[image attached: ${file.name}]`;
      const body = file.text.length > 12_000 ? `${file.text.slice(0, 12_000)}\n… [truncated ${bytes(file.text.length - 12_000)}]` : file.text;
      return `--- ${file.name} ---\n${body}`;
    })
    .join('\n\n');
  return `${text}\n\n${blocks}`.trim();
}

function appendUser(text, attachments = []) {
  const inner = transInner();
  inner.classList.remove('is-empty');
  inner.querySelector('.welcome')?.remove();
  const chips = attachments.length
    ? `<div class="bubble-attachments">${attachments
        .map(
          (file) =>
            `<span class="bubble-file">${icon(file.kind === 'image' ? 'camera' : 'file', 11)}${escapeHtml(file.name)}<span class="bubble-file-size">${bytes(file.size)}</span></span>`,
        )
        .join('')}</div>`
    : '';
  inner.append(el('div', { class: 'msg user', html: `<div class="bubble">${escapeHtml(text).replace(/\n/g, '<br>')}${chips}</div>` }));
  scrollTranscript(true);
}

function ensureTurn() {
  const inner = transInner();
  if (state.turn) return state.turn;
  const wrap = el('div', { class: 'turn' });
  const meta = el('div', { class: 'turn-meta' });
  meta.innerHTML = `<span class="dot live"></span><span class="turn-model">thinking</span>`;
  const body = el('div', { class: 'turn-body' });
  const reasoning = el('details', { class: 'reasoning', html: '<summary>reasoning</summary><p></p>' });
  reasoning.hidden = true;
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

const TOOL_LABEL = {
  write: 'Write',
  read: 'Read',
  edit: 'Edit',
  multi_edit: 'Edit',
  bash: 'Shell',
  shell: 'Shell',
  glob: 'Find files',
  grep: 'Search',
  list: 'List',
  todo_write: 'Plan',
  deploy: 'Deploy',
  npm_install: 'npm install',
  job_start: 'Background',
  job_output: 'Background',
  job_kill: 'Background',
  web_fetch: 'Fetch',
  db_query: 'SQL',
  db_schema: 'SQL',
  subagent: 'Subagent',
};

const toolLabel = (name) => TOOL_LABEL[name] || (name.startsWith('mcp__') ? name.split('__')[1] === undefined ? 'MCP' : 'MCP' : name);

function appendTool({ name, title, args, activityId = '' }) {
  const turn = state.turn || state.lastTurn;
  const host = turn?.tools || transInner();
  const card = el('div', { class: 'tool' });
  const detail = title || args?.command || args?.file_path || args?.path || args?.pattern || args?.query || '';
  card.innerHTML = `<div class="tool-head" title="${escapeHtml(name)}" role="button" tabindex="0">
    <span class="tool-name">${escapeHtml(toolLabel(name))}</span>
    <span class="tool-title">${escapeHtml(detail)}</span>
    <span class="grow"></span><span class="tool-sum"></span><span class="tool-caret">${icon('chevron-down', 12)}</span></div>
    <div class="tool-body" hidden></div>`;
  const body = card.querySelector('.tool-body');
  card.querySelector('.tool-head').onclick = () => {
    if (!body.textContent.trim() && body.hidden) return;
    body.hidden = !body.hidden;
    card.classList.toggle('open', !body.hidden);
  };
  card.querySelector('.tool-head').onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      card.querySelector('.tool-head').click();
    }
  };
  if (activityId) card.dataset.activityId = activityId;
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
  const summaryNode = card.querySelector('.tool-sum');
  if (summaryNode) summaryNode.textContent = summary || '';
  const body = card.querySelector('.tool-body');
  if (!body) return;
  if (display?.kind === 'diff' && display.diff) {
    body.innerHTML = renderDiff(display.diff);
  } else if (display?.kind === 'diff-many' && display.files?.length) {
    // One card, several files: label each diff so a multi-file write reads like
    // a changeset instead of an undifferentiated wall of +/- lines.
    body.innerHTML = display.files
      .map((file) => `<div class="diff-file"><span class="diff-path">${escapeHtml(file.path)}</span>${file.diff ? renderDiff(file.diff) : '<span class="tiny">(new file)</span>'}</div>`)
      .join('');
  } else if (display?.kind === 'scaffold' && display.files?.length) {
    body.innerHTML = `<div class="scaffold-note">Wrote a complete, working ${escapeHtml(display.label || 'app')}:</div>` +
      display.files.map((path) => `<div class="scaffold-file">${escapeHtml(path)}</div>`).join('');
  } else if (output && !card._out) {
    body.textContent = String(output).slice(0, 4000);
  }
  // Once a tool has finished, only the interesting ones stay open. A 60-line
  // diff left expanded turns the conversation into a wall of colour; the summary
  // in the header already says what happened, and one click brings it back.
  const lines = (body.textContent || '').split('\n').length;
  const interesting = ok === false || lines <= 6 || card.classList.contains('open');
  body.hidden = !interesting;
  card.classList.toggle('open', interesting);
}

function appendNotice(text, kind = 'info') {
  transInner().append(el('div', { class: `notice ${kind}`, text: String(text) }));
  scrollTranscript();
}

/**
 * How many model requests this turn has spent.
 *
 * Shown because it is the number that decides whether the agent finishes or
 * gets rate limited — and because seeing "3" instead of nothing is how a user
 * learns that a batched build really was one round trip.
 */
function renderRequestMeter() {
  const pill = $('#req-pill');
  if (!pill) return;
  const used = state.requestsUsed || 0;
  const budget = state.requestBudget || 0;
  pill.hidden = !used;
  const meter = $('#req-meter');
  if (meter) meter.textContent = budget ? `${used}/${budget}` : `${used}`;
  pill.title = budget
    ? `${used} of ${budget} model requests used in this turn`
    : `${used} model requests used in this turn`;
  pill.classList.toggle('hot', Boolean(budget) && used >= budget);
}

/** A notice with one button, for "there is something you can do about this". */
function appendActionNotice(text, label, onClick, kind = 'warn') {
  const row = el('div', { class: `notice ${kind}` });
  const copy = el('span', { text: String(text) });
  const button = el('button', { class: 'btn sm', text: label });
  button.onclick = () => {
    button.disabled = true;
    button.textContent = '…';
    onClick();
  };
  row.append(copy, button);
  transInner().append(row);
  scrollTranscript();
  return row;
}

/**
 * The seam between a paused turn and its continuation.
 *
 * Resuming used to type the word "continue" into the transcript as if the user
 * had said it — a fake user message they could not delete, and one that reads
 * like the agent needed nagging. Instead the transcript gets a divider and the
 * *model* gets the nudge, which is the only place it belongs.
 */
function appendResumeDivider(reason = '') {
  const row = el('div', { class: 'resume-divider' });
  row.innerHTML = `<span>${icon('play', 11)}<span>resumed${reason ? ` — ${escapeHtml(reason)}` : ''}</span></span>`;
  transInner().append(row);
  scrollTranscript();
  return row;
}

/**
 * Continue the interrupted turn in place.
 *
 * The run keeps its thread history: `send()` replays the prior messages, so the
 * model sees the half-finished work and the tool results it already produced.
 * The only thing that changes is that no user message is appended to the
 * transcript, and the nudge is marked as a continuation.
 */
async function resumeTurn() {
  if (state.running) return;
  await send(RESUME_PROMPT, { resume: true });
}

const RESUME_PROMPT =
  'Continue from where you were interrupted. The work above is real — do not restart or rewrite what is already correct. Pick up the next unfinished step and finish the task.';

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

/**
 * Run one turn.
 *
 * @param {string} text
 * @param {{verify?: boolean}} [options]  `verify:false` is used by the
 *   self-verification pass so a fix turn never triggers another fix turn.
 */
async function send(text, options = {}) {
  if (!text?.trim() || state.running) return;
  const resuming = options.resume === true;
  if (!resuming && (await handleSlash(text.trim()))) return;
  if (!state.project) await createProject('My first app', { silent: true });

  const inner = transInner();
  inner.querySelector('.welcome')?.remove();
  const outgoing = messageWithAttachments(text);
  if (resuming) {
    // No user bubble and no prompt clearing: the person did not type anything,
    // they pressed Continue on a turn that ran out of requests.
    appendResumeDivider(options.reason || 'out of requests this minute');
  } else {
    appendUser(text, state.attachments || []);
    setPromptValue('');
    autoGrow();
  }
  state.attachments = [];
  renderAttachments();
  syncSendState();
  clearVisualEdit();
  resetActivity();
  activityStarted();
  state.activityProviderErrors = [];
  state.verifiedThisTurn = false;
  state.relayNoted = false;
  pushActivity({ kind: 'think', title: 'Reading the request', state: 'run' });
  setRunning(true);
  if (isMobile()) setMobilePane('chat');

  const run = new Run({ id: uid('run_', 5), threadId: state.thread.id, projectId: state.project.id, mode: state.mode, model: state.model });
  state.run = run;
  state.currentTurn = null;
  // The thread is the project's memory: replay the recent turns so a follow-up
  // ("make the hero bigger") has the hero it refers to. Without this the agent
  // re-planned every turn and sometimes rebuilt files that already existed.
  const prior = await state.store.messages(state.thread.id).catch(() => []);
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
      c: canCompileC(state.settings)
        ? state.settings.cCompilerEndpoint
          ? 'C/C++/Rust via your compile endpoint'
          : 'C/C++/Rust compile in the tab (WASM)'
        : 'not configured — WASI binaries still run',
      models: {
        pool: (state.settings.modelPool || []).length,
        catalog: Object.fromEntries(Object.entries(state.settings.catalog || {}).map(([provider, ids]) => [provider, ids.length])),
      },
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
  harness.messages = toModelMessages(prior);
  // One governor for the page: a cooldown learned in this turn still applies in
  // the next one, so the agent does not re-discover a rate limit by trying.
  harness.governor = getGovernor();
  state.harness = harness;
  state.verifySeen = state.verifySeen || new Set();
  let result = null;

  run.onEvent(handleEvent);
  run.status = 'running';
  try {
    result = await harness.send(outgoing);
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
    persistGovernor();
    // Self-verification runs after the turn is closed, so a fix pass looks like
    // a normal follow-up turn rather than a second half of this one.
    if (result && options.verify !== false) queueVerification(harness, result);
  }
}

/**
 * Give the preview a moment, then fix whatever it is shouting about.
 *
 * Lovable and Genspark both do this and it is most of why their output feels
 * finished. It is capped at one pass per user turn and two requests, because an
 * agent that "fixes" a broken preview forever is worse than one that says what
 * is wrong.
 */
async function queueVerification(harness, result) {
  if (state.verifyQueued) return;
  state.verifyQueued = true;
  const errors = [];
  const decide = () =>
    verifyDecision({
      finishReason: result.finishReason,
      errors,
      filesChanged: harness.filesChanged.size > 0,
      budgetLeft: harness.governor ? harness.governor.remaining : 0,
      verifyAlready: Boolean(state.verifiedThisTurn),
      seen: state.verifySeen,
      enabled: state.settings.autoVerify !== false,
    });
  try {
    state.verifySeen = state.verifySeen || new Set();
    // Nothing to wait for if the turn was stopped, changed nothing, or is out
    // of requests — check before spending 1.6 s on a preview that cannot help.
    if (
      !canVerify({
        finishReason: result.finishReason,
        filesChanged: harness.filesChanged.size > 0,
        budgetLeft: harness.governor ? harness.governor.remaining : 0,
        verifyAlready: Boolean(state.verifiedThisTurn),
        enabled: state.settings.autoVerify !== false,
      })
    ) {
      return;
    }

    await waitForPreviewReport({ ms: 1600 });
    errors.push(...previewErrors());
    const decision = decide();
    if (!decision.go) {
      if (errors.length && decision.reason === 'already reported') clearPreviewErrors();
      return;
    }
    state.verifiedThisTurn = true;
    for (const error of decision.errors) state.verifySeen.add(keyOf(error));
    noteActivity(verifySummary(decision.errors), 'checking the preview');
    appendNotice(verifySummary(decision.errors), 'info');
    clearPreviewErrors();
    state.verifyQueued = false;
    await send(verificationPrompt(decision.errors, { where: 'preview' }), { verify: false });
  } catch (err) {
    console.warn('[verify] skipped', err);
  } finally {
    state.verifyQueued = false;
  }
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'model': {
      $('#chip-model-txt').textContent = `${ev.model.split('/').pop()}`;
      const counter = ev.request && ev.remaining != null ? ` · request ${ev.request}, ${ev.remaining} left` : '';
      if (ev.request != null) {
        state.requestsUsed = ev.request;
        renderRequestMeter();
      }
      setStatus(`calling ${ev.label || ev.provider}${counter}`);
      // A turn can call the model many times: keep one row and retitle it rather
      // than printing a line per round.
      setThought(`Thinking via ${ev.label || ev.provider}${counter}`);
      break;
    }
    case 'budget': {
      state.requestBudget = ev.budget;
      state.requestsUsed = 0;
      renderRequestMeter();
      break;
    }
    case 'rate_wait': {
      setStatus(`rate limit — waiting ${Math.ceil(ev.ms / 1000)}s before the next request`);
      pushActivity({ kind: 'think', title: `Waiting out a rate limit (${Math.ceil(ev.ms / 1000)}s)`, state: 'run' });
      break;
    }
    case 'budget_extended': {
      // Autonomy, made visible: the turn did not stop at its first checkpoint.
      setStatus(`continuing — ${ev.budget} requests available this turn`);
      pushActivity({ kind: 'think', title: ev.message || 'Continuing the build', state: 'run' });
      state.requestBudget = ev.budget;
      renderRequestMeter();
      break;
    }
    case 'provider_skip': {
      // Deliberately quiet: this is the governor working, not a failure.
      setStatus(`waiting — ${ev.reason}`);
      break;
    }
    case 'text':
      ensureTurn().text += ev.text;
      onTextFlush();
      break;
    case 'text_done':
      if (state.turn) {
        state.turn.body.innerHTML = md(ev.text || state.turn.text);
        state.turn.rendered = ev.text || state.turn.text;
        const model = state.turn.meta.querySelector('.turn-model');
        if (model) model.textContent = state.model.split('/').pop();
      }
      break;
    case 'reasoning': {
      if (!state.reasoningStep) {
        state.reasoningStep = pushActivity({ kind: 'think', title: 'Working through the change', state: 'run' });
      }
      const turn = ensureTurn();
      turn.reasoning.hidden = false;
      turn.hasReasoning = true;
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
      settleStep('think');
      setThought('');
      const step = activityForTool(ev.name, ev.args || {}, null, ev.title || '');
      state.activityByTool = state.activityByTool || new Map();
      state.activityByTool.set(
        ev.toolCallId,
        pushActivity({ kind: step.kind, title: step.title || ev.title || ev.name, detail: step.detail, state: 'run' }),
      );
      break;
    }
    case 'tool_output': {
      toolOutput(state.activeTool, ev.text);
      const id = state.activeTool?.dataset?.toolId;
      if (id) patchActivity(id, { detail: String(state.activeTool?._out || '').slice(-1600) });
      break;
    }
    case 'tool_end': {
      const card = state.toolCards?.get(ev.toolCallId) || state.activeTool;
      finishTool(card, ev);
      state.toolCards?.delete(ev.toolCallId);
      if (state.activeTool === card) state.activeTool = null;
      const stepId = state.activityByTool?.get(ev.toolCallId);
      if (stepId) {
        const failed = Boolean(ev.error) || ev.ok === false;
        patchActivity(stepId, { state: failed ? 'error' : 'done', meta: ev.durationMs ? `${ev.durationMs}ms` : '', detail: ev.error || undefined });
        state.activityByTool.delete(ev.toolCallId);
      }
      break;
    }
    case 'todos':
      renderTodos(ev.todos);
      if (Array.isArray(ev.todos) && ev.todos.length) {
        pushActivity({ kind: 'plan', title: ev.todos[0].text || 'Plan updated', state: 'done', meta: `${ev.todos.length} items` });
      }
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
    case 'provider_error': {
      state.activityProviderErrors = state.activityProviderErrors || [];
      state.activityProviderErrors.push(PROVIDERS[ev.provider]?.label || ev.provider);
      // A turn can try three free routers before the demo model answers. Showing
      // three stack traces to someone who just typed "build me a shop" is noise,
      // so they are buffered into one line once the turn actually produces output.
      state.providerErrors = state.providerErrors || [];
      state.providerErrors.push({
        provider: PROVIDERS[ev.provider]?.label || ev.provider,
        message: ev.message,
        kind: ev.kind || 'unknown',
        cooldownMs: ev.cooldownMs || 0,
        retryable: ev.retryable !== false,
      });
      break;
    }
    case 'relay': {
      // One line per turn: a device that needs the relay needs it for every
      // request, and five identical notices is noise.
      if (state.relayNoted) break;
      state.relayNoted = true;
      appendNotice(`${PROVIDERS[ev.provider]?.label || ev.provider} is answering through this site's relay — same model, no key involved.`, 'info');
      break;
    }
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
      flushProviderErrors();
      const turn = state.turn;
      if (turn) {
        if (!turn.text.trim() && !turn.tools.childElementCount) turn.body.innerHTML = '<p class="muted">(no output)</p>';
        const meta = turn.meta;
        const label = meta.querySelector('.turn-model');
        if (label) label.textContent = state.model.split('/').pop();
        meta.querySelector('.dot')?.classList.remove('live');
        if (!turn.hasReasoning) turn.reasoning.remove();
        const stats = el('div', { class: 'turn-stats' });
        const u = ev.usage || {};
        const calls = ev.steps || 0;
        stats.textContent = `${calls} model request${calls === 1 ? '' : 's'} · ${(u.input || 0).toLocaleString()} in / ${(u.output || 0).toLocaleString()} out${ev.filesChanged?.length ? ` · ${ev.filesChanged.length} files touched` : ''}${ev.finishReason === 'stopped' ? ' · stopped' : ''}${ev.finishReason === 'budget' ? ' · paused' : ''}`;
        turn.wrap.append(stats);
        turn.meta.querySelector('.dot')?.classList.remove('live');
      }
      if (state.turn && !state.turn.text.trim() && !state.turn.tools.childElementCount) {
        // A tool-only turn with nothing in it (a stopped run, or a provider that
        // returned no text) should not leave a ghost bubble behind.
        state.turn.wrap.remove();
      }
      state.lastTurn = state.turn;
      state.turn = null;
      state.reasoningStep = null;
      if (state.activityProviderErrors?.length) {
        const failed = [...new Set(state.activityProviderErrors)];
        noteActivity(
          `${failed.length} router${failed.length === 1 ? '' : 's'} unreachable — finished with the fallback model`,
          failed.join(', '),
        );
        state.activityProviderErrors = [];
      }
      setStatus('ready');
      finishActivity();
      // No `force`: refreshPreview() only re-renders when the bundle actually
      // changed, so a turn that touched one file does not reload the frame and
      // throw away the page's scroll position and form state.
      refreshPreview();
      if (state.activityProviderErrors?.length) refreshRouterHealth({ force: true }).catch(() => {});
      break;
    }
    case 'budget_exhausted':
      appendActionNotice(ev.message, 'Continue', () => resumeTurn(), 'warn');
      noteActivity('Paused to stay inside the rate limit', `used ${ev.budget} requests this turn`);
      break;
    case 'error':
      appendNotice(ev.message, 'err');
      pushActivity({ kind: 'error', title: ev.message, state: 'error' });
      setStatus('ready');
      finishActivity('error');
      break;
    default:
      break;
  }
  scrollTranscript();
}

/**
 * One calm line instead of one warning per router.
 */
function flushProviderErrors() {
  const errors = state.providerErrors || [];
  state.providerErrors = [];
  if (!errors.length) return;
  const demo = state.settings.demo !== false;
  const names = [...new Set(errors.map((e) => e.provider))];

  // The governor tells us *why* a provider failed, so the message can be about
  // the user's situation ("out of credit") instead of a stack trace.
  const kinds = new Set(errors.map((e) => e.kind || 'unknown'));
  const advice = (() => {
    if (kinds.has('auth')) return 'That key was rejected — check it in Settings → Model access.';
    if (kinds.has('quota')) return 'That account is out of credit — add another key in Settings → Model access.';
    if (kinds.has('rate_limit')) {
      const wait = Math.max(...errors.map((e) => e.cooldownMs || 0));
      return `It was rate limited${wait ? ` and is paused for ${Math.ceil(wait / 1000)}s` : ''}${demo ? ' — the offline demo model answered instead.' : '.'}`;
    }
    if (kinds.has('network')) return 'It could not be reached from this browser — usually a CORS block, not your code.';
    if (kinds.has('model')) return 'That model is not available on this account — pick another in Settings → Model access.';
    return demo ? 'The offline demo model answered instead.' : 'Try again, or add another key in Settings → Model access.';
  })();

  if (errors.length === 1) {
    appendNotice(`${names[0]}: ${advice}`, 'warn');
    return;
  }
  appendNotice(`${names.join(', ')} — ${advice}`, 'warn');
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
    .map((t) => `<div class="todo ${t.status}"><span class="mark">${t.status === 'completed' ? icon('check', 10) : t.status === 'in_progress' ? icon('play', 8) : ''}</span>${escapeHtml(t.content)}</div>`)
    .join('')}`;
}

function setRunning(running) {
  state.running = running;
  $('#btn-send').hidden = running;
  $('#btn-stop').hidden = !running;
  $('#app').dataset.running = running ? '1' : '0';
  $('#status-dot').className = `dot ${running ? 'live' : 'ok'}`;
  syncSendState();
  if (running) {
    setStatus('working…');
    state.turn = null;
    state.lastTurn = state.lastTurn || null;
  }
  syncMobileBadge();
}

/** A dot on the Chat tab while the agent works and you are somewhere else. */
function syncMobileBadge() {
  const badge = $('#mnav-badge');
  if (!badge) return;
  const away = $('#app')?.dataset.mobilePane !== 'chat';
  badge.hidden = !(state.running && away);
}

function setStatus(text) {
  const node = $('#status-text');
  if (node) node.textContent = text;
}

/* ----------------------------------------------------------------- files --- */

const flattenTree = (nodes, depth = 0, out = []) => {
  for (const node of nodes) {
    out.push({ ...node, depth });
    if (node.children) flattenTree(node.children, depth + 1, out);
  }
  return out;
};

async function refreshFiles() {
  if (!state.project) return;
  state.tree = await state.fs.tree(state.project.id);
  state.files = flattenTree(state.tree);
  const fileCount = state.files.filter((f) => !f.dir).length;
  const tabCount = $('#tab-file-count');
  if (tabCount) tabCount.textContent = fileCount || '';
  if (state.previewTimer) clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(() => refreshPreview(), 250);
  const where = STORAGE_LABEL[state.storage] || 'in this browser';
  const count = fileCount;
  $('#storage-note').textContent =
    state.storage === 'memory' ? `${count} files · temporary (storage blocked — export before closing)` : `${count} files · ${where}`;
  $('#storage-note').title = state.storage === 'memory'
    ? 'This browser context blocks persistent storage (private mode or a sandboxed frame). Files vanish on reload.'
    : 'Your files never leave this tab. Clearing site data deletes them.';
  await refreshFileTree();
}

const STORAGE_LABEL = { opfs: 'real files in this browser', indexeddb: 'saved in this browser', memory: 'temporary memory' };

/* -------------------------------------------------------------- terminal --- */

function mountTerminal(force) {
  const host = $('#term-host');
  if (!host) return;
  if (!state.termView || force) {
    host.innerHTML = '';
    if (!state.shell) return;
    // Measure the real cell size so lines wrap where the CSS says they wrap.
    const box = host.getBoundingClientRect();
    const cols = Math.max(40, Math.floor((box.width || 760) / 7.7));
    const rows = Math.max(8, Math.floor(((box.height || 400) - 18) / 19));
    state.termView = new TerminalView(host, {
      cols,
      rows,
      onInput: (data) => handleTermInput(data),
      onResize: () => {},
      onBell: () => {},
    });
    state.termBuf = '';
    state.termView.write('\u001b[1;36mAlphaCode shell\u001b[0m — project files, real commands. Type \u001b[1mhelp\u001b[0m.\r\n\r\n');
    prompt();
    requestAnimationFrame(() => state.termView?.fit?.());
  }
  focusTerminal();
}

/** Keep the grid in step with the pane when the window or the view changes. */
function bindTerminalResize() {
  let timer = 0;
  const refit = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.termView && state.view === 'terminal') {
        state.termView.fit?.();
        state.termView.scrollToBottom?.();
      }
    }, 120);
  };
  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', refit);
  return refit;
}

/** Put the caret in the terminal without yanking the page around on phones. */
function focusTerminal() {
  const view = state.termView;
  if (!view) return;
  try {
    view.focus();
    view.scrollToBottom?.();
  } catch {
    /* not mounted yet */
  }
}

const TERM_KEYS = {
  esc: '\x1b',
  tab: '\t',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
};

function bindTermKeys() {
  for (const button of $$('#term-keys .key')) {
    button.onclick = () => {
      const key = button.dataset.key;
      if (key === 'clear') {
        state.termView?.clear?.();
        prompt();
        focusTerminal();
        return;
      }
      state.termView?.send?.(TERM_KEYS[key] ?? '');
      focusTerminal();
    };
  }
  $('#btn-term-focus')?.addEventListener('click', () => focusTerminal());
  // Commands typed by the agent and by the user share one scrollback.
  window.addEventListener('alphacode:term-focus', () => focusTerminal());
}

/** Run a command from the UI (menu, dependency card) as if it were typed. */
async function runShellLine(line) {
  if (!state.shell) return '';
  setView('terminal');
  mountTerminal();
  const view = state.termView;
  view?.write(`${line}\r\n`);
  const { output } = await state.shell.run(line, {
    onOutput: (chunk) => view?.write(chunk.replace(/\n/g, '\r\n')),
  });
  if (output && !output.endsWith('\n')) view?.write('\r\n');
  prompt();
  await refreshFiles();
  refreshFileTree().catch(() => {});
  return output;
}

/** "Install whatever package.json asks for" — the missing button, in words. */
async function runNpmInstall(extra = []) {
  const line = `npm install${extra.length ? ` ${extra.join(' ')}` : ''}`;
  const toastId = toast('Installing packages…', 'info', 2000);
  const output = await runShellLine(line);
  const failed = /npm ERR!/.test(output || '');
  toast(failed ? 'npm install failed — see the terminal' : 'Packages installed into this project', failed ? 'err' : 'ok', 4200);
  refreshFileTree().catch(() => {});
  return { output, failed, toastId };
}

/**
 * Point the preview at a WebContainer dev server.
 *
 * A bundled `srcdoc` preview is right for static files; a Node project has a
 * live server, so the iframe gets a real URL and the file preview stays out of
 * the way until the sandbox is stopped.
 */
/** Flat `{path: text}` → the nested tree `instance.mount()` expects. */
function treeFromFlatFiles(files = {}) {
  const root = {};
  for (const [path, text] of Object.entries(files)) {
    if (typeof text !== 'string' || path.startsWith('node_modules/.bin')) continue;
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!node[name] || node[name].directory === undefined) node[name] = { directory: {} };
      node = node[name].directory;
    }
    node[parts[parts.length - 1]] = { file: { contents: text } };
  }
  return root;
}

/** Snapshot the container's node_modules into OPFS after a successful install. */
async function cacheInstalledModules(instance) {
  const fingerprint = state.wc?.fingerprint;
  if (!fingerprint) return;
  const { snapshotModules } = await import('../engine/node/container-cache.js');
  const snapshot = await snapshotModules(instance).catch(() => null);
  if (!snapshot) return;
  const saved = await saveContainerCache(fingerprint, snapshot).catch(() => null);
  if (saved?.saved) {
    wcLog(`\ncached ${saved.files} files (${bytes(saved.bytes)}) — the next visit can skip npm install\n`);
    state.wc.cached = true;
  }
}

function showContainerPreview(url) {
  if (!url) return;
  state.containerUrl = url;
  const frame = $('#preview-frame');
  const empty = $('#preview-empty');
  if (empty) empty.hidden = true;
  if (frame) {
    frame.removeAttribute('srcdoc');
    frame.hidden = false;
    frame.src = url;
  }
  const urlNode = $('#frame-url');
  if (urlNode) urlNode.textContent = String(url).replace(/^https?:\/\//, '').replace(/\/$/, '');
  $('#status-dot')?.classList.remove('busy');
  toast('Real Node dev server live in the preview', 'ok', 3600);
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

  // Everything that can be known locally is checked here, before a provider tab
  // opens. Failing at step five of five is the expensive kind of failure.
  const preflight = deployPreflight({ target, files, github: state.github });
  if (!preflight.ok) {
    for (const blocker of preflight.blockers) appendNotice(`${blocker.message} ${blocker.fix}`, 'err');
    toast(preflight.blockers[0].message, 'err', 6000);
    return { ok: false, blockers: preflight.blockers };
  }
  if (preflight.warnings.length) {
    appendNotice(`Before you ship: ${preflight.warnings.map((row) => row.message).join(' · ')}`, 'warn');
  }

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
  return { ...result, ok: true, warnings: preflight.warnings };
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
  const stateNode = $('#github-state');
  if (stateNode) stateNode.textContent = connected ? `connected as ${state.github.login || 'you'}` : 'not connected';
  const button = $('#btn-connect-github');
  if (button) {
    button.innerHTML = `${icon(connected ? 'check-circle' : 'github', 14)}${connected ? 'Reconnect GitHub' : 'Connect GitHub'}`;
  }
}

/**
 * Show or hide the preview column.
 *
 * Both the collapse control in the preview bar and the Preview toggle in the tab
 * bar go through here, so the two can never disagree — and because the tab-bar
 * toggle lives *outside* the column, hiding the preview is always reversible.
 */
function setPreviewVisible(visible, { persist = true } = {}) {
  const app = $('#app');
  if (!app) return;
  // Only the non-default state is written to the DOM. `data-pane="preview"` on
  // the app root would collide with the `[data-pane="preview"]` selector the
  // bottom bar uses, and the app element comes first in the document.
  if (visible) delete app.dataset.pane;
  else app.dataset.pane = 'preview-hidden';
  const toggle = $('#btn-preview-toggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(visible));
    toggle.title = visible ? 'Hide the preview' : 'Show the preview';
  }
  const collapse = $('#btn-preview-collapse');
  if (collapse) collapse.title = visible ? 'Hide the preview' : 'Show the preview';
  if (persist) state.store.saveSettings({ pane: visible ? 'preview' : 'preview-hidden' });
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

/* -------------------------------------------------------------- settings --- */

/** Report whether the vendored full engine is actually on this deployment. */
async function refreshNpmEngineState() {
  const node = document.querySelector('#npm-engine-state');
  if (!node) return;
  node.textContent = 'checking the full engine…';
  const status = await nodepodStatus();
  node.className = `hint ${status.available ? 'ok' : 'dim'}`;
  node.textContent = status.available
    ? `Full engine available — Nodepod ${status.version}, loaded on first use (≈5 MB, cached).`
    : `Full engine not deployed (${status.reason}). The built-in resolver keeps working.`;
}

const SETTINGS_TABS = [
  { id: 'appearance', label: 'Appearance', icon: 'palette' },
  { id: 'models', label: 'Models', icon: 'spark' },
  { id: 'providers', label: 'Providers', icon: 'key' },
  { id: 'runtimes', label: 'Runtimes', icon: 'cpu' },
  { id: 'packages', label: 'Packages', icon: 'package' },
  { id: 'mcp', label: 'MCP', icon: 'plug' },
  { id: 'hooks', label: 'Hooks', icon: 'route' },
  { id: 'data', label: 'Data', icon: 'hard-drive' },
];

/** One card inside a pane: a heading, a one-line explainer and the fields. */
const settingsCard = (title, hint, body) => `
  <div class="set-card">
    <div class="set-card-head"><h3>${title}</h3>${hint ? `<p class="set-hint">${hint}</p>` : ''}</div>
    <div class="set-card-body">${body}</div>
  </div>`;

const modelPool = () => (Array.isArray(state.settings.modelPool) ? state.settings.modelPool : []);

const poolHas = (provider, id) =>
  modelPool().some((entry) => (typeof entry === 'string' ? entry === id : entry.id === id && (!entry.provider || entry.provider === provider)));

/** The catalog for a provider: curated entries merged with whatever was fetched. */
function catalogFor(provider) {
  const live = state.settings.catalog?.[provider] || [];
  return mergeCatalog(provider, live.map((id) => ({ id })));
}

/** Every model the picker offers as a default, grouped by provider. */
function modelChoices() {
  const groups = new Map();
  const add = (provider, model) => {
    if (!groups.has(provider)) groups.set(provider, new Map());
    const bucket = groups.get(provider);
    if (!bucket.has(model.id)) bucket.set(model.id, model);
  };
  for (const [provider, list] of Object.entries(FREE_MODELS)) for (const model of list) add(provider, model);
  for (const entry of modelPool()) {
    const provider = typeof entry === 'string' ? Object.keys(FREE_MODELS).find((p) => FREE_MODELS[p].some((m) => m.id === entry)) : entry.provider;
    if (!provider) continue;
    const model = catalogFor(provider).find((m) => m.id === (typeof entry === 'string' ? entry : entry.id));
    if (model) add(provider, model);
  }
  for (const [provider, entry] of Object.entries(state.settings.keys || {})) {
    if (entry?.model && PROVIDERS[provider]) add(provider, { id: entry.model, name: entry.model });
  }
  return groups;
}

function renderDefaultModelSelect() {
  const select = $('#set-model');
  if (!select) return;
  const groups = modelChoices();
  const known = [...groups.values()].some((bucket) => bucket.has(state.model));
  select.innerHTML =
    (known ? '' : `<option value="${escapeHtml(state.model)}" selected>${escapeHtml(state.model)}</option>`) +
    [...groups.entries()]
      .map(
        ([provider, bucket]) =>
          `<optgroup label="${escapeHtml(PROVIDERS[provider]?.label || provider)}">${[...bucket.values()]
            .map((model) => `<option value="${escapeHtml(model.id)}" ${state.model === model.id ? 'selected' : ''}>${escapeHtml(model.name || model.id)}</option>`)
            .join('')}</optgroup>`,
      )
      .join('');
}

/**
 * The model picker.
 *
 * Two different questions live here, and mixing them is why model pickers are
 * usually confusing:
 *   • **Which model answers now?** — the select above, one choice, saved as
 *     `settings.model`.
 *   • **Which models may be tried?** — these checkboxes. A ticked model joins
 *     the fallback chain (`settings.modelPool`), so a router that refuses one
 *     model walks to the next ticked one inside the same request instead of
 *     failing the turn. Nothing ticked means "let the ranking decide".
 */
function renderModelPicker(host = $('#model-picker')) {
  if (!host) return;
  const providers = ['kilo', 'opencode'];
  for (const id of Object.keys(state.settings.keys || {})) if (PROVIDERS[id] && !providers.includes(id) && !PROVIDERS[id].offline) providers.push(id);

  host.innerHTML = providers
    .map((provider) => {
      const live = Boolean(state.settings.catalog?.[provider]?.length);
      const models = catalogFor(provider);
      return `<div class="model-group">
        <div class="model-group-head">
          <strong>${escapeHtml(PROVIDERS[provider]?.label || provider)}</strong>
          <span class="tag ${live ? 'ok' : ''}">${live ? 'live' : 'curated'}</span>
        </div>
        <div class="model-rows">
          ${models
            .map(
              (model) => `<div class="model-row ${poolHas(provider, model.id) ? 'on' : ''}">
                <label class="model-check" title="Try this model before the ranked fallbacks">
                  <input type="checkbox" data-pool-provider="${escapeHtml(provider)}" data-pool-model="${escapeHtml(model.id)}" ${poolHas(provider, model.id) ? 'checked' : ''}>
                </label>
                <div class="model-meta">
                  <span class="model-name">${escapeHtml(model.name || model.id)}</span>
                  <span class="model-id">${escapeHtml(model.id)}</span>
                </div>
                ${model.context ? `<span class="model-ctx">${Math.round(model.context / 1000)}K</span>` : ''}
                <button type="button" class="btn xs" data-use-model="${escapeHtml(model.id)}" data-use-provider="${escapeHtml(provider)}">Use</button>
              </div>`,
            )
            .join('')}
        </div>
      </div>`;
    })
    .join('');

  host.querySelectorAll('[data-pool-model]').forEach((input) => {
    input.onchange = async () => {
      const provider = input.dataset.poolProvider;
      const id = input.dataset.poolModel;
      const rest = modelPool().filter((entry) => (typeof entry === 'string' ? entry !== id : !(entry.id === id && entry.provider === provider)));
      const next = input.checked ? [...rest, { provider, id }] : rest;
      state.settings = await state.store.saveSettings({ modelPool: next });
      input.closest('.model-row')?.classList.toggle('on', input.checked);
      renderDefaultModelSelect();
      toast(input.checked ? `Will try ${id}` : `${id} removed from the fallback chain`, 'info', 2200);
    };
  });

  host.querySelectorAll('[data-use-model]').forEach((button) => {
    button.onclick = async () => {
      state.model = button.dataset.useModel;
      state.settings = await state.store.saveSettings({ model: state.model });
      renderDefaultModelSelect();
      renderChrome();
      toast(`Default model: ${state.model}`, 'ok', 2600);
    };
  });
}

/** Ask every reachable provider for its catalog, then redraw the picker. */
async function fetchModelCatalog({ onStatus = () => {} } = {}) {
  const targets = ['kilo', 'opencode'];
  for (const [id, entry] of Object.entries(state.settings.keys || {})) {
    if (entry?.key && PROVIDERS[id] && !PROVIDERS[id].offline && !targets.includes(id)) targets.push(id);
  }
  const catalog = { ...(state.settings.catalog || {}) };
  const report = [];
  for (const provider of targets) {
    const meta = PROVIDERS[provider];
    onStatus(`asking ${meta?.label || provider}…`);
    const result = await fetchModels({ provider, baseUrl: meta?.baseUrl || '', key: state.settings.keys?.[provider]?.key || '' });
    const models = mergeCatalog(provider, result.models);
    if (result.models.length) catalog[provider] = models.map((m) => m.id);
    report.push({
      provider,
      label: meta?.label || provider,
      count: result.models.length,
      source: result.models.length ? (result.relayed ? 'live · relay' : 'live') : 'curated',
      error: result.error,
    });
  }
  state.settings = await state.store.saveSettings({ catalog });
  onStatus(
    report
      .map((row) => `${row.label}: ${row.count ? `${row.count} models (${row.source})` : row.error || 'curated list'}`)
      .join(' · '),
  );
  renderModelPicker();
  return report;
}

function openSettings() {
  const body = $('#modal-body');
  const heading = $('#modal-title');
  if (heading) heading.textContent = 'Settings';
  const card = body.closest('.modal-card');
  if (card) card.classList.add('settings');

  const keys = state.settings.keys || {};
  const providerRows = Object.values(PROVIDERS)
    .filter((p) => !p.offline)
    .map(
      (p) => `<div class="field provider-field">
        <label for="key-${p.id}">${escapeHtml(p.label)} ${p.keyless ? '<span class="tag">keyless fallback</span>' : ''}</label>
        <div class="row">
          <input id="key-${p.id}" type="password" data-key="${p.id}" placeholder="${p.keyless ? 'optional — the free router needs no key' : 'API key'}" value="${keys[p.id]?.key ? '••••••••' : ''}" autocomplete="off">
          <input type="text" data-model="${p.id}" placeholder="model (optional)" value="${escapeHtml(keys[p.id]?.model || '')}" spellcheck="false">
        </div>
        <div class="hint">${p.note ? `${escapeHtml(p.note)} ` : ''}${p.docs ? `<a href="${p.docs}" target="_blank" rel="noopener">Get a key</a>` : ''}</div>
      </div>`,
    )
    .join('');

  const theme = currentTheme();
  const panes = {
    appearance: settingsCard(
      'Theme & layout',
      'Everything about the workspace lives in this browser, including how it looks.',
      `<div class="field"><label>Theme</label>
        <div class="row">
          <button class="btn ${theme === 'dark' ? 'primary' : ''}" data-theme-set="dark" data-icon="moon" data-icon-size="14">Dark</button>
          <button class="btn ${theme === 'light' ? 'primary' : ''}" data-theme-set="light" data-icon="sun" data-icon-size="14">Light</button>
        </div>
      </div>
      <div class="field"><label>Layout</label>
        <div class="row">
          <button class="btn ${state.settings.layout === 'code' ? '' : 'primary'}" data-layout-set="build">Build — chat and a big preview</button>
          <button class="btn ${state.settings.layout === 'code' ? 'primary' : ''}" data-layout-set="code">Code — files, terminal, narrow preview</button>
        </div>
      </div>`,
    ) + settingsCard(
      'Permission mode',
      'What the agent may do without asking. Plan mode is read-only.',
      `<select id="set-mode">
        <option value="default" ${state.mode === 'default' ? 'selected' : ''}>default — ask before shell &amp; deletes</option>
        <option value="accept-edits" ${state.mode === 'accept-edits' ? 'selected' : ''}>accept edits — auto-write files</option>
        <option value="plan" ${state.mode === 'plan' ? 'selected' : ''}>plan — read-only</option>
        <option value="bypass" ${state.mode === 'bypass' ? 'selected' : ''}>bypass — never ask</option>
      </select>`,
    ),

    models: settingsCard(
      'Default model',
      'The model that answers. Kilo Auto is the default because its free router keeps AlphaCode free — it picks the best free model per request.',
      `<select id="set-model"></select>
      <div class="row" style="margin-top:8px">
        <button class="btn" id="set-fetch-models" data-icon="refresh" data-icon-size="14">Fetch models</button>
        <span class="hint" id="model-fetch-status">Ask the routers what they serve right now.</span>
      </div>
      <div class="field" style="margin-top:10px"><label>Router health</label>
        <div class="hint" id="router-health-state">not checked yet</div>
        <div class="row"><button class="btn sm" id="set-probe-routers" data-icon="activity" data-icon-size="13">Check now</button></div>
      </div>`,
    ) + settingsCard(
      'Fallback chain',
      'Tick every model AlphaCode may fall back to. A router that refuses one model walks to the next ticked one inside the same request — that is how one request does more work instead of becoming three failed ones.',
      `<div id="model-picker" class="model-picker"></div>
      <div class="hint">Nothing ticked means the ranking decides, which is the right default for most people.</div>`,
    ) + settingsCard(
      'Requests &amp; behaviour',
      'Fewer requests carry more work — each one can run many tools.',
      `<div class="field"><label>Requests per turn</label>
        <select id="set-budget">
          ${[4, 6, 8, 12, 16].map((n) => `<option value="${n}" ${(Number(state.settings.requestBudget) || 8) === n ? 'selected' : ''}>${n} request${n === 1 ? '' : 's'}</option>`).join('')}
        </select>
        <div class="hint">How many times the agent may call the model before it pauses. 8 finishes most tasks, and a paused turn continues with one click.</div>
      </div>
      <label class="check"><input type="checkbox" id="set-demo" ${state.settings.demo !== false ? 'checked' : ''}> use the offline demo model when no provider answers</label>
      <label class="check"><input type="checkbox" id="set-autoverify" ${state.settings.autoVerify !== false ? 'checked' : ''}> fix preview errors automatically after a change</label>
      <label class="check"><input type="checkbox" id="set-autocontinue" ${state.settings.autoContinue !== false ? 'checked' : ''}> keep working past the request budget while it is making progress</label>`,
    ),

    providers: settingsCard(
      'Your own keys',
      'Requests go from this browser straight to the provider. Keys are stored only in this browser&rsquo;s IndexedDB — there is no AlphaCode server to leak them, and a keyed request never passes through the relay.',
      `<div class="fields">${providerRows}</div>`,
    ),

    runtimes: settingsCard(
      'What runs where',
      'Everything below executes inside this tab. First use downloads what it needs; after that it is cached.',
      `<div class="runtime-grid">
        ${Object.entries(RUNTIME_MATRIX)
          .map(([name, info]) => `<div class="runtime ${info.real ? 'real' : 'partial'}">
            <div class="row"><strong>${escapeHtml(name)}</strong>${info.real ? '<span class="tag ok">real</span>' : '<span class="tag">needs setup</span>'}</div>
            <div class="hint">${escapeHtml(info.how)}</div>
            <div class="hint dim">${escapeHtml(info.notes)}</div>
          </div>`)
          .join('')}
      </div>`,
    ) + settingsCard(
      'Native compilers — C, C++, Rust',
      'Compiles to WebAssembly in this tab, then runs it here. Nothing is uploaded.',
      `<label class="check"><input type="checkbox" id="set-wasm" ${state.settings.wasmCompilers ? 'checked' : ''}> enable in-browser compilers (WASM)</label>
      <div class="hint" id="compiler-state">${escapeHtml(toolchainStatus(state.settings).detail)}</div>
      <div class="field" style="margin-top:10px"><label for="set-cc">Compile endpoint (optional, most reliable)</label>
        <input type="text" id="set-cc" placeholder="https://your-compiler.example.com/compile" value="${escapeHtml(state.settings.cCompilerEndpoint || '')}" spellcheck="false">
        <div class="hint">A service you run that turns source into wasm32-wasi. It handles every language, including Rust, and keeps the tab light.</div>
      </div>
      <div class="row">
        <button class="btn" id="set-python" data-icon="cpu" data-icon-size="14">${state.pythonReady ? 'Python loaded' : 'Load Python now'}</button>
        <button class="btn" id="set-node" data-icon="terminal" data-icon-size="14">Check Node runtime</button>
      </div>`,
    ) + settingsCard(
      'Node sandbox — WebContainers',
      'Runs a real Node.js and npm in the tab, so Vite, Next and Express projects build and serve exactly as they do on a laptop.',
      `<label class="check"><input type="checkbox" id="set-webcontainer" ${state.settings.webcontainer ? 'checked' : ''}> enable the Node sandbox on this device</label>
      <ul class="sandbox-checks" id="wc-checks" aria-live="polite"><li class="sandbox-check">checking this browser…</li></ul>
      <div class="hint" id="wc-state">WebContainers needs a cross-origin isolated page, so the switch sets a cookie and reloads.</div>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="set-wc-boot" data-icon="play" data-icon-size="14">Boot Node sandbox</button>
        <button class="btn" id="set-wc-install" data-icon="package" data-icon-size="14">npm install</button>
        <button class="btn" id="set-wc-dev" data-icon="bolt" data-icon-size="14">npm run dev</button>
        <button class="btn" id="set-wc-recheck" data-icon="refresh" data-icon-size="14">Re-check</button>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="link" id="set-wc-newtab" data-icon="external" data-icon-size="13" hidden>Open AlphaCode in its own tab</button>
      </div>
      <div class="row" style="margin-top:8px">
        <span class="hint" id="wc-cache-state">no cached install</span>
        <div class="grow"></div>
        <button class="btn sm" id="set-wc-clear-cache" data-icon="trash" data-icon-size="13">Forget cached installs</button>
      </div>
      <pre class="wc-log" id="wc-log" aria-live="polite"></pre>
      <div class="hint">The switch reloads the tab with two extra headers (COOP/COEP). While they are on, OAuth pop-ups open as tabs and a few cross-origin images in a generated preview may need CORS — turn it off when you are done. Safari cannot boot WebContainers yet.</div>`,
    ),

    packages: settingsCard(
      'npm',
      'Installs run in this tab and land in the project — and in a mounted folder.',
      `<div class="field"><label for="set-npm-engine">Install engine</label>
        <select id="set-npm-engine">
          <option value="builtin" ${(state.settings.npmEngine || 'builtin') === 'builtin' ? 'selected' : ''}>Built-in — fast resolver, registry only</option>
          <option value="nodepod" ${state.settings.npmEngine === 'nodepod' ? 'selected' : ''}>Full npm — Nodepod (semver ranges, transitive, dev + optional, workspaces)</option>
        </select>
        <div class="hint" id="npm-engine-state">checking the full engine…</div>
      </div>
      <div class="field"><label for="set-npm-registry">Registry</label>
        <input type="url" id="set-npm-registry" placeholder="https://registry.npmjs.org" value="${escapeHtml(state.settings.npmRegistry || '')}" spellcheck="false">
        <div class="hint">Leave blank for the public registry. A mirror or a private registry&rsquo;s read URL works too.</div>
      </div>
      <div class="row">
        <button class="btn" id="set-npm-install" data-icon="package" data-icon-size="14">npm install</button>
        <button class="btn" id="set-npm-list" data-icon="boxes" data-icon-size="14">Installed packages</button>
      </div>
      <div class="hint">Missing the full engine? Run <code>npm run vendor:nodepod</code> and rebuild — it is not committed because it is 5 MB of someone else&rsquo;s code.</div>`,
    ),

    mcp: settingsCard(
      'Remote MCP servers',
      'Connect Gemini, Claude, GitHub, Linear… Their tools appear to the agent as <code>mcp__server__tool</code>. Requests go straight from this browser to the server.',
      `<div id="mcp-list">${(state.settings.mcp || [])
        .map(
          (server, index) => `<div class="field mcp-row">
          <div class="row">
            <input type="text" data-mcp-name="${index}" placeholder="name" value="${escapeHtml(server.name || '')}">
            <input type="text" data-mcp-url="${index}" placeholder="https://server.example.com/mcp" value="${escapeHtml(server.url || '')}">
            <button class="icon-btn sm" data-mcp-remove="${index}" data-icon="trash" title="Remove" aria-label="Remove server"></button>
          </div>
          <div class="row">
            <input type="password" data-mcp-token="${index}" placeholder="Bearer token (optional)" value="${server.token ? '••••••' : ''}" autocomplete="off">
            <label class="check"><input type="checkbox" data-mcp-relay="${index}" ${server.useRelay ? 'checked' : ''}> route through relay (CORS)</label>
          </div>
        </div>`,
        )
        .join('')}</div>
      <div class="row">
        <button class="btn" id="set-mcp-add" data-icon="plus">Add server</button>
        <button class="btn primary" id="set-mcp-connect" data-icon="link">Connect all</button>
      </div>
      <div class="hint" id="mcp-state">${state.mcp.clients.length ? `connected: ${state.mcp.clients.map((c) => c.name).join(', ')}` : 'none connected'}</div>`,
    ),

    hooks: settingsCard(
      'Project hooks',
      'Hooks live in <code>.alphacode/hooks.js</code>. A hook can block a tool, rewrite its arguments, or add a note for the model — the browser equivalent of Claude Code&rsquo;s hooks.',
      `<textarea id="set-hooks" class="editor" spellcheck="false" placeholder="export default { pre_tool: [{ match: 'bash', run: () => ({ block: 'no shell' }) }] }">${escapeHtml(state.settings.hooks || '')}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn" id="set-hooks-save" data-icon="save" data-icon-size="14">Save hooks</button><span class="hint">Saved in this browser and reapplied on the next turn.</span></div>`,
    ),

    data: settingsCard(
      'Your data',
      'Projects, files and keys live in this browser. Export before clearing site data.',
      `<div class="row">
        <button class="btn" id="set-export" data-icon="download" data-icon-size="14">Export all projects</button>
        <button class="btn danger" id="set-wipe" data-icon="trash" data-icon-size="14">Delete everything</button>
      </div>`,
    ),
  };

  body.innerHTML = `
    <div class="set-shell">
      <nav class="set-nav" role="tablist" aria-label="Settings sections">
        ${SETTINGS_TABS.map(
          (tab, index) => `<button class="set-tab ${index === 0 ? 'is-active' : ''}" role="tab" data-tab="${tab.id}" aria-selected="${index === 0}" aria-controls="pane-${tab.id}">
            ${icon(tab.icon, 15)}<span>${tab.label}</span>
          </button>`,
        ).join('')}
      </nav>
      <div class="set-panes">
        ${SETTINGS_TABS.map(
          (tab, index) => `<div class="set-pane ${index === 0 ? 'is-active' : ''}" id="pane-${tab.id}" data-pane="${tab.id}" role="tabpanel">${panes[tab.id] || ''}</div>`,
        ).join('')}
      </div>
    </div>`;

  const selectTab = (id) => {
    body.querySelectorAll('.set-tab').forEach((tab) => {
      const active = tab.dataset.tab === id;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    body.querySelectorAll('.set-pane').forEach((pane) => pane.classList.toggle('is-active', pane.dataset.pane === id));
    body.querySelector('.set-panes')?.scrollTo?.({ top: 0 });
  };
  body.querySelectorAll('.set-tab').forEach((tab) => {
    tab.onclick = () => selectTab(tab.dataset.tab);
  });

  renderDefaultModelSelect();
  renderModelPicker();

  $('#modal').hidden = false;
  paintIcons(body);

  /* ---------------------------------------------------------- appearance -- */

  body.querySelectorAll('[data-theme-set]').forEach((button) => {
    button.onclick = () => {
      applyTheme(button.dataset.themeSet);
      body.querySelectorAll('[data-theme-set]').forEach((other) => other.classList.toggle('primary', other === button));
    };
  });
  body.querySelectorAll('[data-layout-set]').forEach((button) => {
    button.onclick = () => {
      setLayout(button.dataset.layoutSet);
      body.querySelectorAll('[data-layout-set]').forEach((other) => other.classList.toggle('primary', other === button));
    };
  });

  /* -------------------------------------------------------------- models -- */

  const paintRouterHealthRow = () => {
    const node = $('#router-health-state');
    if (!node) return;
    const report = describeProbe(state.routerHealth);
    const [firstLine] = String(report.detail || '').split('\n');
    node.textContent = state.routerHealth ? `${report.label} — ${firstLine}` : report.detail;
    node.className = 'hint';
    node.dataset.tone = report.tone;
  };
  paintRouterHealthRow();
  $('#set-probe-routers')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await refreshRouterHealth({ force: true });
      paintRouterHealthRow();
      toast('Router health refreshed', 'info', 2400);
    } finally {
      button.disabled = false;
    }
  });

  $('#set-fetch-models')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const status = $('#model-fetch-status');
    button.disabled = true;
    try {
      await fetchModelCatalog({ onStatus: (text) => status && (status.textContent = text) });
      toast('Model list refreshed', 'ok', 2600);
    } catch (err) {
      if (status) status.textContent = `could not fetch models: ${err.message}`;
    } finally {
      button.disabled = false;
    }
  });

  $('#set-model').onchange = async (e) => {
    state.model = e.target.value;
    state.settings = await state.store.saveSettings({ model: state.model });
    renderChrome();
    toast(`Default model: ${state.model}`, 'ok', 2400);
  };
  $('#set-mode').onchange = async (e) => {
    state.mode = e.target.value;
    state.settings = await state.store.saveSettings({ mode: state.mode });
    $('#btn-mode').textContent = `mode: ${state.mode}`;
  };
  $('#set-demo').onchange = async (e) => {
    state.settings = await state.store.saveSettings({ demo: e.target.checked });
  };
  const budgetSelect = $('#set-budget');
  if (budgetSelect) {
    budgetSelect.onchange = async () => {
      const value = Number(budgetSelect.value) || 8;
      state.settings = await state.store.saveSettings({ requestBudget: value });
      const governor = getGovernor();
      governor.budget = value;
      toast(`Up to ${value} model requests per turn`, 'info', 2600);
    };
  }
  const verifyToggle = $('#set-autoverify');
  if (verifyToggle) {
    verifyToggle.onchange = async () => {
      state.settings = await state.store.saveSettings({ autoVerify: verifyToggle.checked });
    };
  }
  const continueToggle = $('#set-autocontinue');
  if (continueToggle) {
    continueToggle.onchange = async () => {
      state.settings = await state.store.saveSettings({ autoContinue: continueToggle.checked });
      toast(continueToggle.checked ? 'Long tasks will keep going' : 'A turn will stop at its first budget', 'info', 2600);
    };
  }

  /* ----------------------------------------------------------- providers -- */

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

  /* ------------------------------------------------------------ runtimes -- */

  $('#set-cc').onchange = async (e) => {
    state.settings = await state.store.saveSettings({ cCompilerEndpoint: e.target.value.trim() });
    const stateNode = $('#compiler-state');
    if (stateNode) stateNode.textContent = toolchainStatus(state.settings).detail;
  };
  const wasmToggle = $('#set-wasm');
  if (wasmToggle) {
    wasmToggle.onchange = async () => {
      state.settings = await state.store.saveSettings({ wasmCompilers: wasmToggle.checked });
      const stateNode = $('#compiler-state');
      if (stateNode) stateNode.textContent = toolchainStatus(state.settings).detail;
      toast(wasmToggle.checked ? 'C, C++ and Rust can compile in this tab' : 'In-browser compilers off', 'info', 2800);
    };
  }
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

  /* -------------------------------------------------------- node sandbox -- */

  /**
   * The sandbox is the one feature that can fail for four unrelated reasons, so
   * the panel shows the requirements themselves instead of one red line. Each
   * row is a check `inspectSandbox()` made a moment ago.
   */
  const paintSandboxChecks = (report) => {
    const list = $('#wc-checks');
    if (list) {
      list.innerHTML = report.checks
        .map(
          (check) =>
            `<li class="sandbox-check ${check.ok ? 'ok' : 'fail'}">
              <span class="sandbox-mark" data-icon="${check.ok ? 'check-circle' : 'alert'}" data-icon-size="13"></span>
              <span class="sandbox-label">${escapeHtml(check.label)}</span>
              <span class="sandbox-detail">${escapeHtml(check.detail || '')}</span>
            </li>`,
        )
        .join('');
      paintIcons(list);
    }
    const status = $('#wc-state');
    if (status) {
      status.textContent = report.ok
        ? 'Ready — booting a container only needs a click. The first boot downloads the runtime (≈3 MB, cached).'
        : report.hint;
      status.className = `hint ${report.ok ? 'ok' : ''}`;
    }
    const boot = $('#set-wc-boot');
    if (boot) {
      boot.disabled = !report.ok;
      boot.title = report.ok ? '' : report.blockers.map((b) => b.label).join(', ');
    }
    const newTab = $('#set-wc-newtab');
    if (newTab) newTab.hidden = !(report.framed && !report.isolated);
    return report;
  };

  let sandboxReport = { ok: false, checks: [], blockers: [], hint: '' };
  const refreshSandbox = async () => {
    sandboxReport = await inspectSandbox().catch(() => ({ ok: false, checks: [], blockers: [], hint: 'could not inspect this browser' }));
    return paintSandboxChecks(sandboxReport);
  };

  const wcToggle = $('#set-webcontainer');
  if (wcToggle) {
    wcToggle.onchange = async () => {
      const on = wcToggle.checked;
      state.settings = await state.store.saveSettings({ webcontainer: on });
      // Isolation is decided by response headers, so the tab has to reload for
      // the switch to mean anything. That is also the honest UX: the user sees
      // exactly when the headers change.
      setIsolationCookie(on);
      toast(on ? 'Reloading with the Node sandbox enabled…' : 'Reloading without the Node sandbox…', 'info', 2400);
      setTimeout(() => location.reload(), 800);
    };
    refreshSandbox();
  }
  const wcLog = (text) => {
    const node = $('#wc-log');
    if (!node) return;
    node.textContent += text;
    if (node.textContent.length > 20_000) node.textContent = node.textContent.slice(-16_000);
    node.scrollTop = node.scrollHeight;
  };
  const wcStatus = (text) => {
    const node = $('#wc-state');
    if (node) node.textContent = text;
  };
  const wcBoot = async () => {
    if (state.wc?.instance) return state.wc.instance;
    // Re-check rather than trusting the panel: the user may have opened this tab
    // before turning the switch on, and the headers only change on reload.
    const report = await refreshSandbox();
    if (!report.ok) {
      throw new SandboxUnavailable(`the sandbox cannot start here: ${report.blockers.map((b) => b.label).join(', ')}`, {
        hint: report.hint,
        blockers: report.blockers,
      });
    }
    const files = await state.fs.snapshot(state.project.id).catch(() => ({}));
    wcStatus('booting the container…');
    const instance = await bootWebContainer({
      files,
      inspect: report,
      onOutput: wcLog,
      onServerReady: (url) => {
        wcStatus(`dev server live at ${url}`);
        showContainerPreview(url);
      },
      onFileWritten: (filePath, contents) => state.fs.write(state.project.id, filePath, contents).catch(() => {}),
    });
    state.wc = { instance, fingerprint: projectFingerprint(files) };

    // A container is memory: closing the tab used to mean paying for `npm
    // install` again. The installed tree is snapshotted in OPFS and mounted back
    // when the manifest has not changed.
    if (state.wc.fingerprint) {
      const cached = await loadContainerCache(state.wc.fingerprint).catch(() => null);
      if (cached) {
        wcStatus('restoring dependencies from the last install…');
        wcLog(`\nrestoring ${Object.keys(cached.files).length} files from the cached install…\n`);
        await instance.mount(treeFromFlatFiles(cached.files)).catch(() => {});
        state.wc.restored = true;
        wcLog(`restored — dependencies are already installed (${bytes(cached.bytes)})\n`);
        wcStatus('dependencies restored from the last install — run npm run dev');
        return instance;
      }
    }
    wcStatus('container ready — run npm install');
    return instance;
  };
  const paintCacheState = async () => {
    const node = $('#wc-cache-state');
    if (!node) return;
    const size = await containerCacheSize().catch(() => ({ files: 0, bytes: 0 }));
    node.textContent = size.files
      ? `${size.files} cached install${size.files === 1 ? '' : 's'} · ${bytes(size.bytes)} — matching projects skip npm install`
      : 'no cached install yet — one is written after a successful npm install';
  };
  paintCacheState();
  $('#set-wc-clear-cache')?.addEventListener('click', async () => {
    const removed = await clearContainerCaches().catch(() => 0);
    if (state.wc) state.wc.restored = false;
    toast(removed ? `Cleared ${removed} cached install${removed === 1 ? '' : 's'}` : 'Nothing to clear', 'info', 3000);
    paintCacheState();
  });
  $('#set-wc-recheck')?.addEventListener('click', () => {
    refreshSandbox();
    toast('Sandbox requirements re-checked', 'info', 2200);
  });
  $('#set-wc-newtab')?.addEventListener('click', () => {
    window.open(location.href, '_blank', 'noopener');
  });
  $('#set-wc-boot')?.addEventListener('click', async () => {
    try {
      await wcBoot();
      toast('WebContainer is running real Node in this tab', 'ok', 3200);
    } catch (err) {
      wcStatus(`${err.message}${err.hint ? ` ${err.hint}` : ''}`);
      toast(err.message, 'err', 5000);
    }
  });
  $('#set-wc-install')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const instance = await wcBoot();
      const { exitCode } = await installInContainer(instance, { onOutput: wcLog });
      if (exitCode === 0) {
        wcStatus('dependencies installed inside the container');
        await cacheInstalledModules(instance);
      } else {
        wcStatus(`npm install exited ${exitCode} — see the log`);
      }
    } catch (err) {
      wcStatus(`${err.message}${err.hint ? ` ${err.hint}` : ''}`);
    } finally {
      button.disabled = false;
    }
  });
  $('#set-wc-dev')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const instance = await wcBoot();
      wcStatus('starting the dev server…');
      const { url } = await startDevInContainer(instance, { onOutput: wcLog });
      wcStatus(url ? `dev server live at ${url}` : 'no server reported a URL — see the log');
    } catch (err) {
      wcStatus(`${err.message}${err.hint ? ` ${err.hint}` : ''}`);
    } finally {
      button.disabled = false;
    }
  });

  /* ------------------------------------------------------------ packages -- */

  const engineSelect = $('#set-npm-engine');
  if (engineSelect) {
    engineSelect.onchange = async () => {
      state.settings.npmEngine = engineSelect.value;
      await state.store.saveSettings({ npmEngine: engineSelect.value });
      if (state.node) state.node.npmEngine = engineSelect.value;
      toast(engineSelect.value === 'nodepod' ? 'npm will use the full engine' : 'npm will use the built-in resolver', 'info', 3200);
      refreshNpmEngineState();
    };
    refreshNpmEngineState();
  }
  const registryInput = $('#set-npm-registry');
  if (registryInput) {
    registryInput.onchange = async () => {
      const value = registryInput.value.trim().replace(/\/+$/, '');
      state.settings.npmRegistry = value;
      await state.store.saveSettings({ npmRegistry: value });
      if (state.node) state.node.npmRegistry = value;
      toast(value ? `npm will use ${value}` : 'npm will use the public registry', 'info', 3400);
    };
  }
  $('#set-npm-install')?.addEventListener('click', () => {
    $('#modal').hidden = true;
    runNpmInstall();
  });
  $('#set-npm-list')?.addEventListener('click', () => {
    $('#modal').hidden = true;
    runShellLine('npm ls');
  });

  /* ----------------------------------------------------------------- mcp -- */

  $('#set-mcp-add').onclick = async () => {
    const list = [...(state.settings.mcp || []), { name: '', url: '', headers: {} }];
    state.settings = await state.store.saveSettings({ mcp: list });
    openSettings();
    selectTab('mcp');
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
      selectTab('mcp');
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

  /* --------------------------------------------------------------- hooks -- */

  $('#set-hooks-save').onclick = async () => {
    state.settings = await state.store.saveSettings({ hooks: $('#set-hooks').value });
    state.hooks = await loadHooks({ fs: state.fs, projectId: state.project.id, settings: state.settings }).catch(() => null);
    toast('Hooks saved', 'ok');
  };

  /* ---------------------------------------------------------------- data -- */

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
  // On a phone the bottom bar must never point at a pane that cannot show the
  // view that was just selected — that is a blank screen. This only moves the
  // pane; the view is already what the caller asked for.
  syncPaneToView(view);
}

const MODE_INFO = {
  default: ['default', 'Asks before shell commands and deletes'],
  'accept-edits': ['accept edits', 'Writes files without asking'],
  plan: ['plan', 'Read-only — proposes instead of changing'],
  bypass: ['bypass', 'Never asks. Use with care'],
};

/**
 * Which free routers actually answer right now.
 *
 * One `GET /models` per keyless router, no chat request and no tokens, so it is
 * cheap enough to run on boot and after a turn that had to fall back. The result
 * paints a chip in the status pill; nothing else in the app depends on it, so a
 * probe that fails simply leaves the chip showing the previous answer.
 */
async function refreshRouterHealth({ force = false } = {}) {
  const now = Date.now();
  if (!force && state.routerProbedAt && now - state.routerProbedAt < 5 * 60_000) return state.routerHealth;
  const providers = [];
  for (const id of ['kilo', 'opencode']) {
    const meta = PROVIDERS[id];
    if (meta) providers.push({ id, baseUrl: meta.baseUrl, key: state.settings.keys?.[id]?.key || '' });
  }
  for (const [id, entry] of Object.entries(state.settings.keys || {})) {
    if (entry?.key && PROVIDERS[id] && !PROVIDERS[id].offline) providers.push({ id, baseUrl: PROVIDERS[id].baseUrl, key: entry.key });
  }
  try {
    state.routerHealth = await probeModels(providers);
  } catch {
    state.routerHealth = { state: 'unknown', providers: [], liveCount: 0, checkedAt: now };
  }
  state.routerProbedAt = Date.now();
  paintRouterHealth();
  return state.routerHealth;
}

function paintRouterHealth() {
  const chip = $('#status-router');
  if (!chip) return;
  const report = describeProbe(state.routerHealth);
  chip.hidden = !state.routerHealth;
  chip.dataset.tone = report.tone;
  chip.textContent = report.label;
  const pill = $('#status-pill');
  if (pill) pill.title = `${report.detail}`.trim();
}

function renderChrome() {
  const modelName = state.model.split('/').pop();
  const chip = $('#chip-model-txt');
  if (chip) chip.textContent = modelName;
  const modelBtn = $('#btn-model');
  if (modelBtn) modelBtn.title = `Model: ${state.model} — click to change`;
  const [modeName, modeHint] = MODE_INFO[state.mode] || MODE_INFO.default;
  const label = $('#mode-label');
  if (label) label.textContent = modeName;
  const modeBtn = $('#btn-mode');
  if (modeBtn) {
    modeBtn.title = `${modeHint} — ⇧Tab to cycle`;
    modeBtn.classList.toggle('warn', state.mode === 'bypass');
  }
  const hint = $('#status-hint');
  if (hint) {
    const ready = ['node', 'python', 'npm'].filter((name) => RUNTIME_MATRIX[name]?.real);
    hint.textContent = `${ready.length} runtimes`;
    hint.title = ready.map((name) => `${name} — ${RUNTIME_MATRIX[name].how}`).join('\n');
  }
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
  syncSendState();
}

/** The send button is only "on" when there is something to send. */
function syncSendState() {
  const button = $('#btn-send');
  const prompt = $('#prompt');
  const hasAttachments = Boolean(state.attachments?.length);
  if (button) button.disabled = state.running || !(prompt?.value.trim() || hasAttachments);
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
    syncSendState();
  });
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      send(ta.value);
    }
  });
  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      if (!$('#palette').hidden) {
        $('#palette').hidden = true;
        return;
      }
      if (state.running) state.run?.stop();
      $('#modal').hidden = true;
      $('#template-sheet').hidden = true;
      $('#runtime-panel').hidden = true;
    }
    if (meta && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openPalette();
      return;
    }
    if (meta && e.key === '/') {
      e.preventDefault();
      $('#prompt').focus();
      return;
    }
    if (meta && e.shiftKey && (e.key === '1' || e.key === '2')) {
      e.preventDefault();
      setLayout(e.key === '1' ? 'build' : 'code');
      return;
    }
    if (meta && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      toggleTheme();
      return;
    }
    if (meta && e.shiftKey && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      $('#btn-history').click();
      return;
    }
    if (meta && e.shiftKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      $('#template-sheet').hidden = false;
      return;
    }
    if (meta && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      setView('terminal');
      return;
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
  $('#btn-theme').onclick = () => toggleTheme();
  $('#btn-theme-m').onclick = () => toggleTheme();
  $('#btn-history-m').onclick = () => $('#btn-history').click();
  $('#btn-settings-m').onclick = () => {
    $('#sidebar').classList.remove('open');
    $('#scrim').hidden = true;
    openSettings();
  };
  $('#btn-command').onclick = () => openPalette();
  $('#btn-help').onclick = () => openShortcuts();
  $('#status-pill').onclick = (event) => {
    event.stopPropagation();
    const panel = $('#runtime-panel');
    if (panel.hidden) renderRuntimePanel();
    else panel.hidden = true;
  };
  document.addEventListener('click', (event) => {
    const panel = $('#runtime-panel');
    if (!panel.hidden && !panel.contains(event.target) && !event.target.closest('#status-pill')) panel.hidden = true;
  });
  $('#btn-preview-collapse').onclick = () => setPreviewVisible($('#app').dataset.pane === 'preview-hidden');
  $('#btn-preview-toggle').onclick = () => {
    // On a phone the toggle is a pane switch: there is no room for two columns,
    // and "hide the preview" behind a bar you cannot reach was the old dead end.
    if (isMobile()) {
      setPreviewVisible(true);
      setMobilePane('preview');
      return;
    }
    setPreviewVisible($('#app').dataset.pane === 'preview-hidden');
  };
  $('#btn-empty-template').onclick = () => ($('#template-sheet').hidden = false);
  wirePalette();
  applyTheme(currentTheme(), { persist: false });
  $('#btn-close-modal').onclick = () => ($('#modal').hidden = true);
  $('#modal').onclick = (e) => {
    if (e.target.id === 'modal') $('#modal').hidden = true;
  };
  $('#btn-export').onclick = exportProject;
  $('#btn-preview').onclick = () => doDeploy('preview');
  $('#btn-refresh-files').onclick = () => refreshFiles();
  $('#btn-attach').onclick = () => pickAttachment();
  $('#activity-head').onclick = () => {
    markToggled();
    const panel = $('#activity-panel');
    const collapsed = panel.classList.toggle('collapsed');
    $('#activity-head').setAttribute('aria-expanded', String(!collapsed));
    if (!collapsed) $('#activity-scroll').scrollTop = $('#activity-scroll').scrollHeight;
  };
  bindTermKeys();
  bindTerminalResize();
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
    if (state.running) {
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
    // doDeploy reports its own blockers and returns without pushing.
    if (!result?.ok) return;
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
window.__alphacode = { state, send, handleEvent, setView, send2: send, resume: resumeTurn, refreshPreview };

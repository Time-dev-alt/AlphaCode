/**
 * The workspace: everything around the chat.
 *
 *   • a live preview that rebuilds itself after every agent turn
 *   • device sizes, an element picker ("click the thing you want changed")
 *   • a console that catches the preview's errors and hands them to the agent
 *   • templates, version history, background-job strip, Build/Code layouts
 *
 * Kept separate from main.js so the agent loop stays readable: this file only
 * renders and calls back into the app.
 */
import { $, $$, el, icon, escapeHtml, toast as uiToast, timeAgo } from './ui.js';
import { bundlePreview } from '../engine/deploy.js';
import { VISUAL_ACTIONS, visualEditPrompt, visualEditSummary } from '../engine/agent/visual.js';

const api = {};
const previewState = { device: 'desktop', picking: false, errors: [], lastHtml: '', lastUrl: '', renderedAt: 0 };

export function mountWorkspace(deps) {
  Object.assign(api, deps);
  bindLayout();
  bindPreviewBar();
  bindConsole();
  bindHistory();
  bindTemplates();
  bindSuggestions();
  bindMobilePanes();
  renderTemplates();
}

/* ----------------------------------------------------------------- layout -- */

function bindLayout() {
  const app = $('#app');
  for (const button of $$('#layout-switch .switch-btn')) {
    button.onclick = () => setLayout(button.dataset.layout);
  }
  const saved = api.getState?.().settings?.layout;
  if (saved) setLayout(saved, { silent: true });
  app.dataset.mobilePane = 'chat';
}

export function setLayout(layout, { silent = false } = {}) {
  const app = $('#app');
  app.dataset.layout = layout;
  for (const button of $$('#layout-switch .switch-btn')) {
    const active = button.dataset.layout === layout;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  // The mode decides which surface is in front: Build is the conversation,
  // Code is the workspace. Remembering the view is more useful than resetting it.
  const view = api.getState?.().view;
  if (layout === 'code' && view === 'chat' && api.setView) api.setView('files');
  if (layout === 'build' && view !== 'chat' && view !== 'deploy' && api.setView) api.setView('chat');
  if (!silent) api.saveSettings?.({ layout });
  window.dispatchEvent(new window.CustomEvent('alphacode:layout', { detail: layout }));
}

/* ---------------------------------------------------------------- preview -- */

function bindPreviewBar() {
  for (const button of $$('[data-device]')) {
    button.onclick = () => setDevice(button.dataset.device);
  }
  const refresh = $('#btn-preview-refresh');
  if (refresh) refresh.onclick = () => refreshPreview({ force: true });
  $('#btn-preview-open').onclick = () => {
    if (!previewState.lastHtml) {
      uiToast('Nothing to open yet — ask for something first', 'warn');
      return;
    }
    const blob = new Blob([previewState.lastHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  $('#btn-pick').onclick = () => togglePicker();
  const rebuild = $('#btn-preview');
  if (rebuild) rebuild.onclick = () => refreshPreview({ force: true });
  for (const id of ['#btn-publish', '#btn-publish-top']) {
    const button = $(id);
    if (button) button.onclick = () => api.onPublish?.();
  }

  window.addEventListener('message', onPreviewMessage);
}

export function setDevice(device) {
  previewState.device = device;
  $('#preview-stage').dataset.device = device;
  for (const button of $$('[data-device]')) {
    const active = button.dataset.device === device;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function togglePicker(force) {
  previewState.picking = force ?? !previewState.picking;
  const frame = $('#preview-frame');
  $('#btn-pick').classList.toggle('active', previewState.picking);
  frame?.contentWindow?.postMessage(previewState.picking ? '__alpha:pick' : '__alpha:pick:off', '*');
  if (previewState.picking) uiToast('Click anything in the preview to describe a change', 'info');
}

/** Instrumentation injected into every preview: errors, console, element picker. */
const HARNESS = `<script>(function(){
  // The preview runs in an opaque-origin sandbox, so localStorage/cookies throw.
  // Give generated pages an in-memory stand-in instead of a crash.
  // Detect an opaque origin instead of probing storage: touching localStorage
  // throws a SecurityError that the browser still reports in DevTools even
  // though it is caught, and a preview full of red is not a good first look.
  var opaqueOrigin = true;
  try{ opaqueOrigin = self.origin === 'null' || !self.origin; }catch(_){ opaqueOrigin = true; }
  if(opaqueOrigin){
    var mem=Object.create(null);
    var shim={getItem:function(k){return k in mem?mem[k]:null},setItem:function(k,v){mem[k]=String(v)},removeItem:function(k){delete mem[k]},clear:function(){mem=Object.create(null)},key:function(i){var k=Object.keys(mem)[i];return k===undefined?null:k}};
    Object.defineProperty(shim,'length',{get:function(){return Object.keys(mem).length}});
    try{ Object.defineProperty(window,'localStorage',{configurable:true,get:function(){return shim}}); }catch(_){}
    try{ Object.defineProperty(window,'sessionStorage',{configurable:true,get:function(){return shim}}); }catch(_){}
  }
  var send=function(m){try{parent.postMessage({__alpha:1,...m},'*')}catch(e){}};
  window.addEventListener('error',function(e){send({type:'error',message:String(e.message||'script error'),line:e.lineno,column:e.colno,stack:e.error&&e.error.stack?String(e.error.stack).slice(0,1200):''})});
  window.addEventListener('unhandledrejection',function(e){send({type:'error',message:'Unhandled promise rejection: '+String(e.reason&&e.reason.message||e.reason)})});
  var ce=console.error;console.error=function(){send({type:'log',level:'error',text:Array.prototype.map.call(arguments,String).join(' ')});ce.apply(console,arguments)};
  var cw=console.warn;console.warn=function(){send({type:'log',level:'warn',text:Array.prototype.map.call(arguments,String).join(' ')});cw.apply(console,arguments)};
  var picking=false;
  addEventListener('message',function(e){ if(e.data==='__alpha:pick'){picking=true;document.documentElement.style.cursor='crosshair'} if(e.data==='__alpha:pick:off'){picking=false;document.documentElement.style.cursor=''} });
  function selector(el){ if(!el||el.nodeType!==1) return ''; if(el.id) return '#'+el.id; var parts=[]; while(el&&el.nodeType===1&&parts.length<4){ var s=el.tagName.toLowerCase(); var cls=(typeof el.className==='string'?el.className:'').trim().split(/\\s+/).filter(Boolean).slice(0,2); if(cls.length) s+='.'+cls.join('.'); parts.unshift(s); el=el.parentElement } return parts.join(' > ') }
  document.addEventListener('click',function(e){ if(!picking) return; e.preventDefault(); e.stopPropagation(); picking=false; document.documentElement.style.cursor='';
    var t=e.target; send({type:'pick',selector:selector(t),tag:t.tagName.toLowerCase(),text:String(t.textContent||'').trim().slice(0,140),html:String(t.outerHTML||'').slice(0,800),rect:{w:Math.round(t.getBoundingClientRect().width),h:Math.round(t.getBoundingClientRect().height)}});
  },true);
})();<\/script>`;

export async function refreshPreview({ force = false } = {}) {
  if (!api.getState?.().project) return;
  const frame = $('#preview-frame');
  const empty = $('#preview-empty');
  try {
    const files = await api.getState().fs.snapshot(api.getState().project.id);
    if (!Object.keys(files).some((f) => f.endsWith('.html'))) {
      frame.hidden = true;
      empty.hidden = false;
      return;
    }
    const html = bundlePreview(files, 'index.html');
    if (!force && html === previewState.lastHtml) return;
    previewState.lastHtml = html;
    previewState.errors = [];
    updateConsole();
    frame.srcdoc = injectHarness(html);
    previewState.renderedAt = Date.now();
    frame.hidden = false;
    empty.hidden = true;
    const slug = api.getState().project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
    const title = $('#preview-title');
    if (title) title.textContent = slug;
    const url = document.querySelector('#frame-url');
    if (url) url.textContent = `${slug}.local`;
    $('#status-dot')?.classList.remove('busy');
  } catch (err) {
    frame.hidden = true;
    empty.hidden = false;
    previewState.errors = [{ message: err.message, kind: 'preview' }];
    updateConsole();
  }
}

const injectHarness = (html) => {
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${HARNESS}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body([^>]*)>/i, `<body$1>${HARNESS}`);
  return HARNESS + html;
};

function onPreviewMessage(event) {
  const data = event.data;
  if (!data || data.__alpha !== 1) return;
  if (data.type === 'error') {
    pushError({ message: data.message, where: data.line ? `line ${data.line}` : '', stack: data.stack || '', kind: 'runtime' });
  } else if (data.type === 'log' && data.level === 'error') {
    pushError({ message: data.text, kind: 'console' });
  } else if (data.type === 'pick') {
    togglePicker(false);
    const describe = `In ${data.selector || data.tag}, change: `;
    const prompt = $('#prompt');
    if (prompt) {
      setPrompt(prompt, describe);
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    }
    previewState.lastPick = data;
    renderVisualEdit(data);
    api.toast?.(`Selected ${data.tag}${data.selector ? ` · ${data.selector}` : ''} — or adjust it here`, 'info');
  }
}

/* ---------------------------------------------------------- visual edits -- */

/**
 * Lovable's best interaction, in the composer: pick an element in the preview
 * and adjust it without writing a prompt.
 *
 * Each choice produces a precise, single-file instruction, so the whole edit is
 * one model request. The free-text box stays for everything the quick actions
 * do not cover.
 */
function renderVisualEdit(target) {
  const bar = $('#visual-edit');
  if (!bar) return;
  bar.innerHTML = '';
  bar.hidden = false;

  const head = el('div', { class: 've-head' });
  head.append(
    el('span', { class: 've-tag', text: `<${target.tag}>` }),
    el('span', { class: 've-where', text: target.selector || '', title: target.selector || '' }),
  );
  const close = el('button', { class: 've-close', type: 'button', 'aria-label': 'Cancel selection' });
  close.innerHTML = icon('close', 12);
  close.onclick = () => {
    bar.hidden = true;
    bar.innerHTML = '';
    previewState.lastPick = null;
  };
  head.append(close);

  const actions = el('div', { class: 've-actions' });
  for (const action of VISUAL_ACTIONS) {
    const button = el('button', { class: 've-action', type: 'button', text: action.label, 'data-action': action.id });
    button.onclick = () => openVisualInput(bar, target, action);
    actions.append(button);
  }

  bar.append(head, actions);
  api.onVisualEdit?.(true);
}

/** Second step: one value, then done. */
function openVisualInput(bar, target, action) {
  const row = el('div', { class: 've-input' });
  const needsValue = action.id !== 'hide' && action.id !== 'delete';

  const apply = (value) => {
    if (needsValue && !String(value || '').trim()) return;
    const prompt = visualEditPrompt(target, { action: action.id, value });
    bar.hidden = true;
    bar.innerHTML = '';
    previewState.lastPick = null;
    api.onVisualEdit?.(false);
    switchToChat();
    setPromptValue(prompt);
    api.toast?.(visualEditSummary(target, { action: action.id, value }), 'ok', 2200);
  };

  const label = el('label', { class: 've-label', text: `${action.label}:` });
  if (needsValue) {
    const input = el('input', {
      class: 've-field',
      type: action.id === 'color' ? 'color' : 'text',
      value: action.id === 'color' ? '#1f6feb' : action.id === 'text' ? String(target.text || '').slice(0, 60) : '',
      placeholder: action.id === 'space' ? '24' : action.id === 'size' ? '18' : '',
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        apply(input.value);
      }
      if (event.key === 'Escape') renderVisualEdit(target);
      event.stopPropagation();
    });
    const go = el('button', { class: 'btn sm primary', type: 'button', text: 'Apply' });
    go.onclick = () => apply(input.value);
    row.append(label, input, go);
    bar.append(row);
    setTimeout(() => input.focus(), 20);
    return;
  }

  const go = el('button', { class: `btn sm ${action.id === 'delete' ? 'danger' : 'primary'}`, type: 'button', text: `Confirm ${action.label.toLowerCase()}` });
  go.onclick = () => apply(action.label);
  const back = el('button', { class: 'btn sm', type: 'button', text: 'Back' });
  back.onclick = () => renderVisualEdit(target);
  row.append(go, back);
  bar.append(row);
}

function switchToChat() {
  const app = $('#app');
  if (app?.dataset.layout !== 'code') return;
  setLayout('build', { silent: true });
}

/** Hide the bar (used when the composer is cleared or a turn starts). */
export function clearVisualEdit() {
  const bar = $('#visual-edit');
  if (!bar) return;
  bar.hidden = true;
  bar.innerHTML = '';
  previewState.lastPick = null;
  api.onVisualEdit?.(false);
}

/**
 * What the preview is complaining about right now.
 *
 * The agent uses this to verify its own work: three or four errors that appear
 * within a couple of seconds of a reload are almost always real, and fixing
 * them unprompted is the difference between "it wrote files" and "it works".
 */
export function previewErrors() {
  return previewState.errors.map((error) => ({ ...error }));
}

/** Clear the error list once the agent has been told about them. */
export function clearPreviewErrors() {
  previewState.errors = [];
  updateConsole();
}

/**
 * Wait until the preview has had a chance to boot and report.
 *
 * Resolves early when it is already complaining; otherwise waits `ms` because a
 * clean preview never "finishes", it just stays quiet.
 */
export function waitForPreviewReport({ ms = 1500, quietMs = 400 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const errors = previewState.errors;
      if (errors.length && Date.now() - started > quietMs) return resolve(errors.length);
      if (Date.now() - started >= ms) return resolve(previewState.errors.length);
      setTimeout(tick, 100);
    };
    tick();
  });
}

function pushError(error) {
  const key = error.message.slice(0, 160);
  if (previewState.errors.some((e) => e.message.slice(0, 160) === key)) return;
  previewState.errors.push(error);
  if (previewState.errors.length > 12) previewState.errors.shift();
  updateConsole();
}

function updateConsole() {
  const drawer = $('#console-drawer');
  const body = $('#console-body');
  const count = $('#console-count');
  if (!drawer) return;
  const errors = previewState.errors;
  if (!errors.length) {
    drawer.hidden = true;
    if (count) count.textContent = 'No issues';
    return;
  }
  drawer.hidden = false;
  count.textContent = `${errors.length} issue${errors.length === 1 ? '' : 's'} in the preview`;
  body.textContent = errors.map((e) => `${e.kind === 'runtime' ? '✖' : '!'} ${e.message}${e.where ? ` (${e.where})` : ''}`).join('\n');
}

function bindConsole() {
  $('#btn-console-close').onclick = () => {
    previewState.errors = [];
    updateConsole();
  };
  $('#btn-fix-errors').onclick = () => {
    if (!previewState.errors.length) return;
    const list = previewState.errors.map((e, i) => `${i + 1}. ${e.message}${e.stack ? `\n${e.stack.split('\n').slice(0, 3).join('\n')}` : ''}`).join('\n');
    const prompt = $('#prompt');
    setPrompt(prompt, `The preview is showing these errors. Fix the code so it works:\n\n${list}`);
    prompt.focus();
    api.toast?.('Errors added to the prompt — press Send', 'warn');
  };
}

export function setPromptValue(text) {
  const node = $('#prompt');
  if (node) setPrompt(node, text);
}

/** Fill the composer the way a keystroke would, so every listener stays honest. */
export function setPrompt(node, text) {
  node.value = text;
  node.dispatchEvent(new Event('input', { bubbles: true }));
  autoGrow(node);
}

function autoGrow(node) {
  node.style.height = 'auto';
  node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
}

/* ---------------------------------------------------------------- history -- */

function bindHistory() {
  $('#btn-history').onclick = async () => {
    await renderHistory();
    $('#history-drawer').hidden = false;
  };
  $('#btn-close-history').onclick = () => {
    $('#history-drawer').hidden = true;
  };
  $('#btn-checkpoint').onclick = async () => {
    const state = api.getState?.();
    if (!state?.project) return;
    const files = await state.fs.snapshot(state.project.id);
    await state.store.snapshot(state.project.id, files, 'manual');
    api.toast?.('Checkpoint saved', 'ok');
    await renderHistory();
  };
}

export async function renderHistory() {
  const state = api.getState?.();
  const host = $('#history-list');
  if (!host || !state?.project) return;
  const snaps = await state.store.snapshots(state.project.id);
  host.innerHTML = '';
  if (!snaps.length) {
    host.innerHTML = `<p class="hint" style="padding:12px">No versions yet. A checkpoint is saved automatically before the agent changes files, and every 30 seconds during a turn.</p>`;
    return;
  }
  for (const snap of snaps) {
    const count = Object.keys(snap.files || {}).length;
    const row = el('div', { class: 'snap' });
    row.innerHTML = `
      <span class="card-icon" style="width:26px;height:26px;margin:0">${icon('clock', 13)}</span>
      <div><div class="when">${timeAgo(snap.createdAt)}</div><div class="label">${escapeHtml(snap.label || 'checkpoint')} · ${count} files</div></div>
      <button class="btn sm">Restore</button>`;
    row.querySelector('button').onclick = async (event) => {
      event.stopPropagation();
      if (!confirm(`Restore ${count} files from ${timeAgo(snap.createdAt)}? Current files with the same names will be overwritten.`)) return;
      await state.fs.restore(state.project.id, snap.files);
      api.toast?.('Restored', 'ok');
      api.refreshFiles?.();
      refreshPreview({ force: true });
      $('#history-drawer').hidden = true;
    };
    host.append(row);
  }
}

/* -------------------------------------------------------------- templates -- */

export const TEMPLATES = [
  {
    id: 'blank',
    name: 'Blank canvas',
    description: 'An empty project. Describe the app and the agent builds it.',
    icon: 'plus',
    prompt: '',
  },
  {
    id: 'landing',
    name: 'Landing page',
    description: 'Hero, features, pricing, footer. Great first project.',
    icon: 'spark',
    prompt: 'Build a polished landing page for a SaaS product called "Nimbus". Include a hero with a gradient, three feature cards, a pricing section with three tiers, and a footer. Make it responsive and modern.',
  },
  {
    id: 'dashboard',
    name: 'Dashboard',
    description: 'Sidebar, stat cards, a table and a chart placeholder.',
    icon: 'grid',
    prompt: 'Build an admin dashboard with a sidebar, four stat cards with sparkline-style graphics, a recent-orders table with sample data, and a dark/light toggle. No external libraries.',
  },
  {
    id: 'todo',
    name: 'Todo app',
    description: 'Add, complete and filter tasks; state persists in the browser.',
    icon: 'list',
    prompt: 'Build a todo app with add, complete, delete, and filter (all/active/done). Persist to localStorage. Nice empty state and keyboard support.',
  },
  {
    id: 'store',
    name: 'Storefront',
    description: 'Product grid, detail view and a working cart.',
    icon: 'diamond',
    prompt: 'Build a small storefront: product grid with 6 items, a product detail view, and a cart that persists in localStorage. Modern typography and hover states.',
  },
  {
    id: 'blog',
    name: 'Blog',
    description: 'Index and article pages, readable typography.',
    icon: 'file',
    prompt: 'Build a minimal blog with an index page and two article pages, nice reading typography and a dark mode toggle.',
  },
];

function bindTemplates() {
  $('#btn-templates').onclick = () => {
    $('#template-sheet').hidden = false;
  };
  $('#btn-close-templates').onclick = () => {
    $('#template-sheet').hidden = true;
  };
  $('#template-sheet').addEventListener('click', (event) => {
    if (event.target.id === 'template-sheet') $('#template-sheet').hidden = true;
  });
}

function renderTemplates() {
  const host = $('#template-grid');
  if (!host) return;
  host.innerHTML = '';
  for (const template of TEMPLATES) {
    const card = el('button', { class: 'template', type: 'button' });
    card.innerHTML = `
      <span class="thumb">${icon(template.icon, 22)}</span>
      <strong>${escapeHtml(template.name)}</strong>
      <span>${escapeHtml(template.description)}</span>`;
    card.onclick = async () => {
      $('#template-sheet').hidden = true;
      await api.onTemplate?.(template);
    };
    host.append(card);
  }
}

/* ------------------------------------------------------------- suggestions -- */

function bindSuggestions() {
  for (const button of $$('#suggestions button')) {
    button.onclick = () => {
      const prompt = $('#prompt');
      setPrompt(prompt, button.dataset.suggest);
      prompt.focus();
    };
  }
  const prompt = $('#prompt');
  if (prompt) {
    prompt.addEventListener('input', () => autoGrow(prompt));
    prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        api.onSend?.();
      }
    });
  }
  $('#btn-attach').onclick = () => pickAttachment();
}

export async function pickAttachment() {
  const state = api.getState?.();
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/*,text/*,.md,.json,.csv,.sql,.html,.css,.js,.jsx,.ts,.tsx,.py,.svg,.yml,.yaml,.toml';
  input.onchange = async () => {
    const files = [...(input.files || [])];
    if (!files.length) return;
    state.attachments = state.attachments || [];
    for (const file of files) {
      if (state.attachments.length >= 6) {
        uiToast('Six attachments is the limit for one message', 'warn');
        break;
      }
      const isImage = file.type.startsWith('image/');
      const text = isImage ? '' : await file.text().catch(() => '');
      state.attachments.push({ name: file.name, size: file.size, kind: isImage ? 'image' : 'text', text, url: isImage ? URL.createObjectURL(file) : '' });
    }
    api.renderAttachments?.();
    $('#prompt')?.focus();
  };
  input.click();
}

/* -------------------------------------------------------------- mobile panes -- */

const PANE_FOR_VIEW = { files: 'files', terminal: 'terminal', chat: 'chat', db: 'files', deploy: 'preview' };
const VIEW_FOR_PANE = { chat: 'chat', files: 'files', terminal: 'terminal', preview: null };

export function setMobilePane(pane) {
  const app = $('#app');
  if (!app) return;
  const next = ['chat', 'files', 'terminal', 'preview'].includes(pane) ? pane : 'chat';
  app.dataset.mobilePane = next;
  for (const button of $$('#mobile-nav .mnav-item')) {
    const active = button.dataset.pane === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  if (next === 'preview') {
    if (api.getState?.().view !== 'chat' && api.setView) api.setView('chat');
    requestAnimationFrame(() => refreshPreview({ force: true }));
  } else if (next === 'files') {
    if (api.getState?.().view !== 'files') api.setView?.('files');
  } else if (next === 'terminal') {
    if (api.getState?.().view !== 'terminal') api.setView?.('terminal');
    requestAnimationFrame(() => api.focusTerminal?.());
  } else if (api.getState?.().view !== 'chat') {
    api.setView?.('chat');
  }
  // The dot means "the agent is working and you are not watching it".
  const badge = $('#mnav-badge');
  if (badge) badge.hidden = next === 'chat' || !api.getState?.().running;
  api.saveSettings?.({ mobilePane: next });
}

export function currentMobilePane() {
  return $('#app')?.dataset.mobilePane || 'chat';
}

function bindMobilePanes() {
  for (const button of $$('#mobile-nav .mnav-item')) {
    button.onclick = () => setMobilePane(button.dataset.pane);
  }
  const openMenu = () => {
    $('#sidebar').classList.add('open');
    $('#scrim').hidden = false;
    document.body.classList.add('menu-open');
  };
  const closeMenu = () => {
    $('#sidebar').classList.remove('open');
    $('#scrim').hidden = true;
    document.body.classList.remove('menu-open');
  };
  $('#btn-menu').onclick = openMenu;
  $('#btn-close-menu')?.addEventListener('click', closeMenu);
  $('#scrim').onclick = closeMenu;
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });
  // Leave the drawer open only while the user is choosing something.
  $('#sidebar').addEventListener('click', (event) => {
    if (event.target.closest('button, a') && window.innerWidth <= 820) setTimeout(closeMenu, 120);
  });
  if (api.getState?.().settings?.mobilePane) setMobilePane(api.getState().settings.mobilePane);
}

/* ------------------------------------------------------------------ jobs --- */

export function renderJobs(jobs = []) {
  const strip = $('#job-strip');
  if (!strip) return;
  const running = jobs.filter((job) => job.status === 'running');
  if (!running.length) {
    strip.hidden = true;
    strip.innerHTML = '';
    return;
  }
  strip.hidden = false;
  strip.innerHTML = running
    .map((job) => `<span class="job running"><span class="dot"></span>%${job.id} ${escapeHtml(job.command)}</span>`)
    .join('');
}

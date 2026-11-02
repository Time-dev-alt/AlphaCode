/**
 * Agent activity: a live, ordered list of what the agent is doing right now.
 *
 * The transcript is for reading; this is for *watching*. Every step the harness
 * takes — plan, read, write, shell, test, error, done — lands here with a state
 * so you can tell at a glance whether it is thinking, working, stuck, or done.
 *
 * It is intentionally cheap to update: `push` appends, `patch` mutates one row,
 * and a single rAF flush keeps long runs from thrashing the DOM.
 */
import { $, el, icon, escapeHtml } from './ui.js';

const steps = [];
let seq = 0;
let host = null;
let flushQueued = false;
let startedAt = 0;
let finishedAt = 0;
let collapsed = false;
let thought = '';
let userToggled = false;

const KIND = {
  think: { icon: 'spark', label: 'Thinking' },
  plan: { icon: 'list', label: 'Plan' },
  read: { icon: 'file', label: 'Read' },
  write: { icon: 'pencil', label: 'Write' },
  shell: { icon: 'terminal', label: 'Shell' },
  run: { icon: 'play', label: 'Run' },
  search: { icon: 'search', label: 'Search' },
  fetch: { icon: 'globe', label: 'Fetch' },
  preview: { icon: 'eye', label: 'Preview' },
  deploy: { icon: 'rocket', label: 'Deploy' },
  test: { icon: 'check-circle', label: 'Check' },
  error: { icon: 'alert', label: 'Error' },
  done: { icon: 'check', label: 'Done' },
  info: { icon: 'dot', label: 'Step' },
};

export function mountActivity() {
  host = $('#activity');
  if (host) paint();
}

export function resetActivity() {
  steps.length = 0;
  seq = 0;
  startedAt = performance.now();
  finishedAt = 0;
  thought = '';
  userToggled = false;
  setCollapsed(false);
  paint();
}

/** Remember an explicit choice so a finished run does not re-collapse on you. */
export function markToggled() {
  userToggled = true;
}

export function activityStarted() {
  if (!startedAt || finishedAt) startedAt = performance.now();
  finishedAt = 0;
  paint();
}

/** Append a step. Returns its id so callers can patch it later. */
export function pushActivity({ kind = 'info', title = '', detail = '', state = 'run', meta = '', merge = false }) {
  // Thoughts arrive many times per turn; a wall of "Thinking" rows buries the
  // work that actually happened. Merge them into the row already on screen.
  if (merge) {
    const previous = steps.at(-1);
    if (previous && previous.kind === kind) {
      previous.title = title || previous.title;
      if (detail) previous.detail = detail;
      previous.state = state;
      previous.at = performance.now();
      schedulePaint();
      return previous.id;
    }
  }
  const id = `s${++seq}`;
  steps.push({ id, kind, title, detail, state, meta, at: performance.now(), open: false });
  if (steps.length > 200) steps.splice(0, steps.length - 200);
  if (!startedAt) startedAt = performance.now();
  schedulePaint();
  return id;
}

export function patchActivity(id, patch = {}) {
  const step = steps.find((s) => s.id === id);
  if (!step) return;
  Object.assign(step, patch);
  if (step.state !== 'run') step.open = step.open && Boolean(step.detail);
  schedulePaint();
}

export function finishActivity(state = 'done') {
  for (const step of steps) if (step.state === 'run') step.state = 'done';
  finishedAt = performance.now();
  // A finished run is history. Fold it to one line so the conversation it
  // produced gets the room; the person can reopen it with one tap.
  if (steps.length > 2 && !userToggled) setCollapsed(true);
  if (state === 'error') {
    const last = steps.at(-1);
    if (last && last.state !== 'error') last.state = 'error';
  }
  schedulePaint();
}

/**
 * "Thinking" is a state, not a step: the header says what the model is doing
 * while the timeline keeps listing things that actually happened.
 */
export function setThought(text) {
  thought = text || '';
  schedulePaint();
}

export function getThought() {
  return thought;
}

/** The current step, so repeated model calls patch one row instead of adding ten. */
export function currentStep(kind) {
  return [...steps].reverse().find((s) => s.kind === kind && s.state === 'run') || null;
}

/** Stop a running step without adding a new one. */
export function settleStep(kind, patch = {}) {
  const step = currentStep(kind);
  if (step) patchActivity(step.id, { state: 'done', ...patch });
  return step?.id || null;
}

/**
 * Provider failover is not an error the user caused. It is worth one quiet line,
 * never one red row per router, so the timeline keeps describing the *work*.
 */
export function noteActivity(title, detail = '') {
  const id = pushActivity({ kind: 'info', title, detail, state: 'note' });
  return id;
}

export function activitySteps() {
  return steps.slice();
}

export function setCollapsed(value) {
  collapsed = value;
  host?.classList.toggle('collapsed', collapsed);
  const panel = $('#activity-panel');
  panel?.classList.toggle('collapsed', collapsed);
}

function schedulePaint() {
  if (flushQueued) return;
  flushQueued = true;
  requestAnimationFrame(() => {
    flushQueued = false;
    paint();
  });
}

function paint() {
  host = host || $('#activity');
  if (!host) return;
  const panel = $('#activity-panel');
  const running = Boolean(startedAt && !finishedAt);

  // Header: what is happening, in one line, plus elapsed time.
  const current = [...steps].reverse().find((s) => s.state === 'run');
  const headline = running
    ? current
      ? `${KIND[current.kind]?.label || 'Working'}${current.title ? ` · ${truncate(current.title, 46)}` : ''}`
      : thought || 'Working…'
    : steps.length
      ? `${steps.length} step${steps.length === 1 ? '' : 's'} · done`
      : 'Idle';
  const elapsed = startedAt ? Math.round(((finishedAt || performance.now()) - startedAt) / 1000) : 0;

  const head = $('#activity-headline');
  if (head) {
    head.textContent = headline;
    head.classList.toggle('live', running);
  }
  const clock = $('#activity-clock');
  if (clock) clock.textContent = steps.length ? formatDuration(elapsed) : '';
  const count = $('#activity-count');
  if (count) {
    const errors = steps.filter((s) => s.state === 'error').length;
    const live = steps.filter((s) => s.state === 'run').length;
    count.textContent = errors
      ? `${errors} error${errors > 1 ? 's' : ''}`
      : running
        ? live
          ? `${live} running`
          : 'working'
        : '';
    count.className = `activity-count ${errors ? 'err' : running ? 'live' : ''}`;
    count.hidden = !count.textContent;
  }
  const dot = $('#activity-dot');
  if (dot) dot.className = `activity-dot ${running ? 'live' : steps.some((s) => s.state === 'error') ? 'err' : 'idle'}`;
  panel?.classList.toggle('live', running);
  panel?.classList.toggle('empty', !steps.length);

  if (!host.childElementCount && !steps.length) {
    host.innerHTML = `<div class="activity-idle">
      <span class="activity-idle-ring">${icon('spark', 15)}</span>
      <p>Steps appear here as the agent works — planning, reading files, writing code, running commands.</p>
    </div>`;
    return;
  }

  host.innerHTML = steps.map(renderStep).join('');
  host.querySelectorAll('.activity-step').forEach((node) => {
    node.onclick = (event) => {
      if (event.target.closest('a')) return;
      const step = steps.find((s) => s.id === node.dataset.id);
      if (!step || !step.detail) return;
      step.open = !step.open;
      node.classList.toggle('open', step.open);
    };
  });
  const scroller = $('#activity-scroll');
  if (scroller && running) scroller.scrollTop = scroller.scrollHeight;
}

function renderStep(step, index) {
  const kind = KIND[step.kind] || KIND.info;
  const isLast = index === steps.length - 1;
  const detail = step.detail
    ? `<div class="activity-detail">${typeof step.detail === 'string' ? `<pre>${escapeHtml(step.detail)}</pre>` : ''}</div>`
    : '';
  return `<div class="activity-step ${step.state} ${step.open ? 'open' : ''} ${isLast ? 'last' : ''}" data-id="${step.id}">
    <span class="activity-rail"><span class="activity-node">${icon(kind.icon, 11)}</span></span>
    <div class="activity-body">
      <div class="activity-line">
        <span class="activity-kind">${kind.label}</span>
        <span class="activity-title">${escapeHtml(truncate(step.title, 120))}</span>
        <span class="activity-meta">${escapeHtml(step.meta || '')}</span>
        ${step.detail ? `<span class="activity-caret">${icon('chevron-down', 11)}</span>` : ''}
      </div>
      ${detail}
    </div>
    <span class="activity-spinner" aria-hidden="true"></span>
  </div>`;
}

const truncate = (text, max) => {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${mins}m ${String(rest).padStart(2, '0')}s`;
}

/* ------------------------------------------------------- tool → activity -- */

/** Map a harness tool call onto a step, so the timeline matches the transcript. */
export function activityForTool(name, args = {}, result = null, title = '') {
  const base = String(name || '').replace(/^mcp__/, '');
  const file = title || args.path || args.file || args.filePath || args.target || '';
  const command = title || args.command || args.cmd || args.script || '';

  if (base.includes('write') || base.includes('create') || base.includes('edit')) {
    return { kind: 'write', title: file || 'file', detail: summariseWrite(args) };
  }
  if (base.includes('read')) return { kind: 'read', title: file || 'file' };
  if (base.includes('list') || base.includes('glob') || base.includes('tree')) return { kind: 'search', title: args.glob || args.dir || 'workspace' };
  if (base.includes('grep') || base.includes('search')) return { kind: 'search', title: args.pattern || args.query || '' };
  if (base.includes('shell') || base.includes('bash') || base.includes('exec') || base.includes('cmd')) {
    return { kind: 'shell', title: command || result?.output?.split('\n')[0] || 'command', detail: result?.output };
  }
  if (base.includes('fetch') || base.includes('http') || base.includes('url')) return { kind: 'fetch', title: args.url || '' };
  if (base.includes('deploy')) return { kind: 'deploy', title: args.target || 'deploy' };
  if (base.includes('preview')) return { kind: 'preview', title: args.path || 'preview' };
  if (base.includes('test')) return { kind: 'test', title: command || 'tests' };
  if (base.includes('todo') || base.includes('plan')) return { kind: 'plan', title: args.item || args.text || '' };
  return { kind: 'info', title: base, detail: command || file || '' };
}

function summariseWrite(args) {
  const content = args.content ?? args.old_str ?? args.new_str ?? '';
  if (!content) return '';
  const lines = String(content).split('\n');
  const preview = lines.slice(0, 14).join('\n');
  return lines.length > 14 ? `${preview}\n… ${lines.length - 14} more lines` : preview;
}

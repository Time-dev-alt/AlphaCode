/**
 * Real interactive terminal sessions backed by a kernel PTY.
 *
 * Uses the small native helper (native/ptyhelper.c) for true TTY semantics
 * (isatty, job control, colours, Ctrl-C, resize). Falls back to util-linux
 * `script(1)` when no compiler is available, and to a plain line-buffered shell
 * as a last resort so the feature never hard-fails.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from '../config.mjs';
import { log } from '../lib/log.mjs';
import { userEnv } from './exec.mjs';
import { randomId } from '../lib/crypto.mjs';
import { getStore } from '../lib/store.mjs';

const MAX_BUFFER = 320 * 1024;
const MAX_SESSIONS_PER_PROJECT = 4;
const IDLE_MS = 45 * 60 * 1000;

let helperState = null; // { mode: 'native'|'script'|'pipe', path }

export function ensurePtyHelper() {
  if (helperState) return helperState;
  const bin = path.join(config.dataDir, 'bin', 'ptyhelper');
  if (process.platform !== 'win32') {
    let needsBuild = true;
    try {
      const st = fs.statSync(bin);
      const src = fs.statSync(path.join(config.root, 'native', 'ptyhelper.c'));
      needsBuild = src.mtimeMs > st.mtimeMs;
    } catch {}
    if (needsBuild) {
      const compilers = ['cc', 'gcc', 'clang'];
      const cc = compilers.find((c) => spawnSync('/bin/sh', ['-lc', `command -v ${c}`]).status === 0);
      if (cc) {
        fs.mkdirSync(path.dirname(bin), { recursive: true });
        const res = spawnSync(cc, ['-O2', '-o', bin, path.join(config.root, 'native', 'ptyhelper.c')], { encoding: 'utf8' });
        if (res.status === 0) fs.chmodSync(bin, 0o755);
        else log.warn('pty helper build failed: ' + (res.stderr || '').slice(0, 300));
      }
    }
    if (fs.existsSync(bin)) {
      helperState = { mode: 'native', path: bin };
      return helperState;
    }
    const hasScript = spawnSync('/bin/sh', ['-lc', 'command -v script']).status === 0;
    helperState = hasScript ? { mode: 'script', path: 'script' } : { mode: 'pipe', path: config.shell.bin };
    log.info(`terminal backend: ${helperState.mode}`);
    return helperState;
  }
  helperState = { mode: 'pipe', path: config.shell.bin };
  return helperState;
}

class TerminalSession extends EventEmitter {
  constructor({ id, projectId, cwd, cols = 120, rows = 32 }) {
    super();
    this.id = id;
    this.projectId = projectId;
    this.cwd = cwd;
    this.cols = cols;
    this.rows = rows;
    this.chunks = [];
    this.bytes = 0;
    this.seq = 0;
    this.alive = false;
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.exitCode = null;
    this.backend = '';
    this.sizeFile = path.join(config.dataDir, 'tmp', `pty-${id}.size`);
  }

  async start() {
    const helper = ensurePtyHelper();
    this.backend = helper.mode;
    await fsp.writeFile(this.sizeFile, `${this.cols} ${this.rows}`, 'utf8');
    const shell = config.shell.bin;
    const args =
      helper.mode === 'native'
        ? [String(this.cols), String(this.rows), this.sizeFile, '--', shell, '-l']
        : helper.mode === 'script'
          ? ['-qfc', `${shell} -l`, '/dev/null']
          : ['-l'];

    const cmd = helper.mode === 'native' ? helper.path : helper.mode === 'script' ? 'script' : shell;
    this.proc = spawn(cmd, args, {
      cwd: this.cwd,
      env: {
        ...userEnv(),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        PS1: '\\[\\e[38;5;209m\\]alphacode\\[\\e[0m\\] \\[\\e[38;5;245m\\]\\w\\[\\e[0m\\] \\$ ',
        HISTFILE: path.join(config.dataDir, 'tmp', `.history-${this.projectId}`),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });
    this.alive = true;
    const push = (buf) => this.push(buf.toString('utf8'));
    this.proc.stdout.on('data', push);
    this.proc.stderr.on('data', push);
    this.proc.on('exit', (code) => {
      this.alive = false;
      this.exitCode = code;
      this.push(`\r\n\x1b[38;5;244m[process exited with code ${code}]\x1b[0m\r\n`);
      this.emit('exit', code);
    });
    this.proc.on('error', (err) => {
      this.alive = false;
      this.push(`\r\n\x1b[31m[terminal error: ${err.message}]\x1b[0m\r\n`);
      this.emit('exit', -1);
    });
    return this;
  }

  push(text) {
    this.lastActivity = Date.now();
    this.seq += 1;
    const chunk = { seq: this.seq, data: text };
    this.chunks.push(chunk);
    this.bytes += text.length;
    while (this.bytes > MAX_BUFFER && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      this.bytes -= removed.data.length;
    }
    this.emit('data', chunk);
  }

  write(data) {
    if (!this.alive || !this.proc?.stdin?.writable) return false;
    this.lastActivity = Date.now();
    try {
      this.proc.stdin.write(String(data));
      return true;
    } catch {
      return false;
    }
  }

  async resize(cols, rows) {
    this.cols = Math.max(20, Math.min(400, Number(cols) || 120));
    this.rows = Math.max(5, Math.min(200, Number(rows) || 32));
    if (this.backend === 'native' && this.alive) {
      try {
        await fsp.writeFile(this.sizeFile, `${this.cols} ${this.rows}`, 'utf8');
        this.proc.kill('SIGUSR1');
      } catch (err) {
        log.debug('resize failed', err.message);
      }
    }
  }

  replay(fromSeq = 0) {
    return this.chunks.filter((c) => c.seq > fromSeq);
  }

  kill() {
    if (!this.proc) return;
    try {
      this.proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          this.proc.kill('SIGKILL');
        } catch {}
      }, 1500).unref?.();
    } catch {}
    this.alive = false;
    try {
      fs.unlinkSync(this.sizeFile);
    } catch {}
  }

  get info() {
    return {
      id: this.id,
      projectId: this.projectId,
      cwd: this.cwd,
      backend: this.backend,
      alive: this.alive,
      cols: this.cols,
      rows: this.rows,
      seq: this.seq,
      exitCode: this.exitCode,
      startedAt: this.startedAt,
    };
  }
}

class TerminalRegistry {
  constructor() {
    this.sessions = new Map();
    const timer = setInterval(() => this.sweep(), 60_000);
    timer.unref?.();
  }
  list(projectId) {
    return [...this.sessions.values()].filter((s) => s.projectId === projectId).map((s) => s.info);
  }
  async create({ projectId, cwd, cols, rows }) {
    const existing = [...this.sessions.values()].filter((s) => s.projectId === projectId);
    if (existing.length >= MAX_SESSIONS_PER_PROJECT) {
      // Reuse the most recent live session instead of refusing the user.
      const live = existing.find((s) => s.alive);
      if (live) return live;
      existing.sort((a, b) => a.lastActivity - b.lastActivity);
      existing[0].kill();
      this.sessions.delete(existing[0].id);
    }
    const id = randomId('term_', 8);
    const session = new TerminalSession({ id, projectId, cwd, cols, rows });
    this.sessions.set(id, session);
    await session.start();
    return session;
  }
  get(id) {
    return this.sessions.get(id) || null;
  }
  forProject(id, projectId) {
    const s = this.sessions.get(id);
    return s && s.projectId === projectId ? s : null;
  }
  close(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.kill();
    this.sessions.delete(id);
    return true;
  }
  sweep() {
    for (const [id, s] of this.sessions) {
      if (Date.now() - s.lastActivity > IDLE_MS) {
        s.kill();
        this.sessions.delete(id);
      }
    }
  }
}

export const terminals = new TerminalRegistry();

/** Attach an SSE stream to a terminal session. */
export function attachTerminal(sse, session, { from = 0 } = {}) {
  const backlog = session.replay(from);
  for (const chunk of backlog) sse.send('output', { seq: chunk.seq, data: chunk.data }, chunk.seq);
  sse.send('ready', { ...session.info, replayed: backlog.length });
  const onData = (chunk) => sse.send('output', { seq: chunk.seq, data: chunk.data }, chunk.seq);
  const onExit = (code) => {
    sse.send('exit', { code });
    setTimeout(() => sse.close(), 50);
  };
  session.on('data', onData);
  session.on('exit', onExit);
  sse.onClose?.(() => {
    session.off('data', onData);
    session.off('exit', onExit);
  });
  const cleanup = () => {
    session.off('data', onData);
    session.off('exit', onExit);
  };
  return cleanup;
}

/** Record terminal usage in the audit log (no command text, privacy first). */
export function auditTerminal(userId, projectId) {
  try {
    getStore().audit({ userId, action: 'terminal_open', detail: projectId });
  } catch {}
}

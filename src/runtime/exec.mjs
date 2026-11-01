/**
 * Process execution for the Bash tool + build pipelines.
 *
 * Real child processes, real exit codes, streamed output, hard timeouts, and an
 * environment that never leaks platform secrets into user code.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';

const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|_AUTH)$/i;
const PASSTHROUGH = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'TMPDIR',
  'PYTHONPATH',
  'VIRTUAL_ENV',
  'NODE_PATH',
  'NVM_DIR',
  'npm_config_cache',
]);

/**
 * Pinned toolchains installed into data/runtimes (Node / npm / python) must win
 * over the host binaries, so user code always sees the newest versions.
 */
function runtimePathDirs() {
  const dirs = [];
  try {
    const root = path.join(config.dataDir, 'runtimes');
    for (const entry of fs.readdirSync(root)) {
      const full = path.join(root, entry);
      const bin = path.join(full, 'bin');
      if (fs.existsSync(bin) && fs.statSync(bin).isDirectory()) dirs.push(bin);
      const npmBin = path.join(full, 'node_modules', '.bin');
      if (fs.existsSync(npmBin)) dirs.push(npmBin);
    }
  } catch {}
  try {
    const localBin = path.join(config.dataDir, 'bin');
    if (fs.existsSync(localBin)) dirs.push(localBin);
  } catch {}
  return dirs;
}

/** Env for user processes: no AlphaCode/provider secrets, sensible defaults. */
export function userEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV_RE.test(k)) continue;
    if (/^ALPHACODE_/i.test(k)) continue;
    if (PASSTHROUGH.has(k) || /^(npm_|PYTHON|PIP_|NODE_)/.test(k)) env[k] = v;
  }
  const basePath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  env.PATH = [...runtimePathDirs(), basePath].join(path.delimiter);
  env.HOME = env.HOME || '/root';
  env.TERM = 'xterm-256color';
  env.CI = env.CI || '1';
  env.NO_COLOR = '';
  env.ALPHACODE = '1';
  return Object.assign(env, extra);
}

export function dangerousCommand(command) {
  const c = String(command);
  const reasons = [];
  const patterns = [
    [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/(?!home\/|tmp\/|workspace)|~\/?\s*$|\*)/, 'recursive delete outside the workspace'],
    [/\bmkfs(\.[a-z0-9]+)?\b/i, 'filesystem format'],
    [/\bdd\s+if=.*of=\/dev\//i, 'raw device write'],
    [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'],
    [/\bchmod\s+-R\s+777\s+\//, 'world-writable root'],
    [/\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, 'host power control'],
    [/\b(useradd|userdel|passwd|visudo|su|sudo)\b/, 'privilege or account change'],
    [/\biptables\b|\bnft\b|\bufw\b/, 'firewall change'],
    [/\bcurl[^|]*\|\s*(ba)?sh\b/, 'pipe-to-shell installer'],
    [/>\s*\/etc\//, 'write to /etc'],
    [/\bgit\s+push\s+.*--force/, 'force push'],
    [/\b(npm|pnpm|yarn)\s+publish\b/, 'package publish'],
    [/\bssh\b|\bscp\b|\brsync\b.*:/, 'remote shell/transfer'],
    [/\bcrontab\b|\bsystemctl\b/, 'system service change'],
  ];
  for (const [re, reason] of patterns) if (re.test(c)) reasons.push(reason);
  return reasons;
}

export function looksLikeNetwork(command) {
  return /\b(curl|wget|nc|netcat|ftp|sftp|telnet|ssh)\b/.test(String(command));
}

/**
 * Run a command. Returns { code, signal, output, truncated, durationMs }.
 * `onData` streams stdout/stderr chunks as they arrive.
 */
export function runCommand(command, {
  cwd,
  timeoutMs = config.shell.timeoutMs,
  env = {},
  onData = () => {},
  maxOutput = 4 * 1024 * 1024,
  shell = '/bin/bash',
  signal,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(shell, ['-lc', command], {
      cwd,
      env: userEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    let truncated = false;
    let killedForTimeout = false;

    const timer = setTimeout(() => {
      killedForTimeout = true;
      killTree(child);
    }, Math.max(1000, timeoutMs));

    const onAbort = () => killTree(child);
    if (signal) {
      if (signal.aborted) killTree(child);
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const collect = (chunk) => {
      const text = chunk.toString('utf8');
      if (output.length < maxOutput) output += text;
      else truncated = true;
      try {
        onData(text);
      } catch {}
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, signal: null, output: output + `\n[spawn error] ${err.message}`, truncated, durationMs: Date.now() - started, timedOut: false });
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({
        code: code === null ? 137 : code,
        signal: sig,
        output,
        truncated,
        durationMs: Date.now() - started,
        timedOut: killedForTimeout,
      });
    });
  });
}

function killTree(child) {
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

export function which(bin) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-lc', `command -v ${JSON.stringify(bin)} 2>/dev/null || true`], { env: userEnv() });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('close', () => resolve(out.trim().split('\n')[0] || ''));
    child.on('error', () => resolve(''));
  });
}

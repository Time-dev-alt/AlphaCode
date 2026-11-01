/**
 * User-configurable hooks — the Claude Code model, same semantics:
 *
 *   data/hooks.json (or ALPHACODE_HOOKS)
 *   {
 *     "PreToolUse":  [{ "matcher": "bash|write", "command": "scripts/guard.sh" }],
 *     "PostToolUse": [{ "matcher": "*", "command": "npx prettier --write $ALPHACODE_FILE" }],
 *     "PreCompact":  [{ "matcher": "*", "command": "echo compacting >&2" }],
 *     "SessionStart":[{ "matcher": "*", "command": "echo hello" }]
 *   }
 *
 * Each hook gets the event as JSON on stdin and these env vars:
 *   ALPHACODE_EVENT, ALPHACODE_TOOL, ALPHACODE_FILE, ALPHACODE_PROJECT, ALPHACODE_JSON
 *
 * Exit codes: 0 = allow (stdout is shown as a notice), 2 = block the tool call
 * (stderr becomes the reason the model sees), anything else = warn and continue.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.mjs';
import { log } from '../lib/log.mjs';

const TIMEOUT_MS = 20_000;
const EVENTS = ['PreToolUse', 'PostToolUse', 'PreCompact', 'SessionStart', 'SessionEnd'];

let cached = null;

export function hooksConfig() {
  if (cached) return cached;
  const out = {};
  let raw = process.env.ALPHACODE_HOOKS || '';
  if (!raw.trim()) {
    const file = path.join(config.dataDir, 'hooks.json');
    try {
      if (fs.existsSync(file)) raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      log.warn(`hooks.json unreadable: ${err.message}`);
    }
  }
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      for (const [event, list] of Object.entries(parsed || {})) {
        if (!EVENTS.includes(event)) continue;
        const hooks = (Array.isArray(list) ? list : [list])
          .filter((h) => h && typeof h.command === 'string')
          .map((h) => ({ matcher: String(h.matcher || '*'), command: h.command, timeoutMs: Number(h.timeoutMs) || TIMEOUT_MS }));
        if (hooks.length) out[event] = hooks;
      }
    } catch (err) {
      log.warn(`hooks configuration is not valid JSON: ${err.message}`);
    }
  }
  cached = out;
  return out;
}

export function resetHooksCache() {
  cached = null;
}

export function matcherMatches(matcher, toolName) {
  if (!matcher || matcher === '*' || matcher === '') return true;
  try {
    // Claude Code semantics: the matcher is a regex tested against the tool name.
    return new RegExp(matcher).test(String(toolName || ''));
  } catch {
    return String(matcher).split(/[|,]/).includes(String(toolName || ''));
  }
}

function runHook(hook, payload) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('/bin/bash', ['-lc', hook.command], {
      env: {
        ...process.env,
        ALPHACODE_EVENT: payload.event,
        ALPHACODE_TOOL: payload.tool || '',
        ALPHACODE_FILE: payload.file || '',
        ALPHACODE_PROJECT: payload.projectId || '',
        ALPHACODE_JSON: JSON.stringify(payload),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
    }, hook.timeoutMs);
    child.stdout.on('data', (d) => (stdout = (stdout + d.toString()).slice(-8000)));
    child.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-8000)));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}`.trim(), durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code === null ? 1 : code, stdout: stdout.trim(), stderr: stderr.trim(), durationMs: Date.now() - started });
    });
    try {
      child.stdin.end(JSON.stringify(payload) + '\n');
    } catch {}
  });
}

/**
 * Fire every hook registered for an event.
 * @returns {Promise<{blocked:boolean, reason:string, notices:string[]}>}
 */
export async function fireHooks(event, payload = {}, { toolName = '', emit = null } = {}) {
  const hooks = hooksConfig()[event];
  if (!hooks?.length) return { blocked: false, reason: '', notices: [] };
  const notices = [];
  for (const hook of hooks) {
    if (!matcherMatches(hook.matcher, toolName)) continue;
    const res = await runHook(hook, { event, tool: toolName, ...payload });
    if (res.stdout) notices.push(res.stdout.slice(0, 1200));
    if (res.code === 2) {
      const reason = (res.stderr || res.stdout || `Blocked by ${event} hook`).slice(0, 1500);
      log.info(`hook blocked ${event}/${toolName}: ${reason.split('\n')[0]}`);
      return { blocked: true, reason, notices };
    }
    if (res.code !== 0 && res.stderr) log.warn(`hook ${event} exited ${res.code}: ${res.stderr.slice(0, 300)}`);
  }
  for (const notice of notices) emit?.({ type: 'notice', level: 'info', text: `hook: ${notice}` });
  return { blocked: false, reason: '', notices };
}

export const HOOK_EVENTS = EVENTS;

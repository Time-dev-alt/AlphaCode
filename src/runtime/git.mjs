/**
 * Checkpoints + diffs powered by a real git repository inside the workspace.
 * Every mutating agent step can snapshot beforehand so `/rewind` always works —
 * the same safety net Claude Code gives you with checkpoints.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './exec.mjs';
import { log } from '../lib/log.mjs';
import { getStore } from '../lib/store.mjs';

const GITIGNORE = `node_modules/
.venv/
__pycache__/
.next/
dist/
build/
.turbo/
.cache/
*.log
.env
.env.*
!.env.example
`;

const initialised = new Set();

export async function ensureGit(projectDir) {
  if (initialised.has(projectDir)) return true;
  const gitDir = path.join(projectDir, '.git');
  if (!fs.existsSync(gitDir)) {
    const res = await runCommand('git init -q && git symbolic-ref HEAD refs/heads/main', { cwd: projectDir, timeoutMs: 20000 });
    if (res.code !== 0) {
      log.debug('git init failed: ' + res.output.slice(0, 200));
      return false;
    }
    await runCommand('git config user.email "agent@alphacode.local" && git config user.name "AlphaCode Agent" && git config commit.gpgsign false', {
      cwd: projectDir,
      timeoutMs: 15000,
    });
    const ignore = path.join(projectDir, '.gitignore');
    if (!fs.existsSync(ignore)) await fsp.writeFile(ignore, GITIGNORE, 'utf8');
    await runCommand('git add -A >/dev/null 2>&1; git commit -qm "chore: workspace initialised" >/dev/null 2>&1 || true', { cwd: projectDir, timeoutMs: 30000 });
  }
  initialised.add(projectDir);
  return true;
}

export async function checkpoint(projectId, projectDir, label = 'checkpoint') {
  if (!(await ensureGit(projectDir))) return null;
  const msg = `alphacode: ${String(label).slice(0, 120)}`;
  const res = await runCommand(
    `git add -A >/dev/null 2>&1; git -c user.email=agent@alphacode.local -c user.name="AlphaCode Agent" commit -qm ${JSON.stringify(msg)} >/dev/null 2>&1; git rev-parse HEAD`,
    { cwd: projectDir, timeoutMs: 40000 },
  );
  const sha = (res.output.match(/[0-9a-f]{40}/) || [])[0];
  if (!sha) return null;
  try {
    getStore().addCheckpoint({ projectId, label, ref: sha });
  } catch {}
  return sha;
}

export async function status(projectDir) {
  const res = await runCommand('git status --porcelain=v1 -b', { cwd: projectDir, timeoutMs: 20000 });
  if (res.code !== 0) return { branch: '', changes: [] };
  const lines = res.output.split('\n').filter(Boolean);
  const branch = (lines[0] || '').replace(/^##\s*/, '').split('...')[0];
  const changes = lines.slice(1).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
  return { branch, changes };
}

export async function diff(projectDir, { staged = false, file } = {}) {
  const args = ['git', 'diff', staged ? '--cached' : '', '--no-color', '--stat', file || ''].filter(Boolean).join(' ');
  const stat = await runCommand(args, { cwd: projectDir, timeoutMs: 30000 });
  const patchArgs = ['git', 'diff', staged ? '--cached' : '', '--no-color', file || ''].filter(Boolean).join(' ');
  const patch = await runCommand(patchArgs, { cwd: projectDir, timeoutMs: 30000 });
  return { stat: stat.output, patch: patch.output.slice(0, 200_000) };
}

export async function history(projectDir, limit = 30) {
  const res = await runCommand(`git log --pretty=format:'%h|%an|%ar|%s' -n ${Number(limit) || 30}`, { cwd: projectDir, timeoutMs: 20000 });
  if (res.code !== 0) return [];
  return res.output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, author, when, subject] = line.split('|');
      return { sha, author, when, subject };
    });
}

export async function rewind(projectDir, sha) {
  if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) throw new Error('Invalid commit reference');
  const res = await runCommand(`git reset --hard ${sha} && git clean -fd >/dev/null 2>&1`, { cwd: projectDir, timeoutMs: 60000 });
  return { ok: res.code === 0, output: res.output.slice(0, 2000) };
}

/** Unified diff between two strings, for the UI's edit cards. */
export function unifiedDiff(oldText, newText, filePath = '', context = 3) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    return `--- ${filePath}\n+++ ${filePath}\n@@ rewritten (${n} → ${m} lines) @@`;
  }
  // LCS table
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', v: a[i], i: i + 1, j: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: '-', v: a[i], i: i + 1, j: j });
      i++;
    } else {
      ops.push({ t: '+', v: b[j], i: i, j: j + 1 });
      j++;
    }
  }
  while (i < n) ops.push({ t: '-', v: a[i++], i, j });
  while (j < m) ops.push({ t: '+', v: b[j++], i, j });

  const out = [`--- a/${filePath}`, `+++ b/${filePath}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === ' ') {
      k++;
      continue;
    }
    let start = Math.max(0, k - context);
    let end = Math.min(ops.length, k + 1);
    // grow while changes are close together
    while (end < ops.length) {
      let next = end;
      while (next < ops.length && ops[next].t === ' ' && next - end < context * 2) next++;
      if (next < ops.length && ops[next].t !== ' ') end = next + 1;
      else break;
    }
    end = Math.min(ops.length, end + context);
    const hunk = ops.slice(start, end);
    const oldStart = hunk.find((o) => o.t !== '+')?.i ?? hunk[0].i;
    const newStart = hunk.find((o) => o.t !== '-')?.j ?? hunk[0].j;
    const oldCount = hunk.filter((o) => o.t !== '+').length;
    const newCount = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const o of hunk) out.push(o.t + o.v);
    k = end;
  }
  return out.join('\n');
}

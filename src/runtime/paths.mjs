/**
 * Workspace path sandbox.
 * Every filesystem operation goes through here: no traversal, no symlink
 * escapes, no writes outside the project directory.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.mjs';
import { forbidden, bad, notFound } from '../lib/http.mjs';

export function projectWorkspace(projectId) {
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(String(projectId))) throw bad('Invalid project id');
  return path.join(config.workspaceRoot, projectId);
}

export async function ensureWorkspace(projectId) {
  const dir = projectWorkspace(projectId);
  await fsp.mkdir(dir, { recursive: true });
  const metaFile = path.join(dir, '.alphacode', 'project.json');
  if (!fs.existsSync(metaFile)) {
    await fsp.mkdir(path.dirname(metaFile), { recursive: true });
    await fsp.writeFile(
      metaFile,
      JSON.stringify({ id: projectId, createdAt: new Date().toISOString(), agentFile: 'ALPHACODE.md' }, null, 2),
    );
  }
  return dir;
}

/** Resolve a user-supplied relative path inside a workspace, safely. */
export async function resolveSafe(projectId, relPath = '.', { mustExist = false } = {}) {
  const root = await ensureWorkspace(projectId);
  const cleaned = String(relPath || '.').replace(/\0/g, '').replace(/\\/g, '/');
  if (cleaned.length > 4096) throw bad('Path too long');
  const normalised = path.normalize(cleaned);
  if (path.isAbsolute(normalised)) {
    // Absolute paths are allowed only if they are already inside the workspace.
    const abs = path.resolve(normalised);
    if (!isInside(root, abs)) throw forbidden('Path escapes the project workspace');
    return mustExistCheck(abs, mustExist);
  }
  const abs = path.resolve(root, normalised);
  if (!isInside(root, abs)) throw forbidden('Path escapes the project workspace');
  return mustExistCheck(abs, mustExist);
}

function mustExistCheck(abs, mustExist) {
  if (mustExist && !fs.existsSync(abs)) throw notFound(`No such file: ${path.basename(abs)}`);
  return abs;
}

export function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** realpath check — defeats symlink escapes. */
export async function resolveReal(projectId, relPath, opts) {
  const abs = await resolveSafe(projectId, relPath, opts);
  let real;
  try {
    real = await fsp.realpath(abs);
  } catch {
    real = abs;
  }
  const root = await fsp.realpath(projectWorkspace(projectId));
  if (!isInside(root, real)) throw forbidden('Path escapes the project workspace (symlink blocked)');
  return abs;
}

export function toRel(projectId, abs) {
  return path.relative(projectWorkspace(projectId), abs).split(path.sep).join('/') || '.';
}

const IGNORE = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.cache', 'coverage', '__pycache__', '.venv', 'venv', '.alphacode', '.DS_Store']);
const MAX_FILES = 4000;

export async function listTree(projectId, { maxDepth = 6, maxFiles = MAX_FILES } = {}) {
  const root = await ensureWorkspace(projectId);
  const out = [];
  async function walk(dir, depth) {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (IGNORE.has(entry.name)) {
        out.push({ path: path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'), name: entry.name, dir: true, ignored: true });
        continue;
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        out.push({ path: rel, name: entry.name, dir: true });
        if (depth < maxDepth) await walk(full, depth + 1);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = (await fsp.stat(full)).size;
        } catch {}
        out.push({ path: rel, name: entry.name, dir: false, size });
      }
    }
  }
  await walk(root, 0);
  return out;
}

export async function readFileSafe(projectId, relPath, maxBytes = 2 * 1024 * 1024) {
  const abs = await resolveReal(projectId, relPath, { mustExist: true });
  const stat = await fsp.stat(abs);
  if (!stat.isFile()) throw bad('Not a file');
  if (stat.size > maxBytes) throw bad(`File is too large to edit in the browser (${Math.round(stat.size / 1024)} KB)`);
  const buf = await fsp.readFile(abs);
  if (buf.includes(0)) throw bad('Binary file — not shown in the editor');
  return { path: toRel(projectId, abs), content: buf.toString('utf8'), size: stat.size, mtime: stat.mtimeMs };
}

export async function writeFileSafe(projectId, relPath, content, { createDirs = true } = {}) {
  const abs = await resolveReal(projectId, relPath);
  if (createDirs) await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  return { path: toRel(projectId, abs), bytes: Buffer.byteLength(content), hash: sha256(content).slice(0, 12) };
}

export function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

export async function deleteSafe(projectId, relPath) {
  const abs = await resolveReal(projectId, relPath, { mustExist: true });
  if (abs === projectWorkspace(projectId)) throw forbidden('Cannot delete the workspace root');
  await fsp.rm(abs, { recursive: true, force: true });
  return true;
}

/** Simple glob → RegExp (supports **, *, ?, {a,b}) */
export function globToRegExp(glob) {
  const special = /[.+^$()|[\]\\]/g;
  let out = '';
  let i = 0;
  const g = String(glob).replace(/\\/g, '/');
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        out += '.*';
        i += 2;
        if (g[i] === '/') i++;
        continue;
      }
      out += '[^/]*';
      i++;
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end > 0) {
        const alts = g.slice(i + 1, end).split(',').map((s) => s.replace(special, '\\$&'));
        out += `(?:${alts.join('|')})`;
        i = end + 1;
      } else {
        out += '\\{';
        i++;
      }
    } else if (c === '[') {
      const end = g.indexOf(']', i);
      if (end > 0) {
        out += g.slice(i, end + 1);
        i = end + 1;
      } else {
        out += '\\[';
        i++;
      }
    } else {
      out += special.test(c) ? '\\' + c : c;
      i++;
    }
  }
  return new RegExp('^' + out + '$');
}

export async function findFiles(projectId, glob, { limit = 300 } = {}) {
  const tree = await listTree(projectId, { maxFiles: 6000, maxDepth: 10 });
  const re = globToRegExp(glob || '**/*');
  return tree.filter((f) => !f.dir && re.test(f.path)).slice(0, limit);
}

export async function searchFiles(projectId, pattern, { glob, limit = 200, caseSensitive = false, regex = true } = {}) {
  const tree = await listTree(projectId, { maxFiles: 6000, maxDepth: 10 });
  let re;
  try {
    re = regex ? new RegExp(pattern, caseSensitive ? 'g' : 'gi') : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
  } catch (err) {
    throw bad(`Invalid pattern: ${err.message}`);
  }
  const globRe = glob ? globToRegExp(glob) : null;
  const results = [];
  for (const f of tree) {
    if (f.dir) continue;
    if (globRe && !globRe.test(f.path)) continue;
    if (f.size > 2 * 1024 * 1024) continue;
    let text;
    try {
      text = await fsp.readFile(path.join(config.workspaceRoot, projectId, f.path), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        results.push({ path: f.path, line: i + 1, text: lines[i].slice(0, 400) });
        if (results.length >= limit) return results;
      }
    }
  }
  return results;
}

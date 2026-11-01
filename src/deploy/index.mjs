/**
 * Deployment engine: Cloudflare Pages, Netlify, Vercel — plus a claimable
 * preview URL for users who have not connected a provider token yet.
 *
 * Provider tokens are per-user, encrypted at rest, and fall back to
 * instance-level tokens from the environment when present.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.mjs';
import { log } from '../lib/log.mjs';
import { getStore } from '../lib/store.mjs';
import { buildProject } from '../runtime/runtimes.mjs';
import { randomId, randomToken } from '../lib/crypto.mjs';
import { bad } from '../lib/http.mjs';

const MAX_UPLOAD_FILES = 2000;
const MAX_UPLOAD_BYTES = 90 * 1024 * 1024;

const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.xml', '.webmanifest', '.map', '.ico', '.wasm', '.csv', '.md']);

async function walk(dir, base = dir, acc = []) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (acc.length > MAX_UPLOAD_FILES) break;
    if (['node_modules', '.git', '.venv', '.next', '__pycache__', '.alphacode'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, acc);
    else if (e.isFile()) {
      const stat = await fsp.stat(full);
      acc.push({ abs: full, rel: '/' + path.relative(base, full).split(path.sep).join('/'), size: stat.size });
    }
  }
  return acc;
}

export function tokensFor(userSettings, provider) {
  const tokens = userSettings?.deployTokensParsed || {};
  const env = config.deploy[provider] || {};
  const user = tokens[provider] || {};
  return {
    token: user.token || env.token || '',
    accountId: user.accountId || env.accountId || '',
    teamId: user.teamId || env.teamId || '',
    from: user.token ? 'user' : env.token ? 'instance' : 'none',
  };
}

export function deploymentCapabilities(userSettings) {
  const out = {};
  for (const p of ['cloudflare', 'netlify', 'vercel']) {
    const t = tokensFor(userSettings, p);
    out[p] = { connected: Boolean(t.token), source: t.from, needsAccountId: p === 'cloudflare' && !t.accountId };
  }
  return out;
}

/**
 * Deploy a project.
 * @returns {Promise<{provider,url,claimToken?,deploymentId,message,display}>}
 */
export async function deployProject({
  target = 'preview',
  projectDir,
  projectId,
  userId,
  userSettings,
  origin = 'http://localhost:3000',
  projectName = 'alphacode-app',
  onProgress = () => {},
}) {
  const store = getStore();
  const slug = slugify(projectName);
  const caps = deploymentCapabilities(userSettings);
  const explicit = target && target !== 'preview';

  onProgress('preparing build…');
  let build;
  try {
    build = await buildProject(projectDir, (line) => onProgress(String(line).slice(0, 500)));
  } catch (err) {
    throw bad(`Build failed: ${err.message.slice(0, 1200)}`);
  }
  const files = await walk(build.dir);
  if (!files.length) throw bad('Nothing to deploy — the build produced no files.');
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  if (totalBytes > MAX_UPLOAD_BYTES) throw bad(`Build is too large to deploy (${Math.round(totalBytes / 1024 / 1024)} MB > 90 MB).`);
  onProgress(`build ready: ${files.length} files, ${(totalBytes / 1024).toFixed(0)} KB (${build.framework})`);

  const attempts = explicit ? [target] : ['cloudflare', 'netlify', 'vercel'];
  for (const provider of attempts) {
    const t = tokensFor(userSettings, provider);
    if (!t.token) continue;
    try {
      onProgress(`deploying to ${provider}…`);
      const result = await deployToProvider(provider, { files, tokens: t, slug, build, onProgress });
      const deployment = store.createDeployment({
        projectId,
        userId,
        provider,
        url: result.url,
        status: 'live',
        meta: { files: files.length, framework: build.framework, target: build.kind },
      });
      onProgress(`live at ${result.url}`);
      return {
        provider,
        url: result.url,
        deploymentId: deployment.id,
        message: `Deployed to ${provider}: ${result.url}`,
        display: { provider, url: result.url, files: files.length, framework: build.framework },
      };
    } catch (err) {
      log.warn(`${provider} deploy failed: ${err.message}`);
      onProgress(`${provider} deploy failed: ${err.message}`);
      if (explicit && target !== 'preview') {
        throw bad(`${provider} deploy failed: ${err.message}`);
      }
    }
  }

  // No usable credentials → create a claimable preview.
  onProgress('no provider token — creating a claimable preview…');
  return createClaimablePreview({ files, build, projectId, userId, origin, slug, onProgress });
}

async function createClaimablePreview({ files, build, projectId, userId, origin, slug, onProgress }) {
  const store = getStore();
  const id = randomId('dep_', 10);
  const dir = path.join(config.dataDir, 'deploys', id);
  await fsp.mkdir(dir, { recursive: true });
  for (const f of files) {
    const dest = path.join(dir, f.rel.replace(/^\//, ''));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(f.abs, dest);
  }
  const claimToken = randomToken(24);
  const claimExpires = Date.now() + config.deploy.claimTtlHours * 3600_000;
  const url = `${trimOrigin(origin)}/p/${id}/`;
  const deployment = store.createDeployment({
    projectId,
    userId,
    provider: 'local',
    status: 'claimable',
    url,
    claimToken,
    claimExpires,
    meta: { files: files.length, framework: build.framework, slug, size: files.reduce((s, f) => s + f.size, 0) },
  });
  const claimUrl = `${trimOrigin(origin)}/claim/${claimToken}`;
  onProgress(`preview ready (unclaimed): ${url}`);
  return {
    provider: 'preview',
    url,
    claimUrl,
    claimToken,
    deploymentId: deployment.id,
    message: [
      `Preview published: ${url}`,
      `No provider token is connected, so this deployment is **unclaimed**. The user must open ${claimUrl} (or press “Claim URL” in AlphaCode) and sign in to keep it.`,
      `Claim link expires in ${Math.round(config.deploy.claimTtlHours / 24)} days.`,
    ].join('\n'),
    display: { provider: 'preview', url, claimUrl, claimable: true, files: files.length, framework: build.framework, expiresAt: new Date(claimExpires).toISOString() },
  };
}

async function deployToProvider(provider, { files, tokens, slug, build, onProgress }) {
  if (provider === 'cloudflare') return deployCloudflare({ files, tokens, slug, onProgress });
  if (provider === 'netlify') return deployNetlify({ files, tokens, slug, onProgress });
  if (provider === 'vercel') return deployVercel({ files, tokens, slug, build, onProgress });
  throw bad(`Unknown deploy target: ${provider}`);
}

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(120000) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const detail = json?.errors?.[0]?.message || json?.error?.message || json?.message || text.slice(0, 400);
    throw new Error(`HTTP ${res.status} ${detail || ''}`.trim());
  }
  return json;
}

// ------------------------------------------------------------- Cloudflare ---
async function deployCloudflare({ files, tokens, slug, onProgress }) {
  const { token } = tokens;
  let { accountId } = tokens;
  if (!accountId) {
    const accounts = await apiFetch(`${config.deploy.cloudflare.api}/accounts?per_page=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    accountId = accounts?.result?.[0]?.id;
    if (!accountId) throw new Error('No Cloudflare account found for this token (set an Account ID in Settings).');
  }
  const base = `${config.deploy.cloudflare.api}/accounts/${accountId}/pages/projects`;
  const projectName = slug.slice(0, 58);

  // Create the Pages project if it does not exist yet.
  const existing = await fetch(`${base}/${projectName}`, { headers: { Authorization: `Bearer ${token}` } });
  if (existing.status === 404) {
    onProgress(`creating Cloudflare Pages project "${projectName}"…`);
    await apiFetch(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: projectName, production_branch: 'main' }),
    });
  } else if (!existing.ok) {
    throw new Error(`Cloudflare project lookup failed (HTTP ${existing.status})`);
  }

  const manifest = {};
  const blobs = new Map();
  for (const f of files) {
    const buf = await fsp.readFile(f.abs);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    manifest[f.rel] = hash;
    blobs.set(hash, { buf, rel: f.rel });
  }
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  for (const [hash, { buf, rel }] of blobs) {
    form.append(hash, new Blob([buf], { type: guessType(rel) }), path.basename(rel));
  }
  onProgress('uploading files to Cloudflare…');
  const data = await apiFetch(`${base}/${projectName}/deployments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  }).catch(async (err) => {
    // Older API shapes want a branch + commit metadata.
    if (!/HTTP 4/.test(err.message)) throw err;
    const form2 = new FormData();
    form2.append('manifest', JSON.stringify(manifest));
    form2.append('branch', 'main');
    return apiFetch(`${base}/${projectName}/deployments`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form2 });
  });
  const url = data?.result?.url || `https://${projectName}.pages.dev`;
  return { url };
}

// ---------------------------------------------------------------- Netlify ---
async function deployNetlify({ files, tokens, slug, onProgress }) {
  const { token } = tokens;
  const api = config.deploy.netlify.api;
  const headers = { Authorization: `Bearer ${token}` };

  const sites = await apiFetch(`${api}/sites?name=${encodeURIComponent(slug)}&per_page=100`, { headers });
  let site = (Array.isArray(sites) ? sites : []).find((s) => s.name === slug);
  if (!site) {
    onProgress('creating Netlify site…');
    site = await apiFetch(`${api}/sites`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: slug }),
    }).catch(async (err) => {
      if (/HTTP 422/.test(err.message)) return apiFetch(`${api}/sites`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      throw err;
    });
  }
  if (!site?.id) throw new Error('Netlify did not return a site id');

  // Digest-based deploy: no zip dependency required.
  const digests = {};
  for (const f of files) {
    const buf = await fsp.readFile(f.abs);
    digests[f.rel] = crypto.createHash('sha1').update(buf).digest('hex');
  }
  const deploy = await apiFetch(`${api}/sites/${site.id}/deploys`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: digests }),
  });
  const required = deploy?.required || [];
  onProgress(`uploading ${required.length || files.length} files to Netlify…`);
  for (const sha of required) {
    const entry = files.find((f) => crypto.createHash('sha1').update(fs.readFileSync(f.abs)).digest('hex') === sha);
    if (!entry) continue;
    const buf = await fsp.readFile(entry.abs);
    const upload = await fetch(`${api}/deploys/${deploy.id}/files${entry.rel}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
    if (!upload.ok) throw new Error(`Netlify upload failed for ${entry.rel} (HTTP ${upload.status})`);
  }
  const url = deploy?.ssl_url || deploy?.url || site.ssl_url || site.url || `https://${site.name}.netlify.app`;
  return { url };
}

// ----------------------------------------------------------------- Vercel ---
async function deployVercel({ files, tokens, slug, build, onProgress }) {
  const { token, teamId } = tokens;
  const api = config.deploy.vercel.api;
  const upload = [];
  for (const f of files.slice(0, 900)) {
    const buf = await fsp.readFile(f.abs);
    if (buf.length > 6 * 1024 * 1024) continue;
    upload.push({ file: f.rel.replace(/^\//, ''), data: buf.toString('base64') });
  }
  onProgress(`deploying ${upload.length} files to Vercel…`);
  const qs = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
  const body = {
    name: slug.slice(0, 52),
    files: upload,
    target: 'production',
    projectSettings: {
      framework: vercelFramework(build.framework),
      buildCommand: null,
      outputDirectory: '.',
      rootDirectory: null,
    },
  };
  const data = await apiFetch(`${api}/v13/deployments${qs}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const url = data?.alias?.[0] ? `https://${data.alias[0]}` : data?.url ? `https://${data.url}` : '';
  if (!url) throw new Error('Vercel did not return a deployment URL');
  return { url };
}

function vercelFramework(framework) {
  const map = { next: 'nextjs', nuxt: 'nuxtjs', sveltekit: 'sveltekit', astro: 'astro', vite: 'vite', react: 'vite', cra: 'create-react-app', vue: 'vue', angular: 'angular', gatsby: 'gatsby' };
  return map[framework] || null;
}

// ------------------------------------------------------------------ utils ---
export function slugify(name) {
  const base = String(name || 'alphacode-app')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return (base || 'alphacode-app') + '-' + randomId('', 4).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4);
}

function guessType(rel) {
  const ext = path.extname(rel).toLowerCase();
  const map = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain',
  };
  return map[ext] || 'application/octet-stream';
}

function trimOrigin(origin) {
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'http://localhost:3000';
  }
}

export function previewDir(id) {
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(String(id))) return null;
  return path.join(config.dataDir, 'deploys', id);
}

export function listPreviewFiles(id) {
  const dir = previewDir(id);
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  const walkSync = (d, base) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walkSync(full, base);
      else out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  };
  walkSync(dir, dir);
  return out;
}

export { TEXT_EXT };

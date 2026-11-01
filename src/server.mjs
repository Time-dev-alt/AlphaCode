/**
 * AlphaCode server — HTTP entrypoint.
 *
 * Zero runtime dependencies. Serves the SPA, the agent SSE streams, the real
 * terminal, the database explorer, deployments and claimable previews.
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { config, ensureDirs } from './config.mjs';
import { log, redact } from './lib/log.mjs';
import { getStore } from './lib/store.mjs';
import {
  Router,
  HttpError,
  bad,
  notFound,
  forbidden,
  unauthorized,
  tooMany,
  readJson,
  sendJson,
  redirect,
  openSSE,
  parseCookies,
  serializeCookie,
  serveFile,
  securityHeaders,
  clientIp,
  RateLimiter,
  safeJson,
} from './lib/http.mjs';
import { randomId, encrypt, decrypt, mask, fingerprint } from './lib/crypto.mjs';
import { SESSION_COOKIE, CSRF_COOKIE, resolveSession, ensureCsrf, verifyCsrf, register, login, logout, requireUser, attachUserToSession, ownerKey } from './auth.mjs';
import { describeRouting, buildModelCatalog, assertQuota, bumpUsage, currentUsage, planModelRequest, parseModelRef } from './policy.mjs';
import { getRun, createRun, AgentHarness, runningForThread, shutdownRuns } from './agent/harness.mjs';
import { detect, installVersion, prepareProject, readPins } from './runtime/runtimes.mjs';
import { terminals, attachTerminal } from './runtime/pty.mjs';
import { ensureWorkspace, listTree, readFileSafe, writeFileSafe, deleteSafe, searchFiles, projectWorkspace } from './runtime/paths.mjs';
import * as git from './runtime/git.mjs';
import * as dbr from './runtime/database.mjs';
import { deployProject, deploymentCapabilities, previewDir, tokensFor } from './deploy/index.mjs';
import { PROVIDER_META, platformConfigured, streamChat } from './providers/index.mjs';

ensureDirs();
const store = getStore();
const startedAt = Date.now();

// ---------------------------------------------------------------- limits -----
const limits = {
  api: new RateLimiter({ windowMs: 60_000, max: 600 }),
  auth: new RateLimiter({ windowMs: 5 * 60_000, max: 40 }),
  chat: new RateLimiter({ windowMs: 60_000, max: 60 }),
  guestChat: new RateLimiter({ windowMs: 3600_000, max: config.guestTurnsPerHour }),
  deploy: new RateLimiter({ windowMs: 3600_000, max: 20 }),
  claim: new RateLimiter({ windowMs: 60_000, max: 15 }),
  terminal: new RateLimiter({ windowMs: 60_000, max: 120 }),
};

// ----------------------------------------------------------------- utils -----
function settingsFor(ctx) {
  // Guests keep BYOK keys in memory for the life of their session (never stored).
  if (!ctx.user) {
    const guest = globalThis.__guestSettings?.get(ctx.session?.id) || {};
    return { raw: null, byokParsed: guest.byok || {}, deployTokensParsed: guest.deployTokens || {}, prefs: guest.prefs || {} };
  }
  const row = store.settings(ctx.user.id);
  const byok = safeParse(decrypt(row.byok), {});
  const deployTokens = safeParse(decrypt(row.deploy_tokens), {});
  const prefs = safeParse(row.prefs, {});
  return {
    raw: row,
    byokParsed: byok,
    deployTokensParsed: deployTokens,
    prefs: prefs && typeof prefs === 'object' ? prefs : {},
  };
}

function safeParse(str, fallback) {
  try {
    return str ? JSON.parse(str) : fallback;
  } catch {
    return fallback;
  }
}

function renderMessage(m) {
  return { id: m.id, seq: m.seq, role: m.role, content: m.content || {}, meta: m.meta || {}, createdAt: m.created_at };
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, email: user.email, name: user.name, createdAt: user.created_at };
}

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`).split(',')[0].trim();
  const safeHost = /^[a-zA-Z0-9.\-:\[\]]+$/.test(host) ? host : `localhost:${config.port}`;
  return `${proto === 'https' ? 'https' : 'http'}://${safeHost}`;
}

async function projectFor(ctx, projectId, { requireOwner = true } = {}) {
  const project = store.getProject(projectId);
  if (!project) throw notFound('Project not found');
  const owner = ownerKey(ctx);
  if (requireOwner && project.user_id && project.user_id !== owner) {
    if (ctx.user && project.user_id === `user:${ctx.user.id}`) {
      /* same owner */
    } else throw forbidden('You do not have access to this project');
  }
  await ensureWorkspace(project.id);
  return project;
}

function parseBool(v) {
  return /^(1|true|yes|on)$/i.test(String(v));
}

const MIME_PREVIEW = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
};

// --------------------------------------------------------------- handlers ----
const api = new Router();

api.get('/healthz', (ctx) => {
  const uptimeMs = Date.now() - startedAt;
  sendJson(ctx.res, 200, {
    ok: true,
    uptime: Math.round(uptimeMs / 1000),
    uptimeMs,
    version: '2.0.0',
    runtime: { node: process.version, platform: process.platform, arch: process.arch, pid: process.pid },
  });
});

api.get('/api/bootstrap', async (ctx) => {
  const settings = settingsFor(ctx);
  const runtime = await detect().catch(() => null);
  const projects = ctx.user || ctx.session
    ? store.listProjectsByOwnerKey(ownerKey(ctx))
    : [];
  const routing = describeRouting(ctx, settings);
  sendJson(ctx.res, 200, {
    user: publicUser(ctx.user),
    guest: !ctx.user,
    sessionId: ctx.session?.id,
    csrf: ctx.csrf,
    routing,
    quota: routing.quota,
    projects: projects.map((p) => ({ id: p.id, name: p.name, updatedAt: p.updated_at })),
    providers: publicProviders(settings),
    deploy: deploymentCapabilities(settings),
    runtime,
    contextWindow: config.agent.contextWindow,
    capabilities: {
      terminal: process.platform !== 'win32',
      database: true,
      deploy: ['cloudflare', 'netlify', 'vercel', 'preview'],
      maxIterations: config.agent.maxIterations,
      dailyRequests: config.dailyRequests,
      guestModel: config.guestModel,
    },
    prefs: settings.prefs,
    version: '2.0.0',
    instance: { registration: config.allowRegistration, mock: config.mock },
  });
});

function publicProviders(settings) {
  const out = {};
  for (const [id, meta] of Object.entries(PROVIDER_META)) {
    const platform = Boolean(config.providers[id]);
    const byok = Boolean(settings.byokParsed?.[id]?.key);
    if (!platform && !byok && !meta.byok) continue;
    out[id] = {
      id,
      label: meta.label,
      platformConfigured: platformConfigured(id),
      byok,
      keyMask: byok ? mask(settings.byokParsed[id].key) : '',
      model: settings.byokParsed?.[id]?.model || '',
      baseUrl: settings.byokParsed?.[id]?.baseUrl || '',
      byokAllowed: true,
      docs: meta.docs || '',
    };
  }
  return out;
}

api.get('/api/models', async (ctx) => {
  const settings = settingsFor(ctx);
  const cacheKey = `${ownerKey(ctx)}:${Date.now() >> 17}`;
  const providers = await buildModelCatalog(ctx, settings);
  sendJson(ctx.res, 200, { providers, routing: describeRouting(ctx, settings), key: cacheKey });
});

// ------------------------------------------------------------------ auth -----
api.post('/api/auth/register', async (ctx) => {
  const rl = limits.auth.hit(`auth:${clientIp(ctx.req)}`);
  if (!rl.ok) throw tooMany('Too many attempts — try again in a few minutes');
  const body = await readJson(ctx.req);
  const user = register(ctx.req, body);
  attachUserToSession(ctx.req, ctx.res, user.id);
  migrateGuestProjects(ctx, user.id);
  store.audit({ userId: user.id, action: 'register_ok', ip: clientIp(ctx.req) });
  sendJson(ctx.res, 201, { user: publicUser(user) });
});

api.post('/api/auth/login', async (ctx) => {
  const rl = limits.auth.hit(`auth:${clientIp(ctx.req)}`);
  if (!rl.ok) throw tooMany('Too many attempts — try again in a few minutes');
  const body = await readJson(ctx.req);
  const user = login(ctx.req, body);
  attachUserToSession(ctx.req, ctx.res, user.id);
  migrateGuestProjects(ctx, user.id);
  sendJson(ctx.res, 200, { user: publicUser(user) });
});

api.post('/api/auth/logout', async (ctx) => {
  logout(ctx.req, ctx.res);
  sendJson(ctx.res, 200, { ok: true });
});

api.get('/api/auth/me', async (ctx) => {
  sendJson(ctx.res, 200, { user: publicUser(ctx.user), guest: !ctx.user });
});

function migrateGuestProjects(ctx, userId) {
  try {
    const guestKey = `guest:${ctx.session?.id}`;
    const rows = store.listProjectsByOwnerKey(guestKey);
    for (const p of rows) store.run('UPDATE projects SET user_id = ? WHERE id = ?', `user:${userId}`, p.id);
    if (rows.length) log.info(`migrated ${rows.length} guest project(s) to user ${userId.slice(0, 8)}`);
  } catch (err) {
    log.debug('migration failed: ' + err.message);
  }
}

// -------------------------------------------------------------- projects -----
api.get('/api/projects', async (ctx) => {
  const projects = store.listProjectsByOwnerKey(ownerKey(ctx));
  sendJson(ctx.res, 200, { projects: projects.map((p) => ({ id: p.id, name: p.name, updatedAt: p.updated_at, createdAt: p.created_at })) });
});

api.post('/api/projects', async (ctx) => {
  const body = await readJson(ctx.req);
  const name = String(body.name || 'Untitled project').slice(0, 80).trim() || 'Untitled project';
  const project = store.createProject({ userId: ownerKey(ctx), name, slug: randomId('', 6) });
  await ensureWorkspace(project.id);
  await git.ensureGit(projectWorkspace(project.id)).catch(() => {});
  const thread = store.createThread({ projectId: project.id, userId: ctx.user?.id || null, title: 'New session', mode: 'default' });
  store.audit({ userId: ctx.user?.id, action: 'project_create', detail: project.id, ip: clientIp(ctx.req) });
  sendJson(ctx.res, 201, { project: { id: project.id, name: project.name }, thread: { id: thread.id, title: thread.title } });
});

api.get('/api/projects/:id', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const threads = store.listThreads(project.id);
  const threadId = String(ctx.query.thread || threads[0]?.id || '');
  const thread = threads.find((t) => t.id === threadId) || threads[0] || null;
  const messages = thread ? store.listMessages(thread.id) : [];
  const settings = settingsFor(ctx);
  const pins = await readPins(projectWorkspace(project.id)).catch(() => ({}));
  sendJson(ctx.res, 200, {
    project: { id: project.id, name: project.name, createdAt: project.created_at, updatedAt: project.updated_at },
    threads: threads.map((t) => ({ id: t.id, title: t.title, updatedAt: t.updated_at, model: t.model, mode: t.mode })),
    activeThread: thread ? { id: thread.id, title: thread.title, model: thread.model, mode: thread.mode } : null,
    messages: messages.map(renderMessage),
    files: await listTree(project.id, { maxDepth: 5, maxFiles: 900 }),
    databases: dbr.dbFiles(project.id),
    deployments: store.listDeployments(project.id).map(publicDeployment),
    git: await git.status(projectWorkspace(project.id)).catch(() => ({ branch: '', changes: [] })),
    pins,
    deploy: deploymentCapabilities(settings),
    running: Boolean(runningForThread(thread?.id)),
    runtime: await detect().catch(() => null),
  });
});

api.patch('/api/projects/:id', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const body = await readJson(ctx.req);
  if (body.name) store.run('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?', String(body.name).slice(0, 80), Date.now(), project.id);
  sendJson(ctx.res, 200, { ok: true });
});

api.delete('/api/projects/:id', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  store.deleteProject(project.id);
  await fsp.rm(projectWorkspace(project.id), { recursive: true, force: true }).catch(() => {});
  store.audit({ userId: ctx.user?.id, action: 'project_delete', detail: project.id, ip: clientIp(ctx.req) });
  sendJson(ctx.res, 200, { ok: true });
});

api.post('/api/projects/:id/threads', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const body = await readJson(ctx.req).catch(() => ({}));
  const thread = store.createThread({ projectId: project.id, userId: ctx.user?.id || null, title: body.title || 'New session' });
  sendJson(ctx.res, 201, { thread: { id: thread.id, title: thread.title } });
});

api.post('/api/projects/:id/threads/:threadId/clear', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const thread = store.getThread(ctx.params.threadId);
  if (!thread || thread.project_id !== project.id) throw notFound('Session not found');
  if (runningForThread(thread.id)) throw bad('Stop the running agent first');
  store.clearMessages(thread.id);
  sendJson(ctx.res, 200, { ok: true });
});

// ------------------------------------------------------------------ chat -----
api.post('/api/projects/:id/chat', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const body = await readJson(ctx.req);
  const text = String(body.text || '').slice(0, 60_000);
  if (!text.trim()) throw bad('Message is empty');

  const isGuest = !ctx.user;
  const rl = isGuest
    ? limits.guestChat.hit(`guest:${ctx.session?.id || clientIp(ctx.req)}`)
    : limits.chat.hit(`chat:${ctx.user.id}`);
  if (!rl.ok) throw tooMany(isGuest ? 'Guest rate limit reached — sign in for 40 requests/day' : 'Slow down a moment', 'rate_limited');

  const settings = settingsFor(ctx);
  const modelRef = String(body.model || '').slice(0, 160);
  const mode = ['default', 'acceptEdits', 'plan', 'bypass'].includes(body.mode) ? body.mode : 'default';
  const parsed = parseModelRef(modelRef);
  const usesPlatform = ctx.user && !(parsed && settings.byokParsed?.[parsed.provider]?.key);
  if (usesPlatform) assertQuota(ctx, 1);

  let thread = body.threadId ? store.getThread(String(body.threadId)) : null;
  if (!thread || thread.project_id !== project.id) {
    thread = store.listThreads(project.id)[0] || store.createThread({ projectId: project.id, userId: ctx.user?.id || null });
  }
  if (runningForThread(thread.id)) throw Object.assign(new Error('The agent is already working in this session'), { status: 409, code: 'run_in_progress' });

  const { run, cleanup } = createRun({ project, thread, user: ctx.user, guest: isGuest });
  const projectDir = projectWorkspace(project.id);
  const emit = (event) => run.emitEvent(event);

  const userSettings = settings;
  const harness = new AgentHarness({
    run,
    project,
    thread,
    user: ctx.user,
    settings: { ...settings, byokParsed: settings.byokParsed },
    requestedModel: modelRef,
    mode,
    projectDir,
    externalConnections: [],
    deploy: async (args) => {
      const userCtx = { user: ctx.user, session: ctx.session };
      const t = tokensFor(userSettings, args.target === 'preview' ? 'cloudflare' : args.target);
      return deployProject({
        target: args.target,
        projectDir: args.projectDir,
        projectId: args.projectId,
        userId: args.userId,
        userSettings,
        origin: requestOrigin(ctx.req),
        projectName: args.projectName || project.name,
        onProgress: (line) => run.emitEvent({ type: 'deploy_progress', text: String(line).slice(0, 800) }),
      });
    },
  });

  run.harness = harness;
  run.status = 'running';
  emit({ type: 'start', runId: run.id, threadId: thread.id, projectId: project.id, model: modelRef, mode, guest: isGuest });
  store.audit({ userId: ctx.user?.id, action: 'chat', detail: `${project.id}/${thread.id}${isGuest ? ' (guest)' : ''}`, ip: clientIp(ctx.req) });
  if (usesPlatform) bumpUsage(ctx, { turns: 1 });

  (async () => {
    try {
      const result = await harness.send(text, { attachments: body.attachments || [] });
      run.status = result.finishReason === 'error' ? 'error' : result.finishReason === 'stopped' ? 'stopped' : 'done';
      emit({
        type: 'done',
        finishReason: result.finishReason,
        steps: result.steps,
        usage: harness.usage,
        filesChanged: [...harness.filesChanged],
        model: harness.model,
        provider: harness.provider,
        quota: describeRouting({ user: ctx.user, session: ctx.session }, settingsFor(ctx)).quota,
      });
    } catch (err) {
      log.error(`run ${run.id} failed: ${err.message}`);
      run.status = 'error';
      emit({ type: 'error', message: publicError(err), code: err.code || 'run_failed' });
      emit({ type: 'done', finishReason: 'error', steps: 0, usage: harness?.usage });
    } finally {
      run.closeSubscribers();
      cleanup();
      store.touchProject(project.id);
    }
  })();

  sendJson(ctx.res, 202, { runId: run.id, threadId: thread.id });
});

api.get('/api/runs/:runId/stream', async (ctx) => {
  const run = getRun(ctx.params.runId);
  if (!run) throw notFound('Run not found or expired');
  if (!ctx.user && run.guest && run.userId) throw forbidden('Not your run');
  const sse = openSSE(ctx.req, ctx.res);
  // Authorise before streaming.
  const project = store.getProject(run.projectId);
  if (project && project.user_id !== ownerKey(ctx) && project.user_id !== `user:${ctx.user?.id}`) {
    sse.close();
    throw forbidden('Not your run');
  }
  run.attach(sse, Number(ctx.query.from || 0));
});

api.post('/api/runs/:runId/stop', async (ctx) => {
  const run = getRun(ctx.params.runId);
  if (!run) throw notFound('Run not found');
  run.stop();
  sendJson(ctx.res, 200, { ok: true });
});

api.post('/api/runs/:runId/permission', async (ctx) => {
  const run = getRun(ctx.params.runId);
  if (!run) throw notFound('Run not found');
  const body = await readJson(ctx.req);
  const ok = run.resolvePermission(String(body.requestId || ''), { approved: Boolean(body.approved), reason: body.reason });
  sendJson(ctx.res, 200, { ok });
});

// -------------------------------------------------------------------- fs -----
api.get('/api/projects/:id/files', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const files = await listTree(project.id, { maxDepth: Number(ctx.query.depth || 6), maxFiles: 4000 });
  sendJson(ctx.res, 200, { files });
});

api.get('/api/projects/:id/file', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const rel = String(ctx.query.path || '');
  if (!rel) throw bad('path is required');
  const file = await readFileSafe(project.id, rel);
  sendJson(ctx.res, 200, file);
});

api.put('/api/projects/:id/file', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const body = await readJson(ctx.req);
  if (typeof body.content !== 'string') throw bad('content is required');
  if (body.content.length > 6 * 1024 * 1024) throw bad('File too large');
  const res = await writeFileSafe(project.id, String(body.path || ''), body.content);
  await git.checkpoint(project.id, projectWorkspace(project.id), `editor: ${body.path}`).catch(() => {});
  sendJson(ctx.res, 200, res);
});

api.delete('/api/projects/:id/file', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  await deleteSafe(project.id, String(ctx.query.path || ''));
  sendJson(ctx.res, 200, { ok: true });
});

api.get('/api/projects/:id/search', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const q = String(ctx.query.q || '');
  if (!q) return sendJson(ctx.res, 200, { results: [] });
  const results = await searchFiles(project.id, q, { limit: 100, glob: ctx.query.glob ? String(ctx.query.glob) : undefined });
  sendJson(ctx.res, 200, { results });
});

api.get('/api/projects/:id/export', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const dir = projectWorkspace(project.id);
  const name = project.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase() || 'project';
  ctx.res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${name}.tar.gz"`,
    'Cache-Control': 'no-store',
  });
  const child = spawn('tar', ['-czf', '-', '-C', dir, '--exclude=node_modules', '--exclude=.git', '--exclude=.venv', '.'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(ctx.res);
  child.stderr.on('data', (d) => log.debug('tar: ' + d.toString().slice(0, 200)));
  child.on('error', () => ctx.res.end());
  child.on('close', () => ctx.res.end());
});

// -------------------------------------------------------------- terminal -----
api.get('/api/projects/:id/terminals', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  sendJson(ctx.res, 200, { terminals: terminals.list(project.id) });
});

api.post('/api/projects/:id/terminal', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const rl = limits.terminal.hit(`term:${ownerKey(ctx)}`);
  if (!rl.ok) throw tooMany('Too many terminal sessions');
  const body = await readJson(ctx.req).catch(() => ({}));
  const session = await terminals.create({
    projectId: project.id,
    cwd: projectWorkspace(project.id),
    cols: Number(body.cols) || 120,
    rows: Number(body.rows) || 32,
  });
  store.audit({ userId: ctx.user?.id, action: 'terminal', detail: project.id, ip: clientIp(ctx.req) });
  sendJson(ctx.res, 201, { terminal: session.info });
});

api.get('/api/terminal/:sid/stream', async (ctx) => {
  const session = terminals.get(ctx.params.sid);
  if (!session) throw notFound('Terminal session not found');
  const project = store.getProject(session.projectId);
  if (!project || (project.user_id !== ownerKey(ctx) && project.user_id !== `user:${ctx.user?.id}`)) throw forbidden('Not your terminal');
  const sse = openSSE(ctx.req, ctx.res);
  attachTerminal(sse, session, { from: Number(ctx.query.from || 0) });
});

api.post('/api/terminal/:sid/input', async (ctx) => {
  const session = terminals.get(ctx.params.sid);
  if (!session) throw notFound('Terminal session not found');
  const project = store.getProject(session.projectId);
  if (!project || (project.user_id !== ownerKey(ctx) && project.user_id !== `user:${ctx.user?.id}`)) throw forbidden('Not your terminal');
  const body = await readJson(ctx.req);
  const ok = session.write(String(body.data || '').slice(0, 65536));
  sendJson(ctx.res, 200, { ok });
});

api.post('/api/terminal/:sid/resize', async (ctx) => {
  const session = terminals.get(ctx.params.sid);
  if (!session) throw notFound('Terminal session not found');
  const body = await readJson(ctx.req);
  await session.resize(body.cols, body.rows);
  sendJson(ctx.res, 200, { ok: true });
});

api.delete('/api/terminal/:sid', async (ctx) => {
  const session = terminals.get(ctx.params.sid);
  if (!session) throw notFound('Terminal session not found');
  const project = store.getProject(session.projectId);
  if (!project || (project.user_id !== ownerKey(ctx) && project.user_id !== `user:${ctx.user?.id}`)) throw forbidden('Not your terminal');
  terminals.close(session.id);
  sendJson(ctx.res, 200, { ok: true });
});

// -------------------------------------------------------------- database -----
api.get('/api/projects/:id/databases', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const settings = settingsFor(ctx);
  sendJson(ctx.res, 200, {
    files: dbr.dbFiles(project.id),
    engines: dbr.engineSummary(await detect().catch(() => null)),
    connections: [],
  });
});

api.get('/api/projects/:id/database/schema', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const handle = await dbr.openSqlite(project.id, String(ctx.query.path || ''));
  sendJson(ctx.res, 200, dbr.sqliteSchema(handle));
});

api.post('/api/projects/:id/database/query', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const body = await readJson(ctx.req);
  const handle = await dbr.openSqlite(project.id, String(body.path || ''));
  if (!dbr.isReadOnlySql(body.sql)) throw bad('Use the exec endpoint for write statements');
  sendJson(ctx.res, 200, dbr.sqliteQuery(handle, String(body.sql || '').slice(0, 20000)));
});

api.post('/api/projects/:id/database/exec', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const body = await readJson(ctx.req);
  if (!ctx.user) {
    // Guests can still edit their own sandbox database, but it is audited.
    store.audit({ userId: null, action: 'guest_db_write', detail: project.id, ip: clientIp(ctx.req) });
  }
  const handle = await dbr.openSqlite(project.id, String(body.path || ''));
  await git.checkpoint(project.id, projectWorkspace(project.id), 'db exec').catch(() => {});
  const res = dbr.sqliteQuery(handle, String(body.sql || '').slice(0, 20000));
  store.audit({ userId: ctx.user?.id, action: 'db_exec', detail: project.id, ip: clientIp(ctx.req) });
  sendJson(ctx.res, 200, res);
});

api.get('/api/projects/:id/database/rows', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const handle = await dbr.openSqlite(project.id, String(ctx.query.path || ''));
  sendJson(
    ctx.res,
    200,
    dbr.tableRows(handle, String(ctx.query.table || ''), {
      limit: Number(ctx.query.limit || 100),
      offset: Number(ctx.query.offset || 0),
      orderBy: ctx.query.orderBy ? String(ctx.query.orderBy) : '',
    }),
  );
});

api.post('/api/projects/:id/database/row', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const body = await readJson(ctx.req);
  const handle = await dbr.openSqlite(project.id, String(body.path || ''));
  await git.checkpoint(project.id, projectWorkspace(project.id), 'db row edit').catch(() => {});
  let result;
  if (body.action === 'delete') result = dbr.deleteRow(handle, String(body.table), Number(body.rowid));
  else if (body.action === 'insert') result = dbr.insertRow(handle, String(body.table), body.values || {});
  else result = dbr.updateRow(handle, String(body.table), Number(body.rowid), body.values || {});
  store.audit({ userId: ctx.user?.id, action: `db_${body.action || 'update'}`, detail: `${project.id}/${body.table}`, ip: clientIp(ctx.req) });
  sendJson(ctx.res, 200, result);
});

// ------------------------------------------------------------------ git ------
api.get('/api/projects/:id/git', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const dir = projectWorkspace(project.id);
  await git.ensureGit(dir).catch(() => {});
  sendJson(ctx.res, 200, {
    status: await git.status(dir),
    log: await git.history(dir, 30),
    checkpoints: store.listCheckpoints(project.id, 30),
    diff: ctx.query.diff ? await git.diff(dir) : null,
  });
});

api.post('/api/projects/:id/git/checkpoint', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const body = await readJson(ctx.req).catch(() => ({}));
  const sha = await git.checkpoint(project.id, projectWorkspace(project.id), body.label || 'manual checkpoint');
  sendJson(ctx.res, 200, { sha });
});

api.post('/api/projects/:id/git/rewind', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const body = await readJson(ctx.req);
  if (!body.sha) throw bad('sha is required');
  const result = await git.rewind(projectWorkspace(project.id), String(body.sha));
  store.audit({ userId: ctx.user?.id, action: 'rewind', detail: `${project.id}@${body.sha}`, ip: clientIp(ctx.req) });
  sendJson(ctx.res, 200, result);
});

// -------------------------------------------------------------- runtime ------
api.get('/api/runtime', async (ctx) => {
  const runtime = await detect({ force: parseBool(ctx.query.refresh) }).catch((err) => ({ error: err.message }));
  const settings = settingsFor(ctx);
  sendJson(ctx.res, 200, { runtime, byok: Object.keys(settings.byokParsed) });
});

api.post('/api/runtime/install', async (ctx) => {
  requireUser(ctx);
  const body = await readJson(ctx.req);
  const kind = String(body.kind || '');
  if (!['node', 'npm', 'python'].includes(kind)) throw bad('kind must be node, npm or python');
  const logs = [];
  try {
    const result = await installVersion(kind, body.version, (line) => logs.push(String(line).slice(0, 400)));
    sendJson(ctx.res, 200, { ok: true, result, logs });
  } catch (err) {
    sendJson(ctx.res, 400, { ok: false, error: err.message, logs });
  }
});

api.post('/api/projects/:id/install-deps', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const logs = [];
  const result = await prepareProject(projectWorkspace(project.id), (line) => logs.push(String(line).slice(0, 500)));
  sendJson(ctx.res, 200, { ok: result.steps.every((s) => s.ok !== false), steps: result.steps, logs: logs.slice(-200), pins: result.pins?.framework ? { framework: result.pins.framework } : {} });
});

// --------------------------------------------------------------- deploy ------
api.get('/api/deployments', async (ctx) => {
  if (!ctx.user) return sendJson(ctx.res, 200, { deployments: [], claimable: store.pendingClaims().map(publicDeployment) });
  sendJson(ctx.res, 200, {
    deployments: store.listDeploymentsForUser(ctx.user.id).map(publicDeployment),
    claimable: store.pendingClaims().map(publicDeployment),
    capabilities: deploymentCapabilities(settingsFor(ctx)),
  });
});

api.post('/api/projects/:id/deploy', async (ctx) => {
  const project = await projectFor(ctx, ctx.params.id);
  const rl = limits.deploy.hit(`deploy:${ownerKey(ctx)}`);
  if (!rl.ok) throw tooMany('Deploy limit reached for this hour');
  const body = await readJson(ctx.req);
  const target = ['cloudflare', 'netlify', 'vercel', 'preview'].includes(body.target) ? body.target : 'preview';
  const settings = settingsFor(ctx);
  const result = await deployProject({
    target,
    projectDir: projectWorkspace(project.id),
    projectId: project.id,
    userId: ctx.user?.id || null,
    userSettings: settings,
    origin: requestOrigin(ctx.req),
    projectName: String(body.projectName || project.name),
    onProgress: () => {},
  });
  store.audit({ userId: ctx.user?.id, action: 'deploy', detail: `${project.id}:${result.provider}`, ip: clientIp(ctx.req) });
  sendJson(ctx.res, 200, result);
});

api.get('/api/claim/:token', async (ctx) => {
  const deployment = store.getDeploymentByClaim(String(ctx.params.token || ''));
  if (!deployment) throw notFound('This claim link is invalid or was already used');
  if (deployment.claim_expires && deployment.claim_expires < Date.now()) throw notFound('This claim link has expired');
  const project = deployment.project_id ? store.getProject(deployment.project_id) : null;
  sendJson(ctx.res, 200, {
    deployment: {
      id: deployment.id,
      url: deployment.url,
      provider: deployment.provider,
      status: deployment.status,
      expiresAt: deployment.claim_expires,
      claimed: Boolean(deployment.claimed_by),
      files: deployment.meta?.files || 0,
      framework: deployment.meta?.framework || '',
      createdAt: deployment.created_at,
    },
    project: project ? { id: project.id, name: project.name } : null,
    requiresAuth: !ctx.user,
  });
});

api.post('/api/claim/:token', async (ctx) => {
  const rl = limits.claim.hit(`claim:${clientIp(ctx.req)}`);
  if (!rl.ok) throw tooMany('Too many claim attempts');
  const user = requireUser(ctx);
  const deployment = store.getDeploymentByClaim(String(ctx.params.token || ''));
  if (!deployment) throw notFound('This claim link is invalid or was already used');
  if (deployment.claimed_by) throw bad('This deployment has already been claimed');
  if (deployment.claim_expires && deployment.claim_expires < Date.now()) throw notFound('This claim link has expired');
  store.updateDeployment(deployment.id, { claimedBy: user.id, claimedAt: Date.now(), status: 'claimed', meta: { ...deployment.meta, claimed: true } });
  // Give the project to the user so it shows up in their workspace.
  if (deployment.project_id) {
    const project = store.getProject(deployment.project_id);
    if (project && !project.user_id?.startsWith(`user:`)) {
      store.run('UPDATE projects SET user_id = ? WHERE id = ?', `user:${user.id}`, project.id);
    }
  }
  store.audit({ userId: user.id, action: 'claim', detail: deployment.id, ip: clientIp(ctx.req) });
  sendJson(ctx.res, 200, {
    ok: true,
    projectId: deployment.project_id,
    url: deployment.url,
    message: 'Deployment claimed. The project now appears in your workspace.',
  });
});

function publicDeployment(d) {
  return {
    id: d.id,
    provider: d.provider,
    url: d.url,
    status: d.status,
    createdAt: d.created_at,
    claimed: Boolean(d.claimed_by),
    claimExpires: d.claim_expires,
    claimUrl: d.claim_token ? `/claim/${d.claim_token}` : '',
    files: d.meta?.files || 0,
    framework: d.meta?.framework || '',
    projectId: d.project_id,
  };
}

// -------------------------------------------------------------- settings -----
api.get('/api/settings', async (ctx) => {
  const settings = settingsFor(ctx);
  sendJson(ctx.res, 200, {
    providers: publicProviders(settings),
    deploy: deploymentCapabilities(settings),
    deployTokens: Object.fromEntries(
      Object.entries(settings.deployTokensParsed).map(([k, v]) => [k, { token: mask(v.token || ''), accountId: v.accountId || '', teamId: v.teamId || '' }]),
    ),
    prefs: settings.prefs,
    quota: describeRouting(ctx, settings).quota,
    audit: ctx.user ? store.listAudit(ctx.user.id, 40) : [],
  });
});

api.put('/api/settings', async (ctx) => {
  const body = await readJson(ctx.req);
  const current = settingsFor(ctx);
  const byok = { ...current.byokParsed };
  if (body.byok && typeof body.byok === 'object') {
    for (const [provider, entry] of Object.entries(body.byok)) {
      if (!PROVIDER_META[provider]) continue;
      if (entry === null) {
        delete byok[provider];
        continue;
      }
      const key = String(entry.key || '').trim();
      if (!key) continue;
      if (key.length > 400) throw bad('API key too long');
      byok[provider] = {
        key,
        model: String(entry.model || '').slice(0, 160),
        baseUrl: String(entry.baseUrl || '').slice(0, 300),
        addedAt: Date.now(),
        fp: fingerprint(key),
      };
      store.audit({ userId: ctx.user?.id, action: 'byok_set', detail: provider, ip: clientIp(ctx.req) });
    }
  }
  const deployTokens = { ...current.deployTokensParsed };
  if (body.deployTokens && typeof body.deployTokens === 'object') {
    for (const provider of ['cloudflare', 'netlify', 'vercel']) {
      const entry = body.deployTokens[provider];
      if (entry === null) {
        delete deployTokens[provider];
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const token = String(entry.token || '').trim();
      const next = { ...(deployTokens[provider] || {}) };
      if (token) next.token = token.slice(0, 400);
      if (entry.accountId !== undefined) next.accountId = String(entry.accountId || '').slice(0, 100);
      if (entry.teamId !== undefined) next.teamId = String(entry.teamId || '').slice(0, 100);
      if (next.token) deployTokens[provider] = next;
      if (token) store.audit({ userId: ctx.user?.id, action: 'deploy_token_set', detail: provider, ip: clientIp(ctx.req) });
    }
  }
  const prefs = { ...current.prefs, ...(body.prefs && typeof body.prefs === 'object' ? body.prefs : {}) };
  if (!ctx.user) {
    // Guests can hold BYOK keys for the life of their session only.
    const sid = ctx.session?.id;
    if (sid) {
      globalThis.__guestSettings ||= new Map();
      globalThis.__guestSettings.set(sid, { byok, deployTokens, prefs });
    }
    return sendJson(ctx.res, 200, { ok: true, guest: true, providers: publicProviders({ byokParsed: byok }), deploy: deploymentCapabilities({ deployTokensParsed: deployTokens }), prefs });
  }
  store.saveSettings(ctx.user.id, {
    byok: encrypt(JSON.stringify(byok)),
    deploy_tokens: encrypt(JSON.stringify(deployTokens)),
    prefs: JSON.stringify(prefs),
  });
  sendJson(ctx.res, 200, { ok: true, providers: publicProviders({ byokParsed: byok }), deploy: deploymentCapabilities({ deployTokensParsed: deployTokens }), prefs });
});

api.post('/api/settings/test', async (ctx) => {
  const body = await readJson(ctx.req);
  const provider = String(body.provider || '');
  const settings = settingsFor(ctx);
  if (!PROVIDER_META[provider]) throw bad('Unknown provider');
  const byok = settings.byokParsed?.[provider];
  const apiKey = byok?.key;
  if (!apiKey && !platformConfigured(provider)) throw bad('Add an API key first');
  const model = String(body.model || byok?.model || '').slice(0, 160);
  if (!model) throw bad('Pick a model to test');
  try {
    const res = await streamChat({
      provider,
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      system: 'You are a health check. Reply with OK.',
      apiKey,
      baseUrl: byok?.baseUrl,
      maxTokens: 16,
      onEvent: () => {},
    });
    sendJson(ctx.res, 200, { ok: true, reply: (res.content || '').slice(0, 80), provider, model });
  } catch (err) {
    sendJson(ctx.res, 400, { ok: false, error: err.message.slice(0, 300) });
  }
});

// --------------------------------------------------------------- previews ----
async function servePreview(ctx, id) {
  const dir = previewDir(id);
  if (!dir || !fs.existsSync(dir)) throw notFound('Preview not found');
  const rel = String(ctx.params.rest || ctx.query.path || '').replace(/^\/+/, '');
  const safeRel = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  let file = path.join(dir, safeRel || 'index.html');
  if (!file.startsWith(dir)) throw forbidden('Invalid path');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    const spa = path.join(dir, 'index.html');
    if (fs.existsSync(spa) && !path.extname(safeRel)) file = spa;
    else throw notFound('File not found in preview');
  }
  const body = await fsp.readFile(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  ctx.res.writeHead(200, {
    'Content-Type': MIME_PREVIEW[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    // Untrusted user content: run it in an opaque origin, never with our cookies.
    'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  ctx.res.end(body);
}

// ---------------------------------------------------------------- router -----
const router = new Router();
for (const r of api.routes) router.routes.push(r);

// Raw routes handled outside the JSON router.
async function rawHandler(req, res) {
  const url = new URL(req.url, requestOrigin(req));
  const pathname = url.pathname;
  req.cookies = parseCookies(req.headers.cookie || '');
  securityHeaders(req, res);

  // Previews (public, sandboxed).
  const previewMatch = pathname.match(/^\/p\/([A-Za-z0-9_-]{4,40})(\/.*)?$/);
  if (previewMatch) {
    const ctx = { req, res, params: { id: previewMatch[1], rest: (previewMatch[2] || '/').replace(/^\//, '') }, query: Object.fromEntries(url.searchParams) };
    try {
      await servePreview(ctx, previewMatch[1]);
    } catch (err) {
      const status = err.status || 500;
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(previewErrorPage(status, err.message));
    }
    return;
  }

  if (pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('User-agent: *\nDisallow: /api/\nDisallow: /p/\nDisallow: /claim/\n');
    return;
  }

  const { session, user } = resolveSession(req, res);
  req.session = session;
  req.user = user;
  const csrf = ensureCsrf(req, res);
  const ctx = {
    req,
    res,
    session,
    user,
    csrf,
    params: {},
    query: Object.fromEntries(url.searchParams),
    origin: requestOrigin(req),
  };

  // Serve the app shell.
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return (await serveFile(req, res, path.join(config.publicDir, 'index.html'))) || notFoundPage(res);
  }
  if (req.method === 'GET' && pathname === '/claim/' ) return redirect(res, '/');
  if (req.method === 'GET' && /^\/claim\/[A-Za-z0-9_-]{8,64}$/.test(pathname)) {
    return (await serveFile(req, res, path.join(config.publicDir, 'claim.html'))) || notFoundPage(res);
  }
  if (req.method === 'GET' && pathname === '/manifest.webmanifest') {
    return (await serveFile(req, res, path.join(config.publicDir, 'manifest.webmanifest'))) || notFoundPage(res);
  }
  if (req.method === 'GET' && (pathname === '/favicon.svg' || pathname === '/favicon.ico')) {
    const served = await serveFile(req, res, path.join(config.publicDir, 'favicon.svg'));
    if (served) return;
  }
  if (req.method === 'GET' && pathname.startsWith('/assets/')) {
    const rel = pathname.replace(/^\/assets\//, '');
    if (!/^[A-Za-z0-9._-]+$/.test(rel)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const candidates = [path.join(config.publicDir, 'assets', rel), path.join(config.distDir, 'assets', rel)];
    for (const file of candidates) {
      if (await serveFile(req, res, file)) return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  // API dispatch (plus /healthz, which lives outside the /api namespace).
  if (pathname.startsWith('/api/') || pathname === '/healthz') {
    const hit = router.match(req.method, pathname);
    if (!hit) {
      const allow = router.routes.filter((r) => r.pattern === pathname).map((r) => r.method);
      return sendJson(res, 404, { error: 'Unknown API endpoint', code: 'not_found', allow });
    }
    ctx.params = hit.params;
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutating && !verifyCsrf(req)) {
      return sendJson(res, 403, { error: 'Invalid CSRF token. Reload the page and try again.', code: 'csrf' });
    }
    const limiter = limits.api.hit(`api:${clientIp(req)}`);
    if (!limiter.ok) {
      res.setHeader('Retry-After', String(limiter.retryAfter || 60));
      return sendJson(res, 429, { error: 'Too many requests', code: 'rate_limited' });
    }
    try {
      await hit.route.handler(ctx);
    } catch (err) {
      handleError(ctx, err);
    }
    return;
  }

  // SPA fallback for app routes.
  if (req.method === 'GET' && !path.extname(pathname)) {
    const served = await serveFile(req, res, path.join(config.publicDir, 'index.html'), { 'Cache-Control': 'no-cache' });
    if (served) return;
  }
  notFoundPage(res);
}

function handleError(ctx, err) {
  const status = err instanceof HttpError ? err.status : err.status || 500;
  const code = err.code || (status === 500 ? 'internal_error' : 'error');
  if (status >= 500) log.error(`${ctx.req.method} ${ctx.req.url}: ${err.stack || err.message}`);
  else log.debug(`${ctx.req.method} ${ctx.req.url} → ${status} ${redact(err.message)}`);
  if (ctx.res.headersSent) {
    try {
      ctx.res.end();
    } catch {}
    return;
  }
  const payload = { error: publicError(err), code };
  if (err.detail) payload.detail = err.detail;
  if (status === 429) ctx.res.setHeader('Retry-After', String(err.retryAfter || 60));
  sendJson(ctx.res, status, payload);
}

function publicError(err) {
  const msg = String(err?.message || 'Something went wrong');
  if (err?.status && err.status < 500) return redact(msg);
  return config.env === 'production' ? redact(msg).slice(0, 300) : redact(msg);
}

function notFoundPage(res) {
  if (res.headersSent) return;
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>404 — AlphaCode</title>
<body style="background:#0a0b0f;color:#eef1f7;font:15px/1.6 system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:42px;font-weight:800;background:linear-gradient(135deg,#ff9d5c,#e2566a);-webkit-background-clip:text;background-clip:text;color:transparent">404</div>
<p style="color:#a6aebe">That route does not exist. <a style="color:#63b3ff" href="/">Back to AlphaCode</a></p></div></body>`);
}

function previewErrorPage(status, message) {
  return `<!doctype html><meta charset="utf-8"><title>${status} — preview</title>
<body style="background:#0a0b0f;color:#eef1f7;font:15px/1.6 system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:520px"><div style="font-size:38px;font-weight:800;color:#f2854f">${status}</div>
<p style="color:#a6aebe">${String(message).replace(/[<>&]/g, '')}</p></div></body>`;
}

// --------------------------------------------------------------- server ------
const server = http.createServer((req, res) => {
  const timer = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - timer;
    if (ms > 1500) log.warn(`slow ${req.method} ${req.url} ${ms}ms`);
  });
  rawHandler(req, res).catch((err) => {
    log.error('unhandled request error: ' + (err?.stack || err));
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error', code: 'internal_error' }));
    } else {
      try {
        res.end();
      } catch {}
    }
  });
});

server.headersTimeout = 60_000;
server.requestTimeout = 15 * 60_000;
server.keepAliveTimeout = 65_000;

server.listen(config.port, config.host, () => {
  const providers = Object.entries(config.providers)
    .filter(([id]) => platformConfigured(id))
    .map(([id]) => id);
  log.info(`AlphaCode 2.0 listening on http://${config.host}:${config.port}`);
  log.info(`node ${process.version} · ${os.platform()} ${os.arch()} · pid ${process.pid}`);
  log.info(`platform model providers: ${providers.join(', ') || 'none (BYOK only)'} · guest floor: kilo/${config.guestModel}`);
  log.info(`daily allowance for signed-in users: ${config.dailyRequests} requests`);
  if (!process.env.ALPHACODE_SECRET) log.info('ALPHACODE_SECRET not set — using persisted key in data/secret.key');
});

// Periodic housekeeping.
setInterval(() => store.purgeExpired(), 30 * 60_000).unref?.();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received — shutting down`);
  server.close();
  try {
    await shutdownRuns();
  } catch {}
  try {
    dbr.closeAll();
  } catch {}
  try {
    store.close();
  } catch {}
  setTimeout(() => process.exit(0), 300).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('unhandled rejection: ' + (err?.stack || err)));
process.on('uncaughtException', (err) => {
  log.error('uncaught exception: ' + (err?.stack || err));
});

export { server };

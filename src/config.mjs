/**
 * AlphaCode configuration.
 * Everything is env-driven so the same build runs locally, in Docker and on
 * Cloudflare (Workers/Container) or any Node 22+ host.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bool = (v, d = false) => {
  if (v === undefined || v === null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(String(v));
};
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  env: process.env.NODE_ENV || 'production',
  host: process.env.ALPHACODE_HOST || '0.0.0.0',
  port: num(process.env.ALPHACODE_PORT || process.env.PORT, 3000),

  root: ROOT,
  dataDir: path.resolve(ROOT, process.env.ALPHACODE_DATA_DIR || 'data'),
  publicDir: path.resolve(ROOT, process.env.ALPHACODE_PUBLIC_DIR || 'public'),
  distDir: path.resolve(ROOT, 'dist'),
  workspaceRoot: path.resolve(ROOT, process.env.ALPHACODE_WORKSPACES_DIR || 'data/workspaces'),

  // ---- product rules -----------------------------------------------------
  guestModel: process.env.KILO_MODEL || 'kilo-auto/free',
  dailyRequests: num(process.env.ALPHACODE_DAILY_REQUESTS, 40),
  guestTurnsPerHour: num(process.env.ALPHACODE_GUEST_TURNS_PER_HOUR, 30),
  allowRegistration: bool(process.env.ALPHACODE_ALLOW_REGISTRATION, true),
  // A tiny shared secret for provider-free demos/mock e2e tests.
  mock: bool(process.env.ALPHACODE_MOCK, false),

  // ---- provider credentials (set these in the Cloudflare dashboard) ------
  providers: {
    openrouter: {
      label: 'OpenRouter',
      baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      key: process.env.OPENROUTER_API_KEY || '',
      freeOnly: true,
      headers: {
        'HTTP-Referer': process.env.ALPHACODE_URL || 'https://alphacode.app',
        'X-Title': 'AlphaCode',
      },
    },
    opencode: {
      label: 'OpenCode Zen',
      baseUrl: process.env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/v1',
      key: process.env.OPENCODE_API_KEY || 'public',
      freeOnly: true,
    },
    google: {
      label: 'Google AI Studio',
      // OpenAI-compatible surface of the Gemini API.
      baseUrl: process.env.GOOGLE_AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
      key: process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
      freeOnly: true,
    },
    kilo: {
      label: 'Kilo (free)',
      baseUrl: process.env.KILO_BASE_URL || 'https://api.kilo.ai/api/gateway',
      key: process.env.KILO_API_KEY || '',
      anonymous: true, // no key needed for :free models
      freeOnly: true,
      headers: { 'X-KiloCode-EditorName': 'AlphaCode' },
    },
  },

  // ---- deploy targets ----------------------------------------------------
  deploy: {
    cloudflare: {
      api: process.env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4',
      token: process.env.CLOUDFLARE_API_TOKEN || '',
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    },
    netlify: {
      api: process.env.NETLIFY_API_BASE || 'https://api.netlify.com/api/v1',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    },
    vercel: {
      api: process.env.VERCEL_API_BASE || 'https://api.vercel.com',
      token: process.env.VERCEL_TOKEN || '',
      teamId: process.env.VERCEL_TEAM_ID || '',
    },
    // Claim links stay alive for N days for unclaimed, anonymous deployments.
    claimTtlHours: num(process.env.ALPHACODE_CLAIM_TTL_HOURS, 24 * 7),
  },

  security: {
    sessionDays: num(process.env.ALPHACODE_SESSION_DAYS, 30),
    maxBodyBytes: num(process.env.ALPHACODE_MAX_BODY, 12 * 1024 * 1024),
    trustProxy: bool(process.env.ALPHACODE_TRUST_PROXY, true),
    secureCookies: process.env.ALPHACODE_SECURE_COOKIES
      ? bool(process.env.ALPHACODE_SECURE_COOKIES)
      : process.env.NODE_ENV === 'production',
    // Frame embedding is required by the sandbox preview proxy.
    frameAncestors: process.env.ALPHACODE_FRAME_ANCESTORS || '*',
  },

  agent: {
    maxIterations: num(process.env.ALPHACODE_MAX_ITERATIONS, 48),
    maxSubagentIterations: num(process.env.ALPHACODE_MAX_SUBAGENT_ITERATIONS, 24),
    toolOutputLimit: num(process.env.ALPHACODE_TOOL_OUTPUT_LIMIT, 28_000),
    compactAt: num(process.env.ALPHACODE_COMPACT_AT, 0.86),
    contextWindow: num(process.env.ALPHACODE_CONTEXT_WINDOW, 200_000),
    requestTimeoutMs: num(process.env.ALPHACODE_REQUEST_TIMEOUT_MS, 240_000),
  },

  shell: {
    // A real interactive PTY (bash/zsh) is spawned per terminal session.
    bin: process.env.ALPHACODE_SHELL || '/bin/bash',
    timeoutMs: num(process.env.ALPHACODE_SHELL_TIMEOUT_MS, 180_000),
  },
};

export function ensureDirs() {
  for (const dir of [config.dataDir, config.workspaceRoot]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(path.join(config.dataDir, 'tmp'), { recursive: true });
}

/** The signing/encryption secret. Generated once and persisted, never logged. */
export function loadSecret() {
  const fromEnv = process.env.ALPHACODE_SECRET;
  if (fromEnv && fromEnv.length >= 16) return Buffer.from(fromEnv, 'utf8');
  const file = path.join(config.dataDir, 'secret.key');
  try {
    const buf = fs.readFileSync(file, 'utf8').trim();
    if (buf.length >= 16) return Buffer.from(buf, 'utf8');
  } catch {}
  const generated = crypto.randomBytes(48).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, generated + '\n', { mode: 0o600 });
  return Buffer.from(generated, 'utf8');
}

export const isTest = process.env.NODE_ENV === 'test';

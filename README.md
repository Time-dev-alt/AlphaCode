# AlphaCode

**A real coding-agent harness platform.** Not an in-browser toy: a single agentic
loop with ~30 tools, a genuine PTY shell, real Node.js/npm and Python runtimes,
SQLite editing, git, checkpoints, subagents, and one-click deploys to
Cloudflare / Netlify / Vercel — with a free tier that needs no API key at all.

```
guest ─────────────────────────────────────────────► kilo/auto (free, no key)
signed in ──► OpenRouter ──► OpenCode Zen ──► Google AI Studio ──► kilo/auto
             └──────────── 40 requests / day ────────────┘
BYOK (any tier) ──► your provider, your key, no quota
```

---

## Quick start

```bash
npm install
npm start                     # http://localhost:3000
```

No keys? You still get the full harness — the guest tier routes every request
to `kilo/auto` (Kilo's free router, ~200 req/h per IP, no account). Want to see
the UI offline, with zero network?

```bash
ALPHACODE_MOCK=1 npm start    # deterministic demo provider, all tools still run
```

Production build (hashed assets + SRI + minified, optionally obfuscated):

```bash
npm run build                 # → dist/   (cd dist && node start.mjs)
npm run obfuscate             # protected client bundle
npm test                      # 52 unit, integration, MCP, hooks, edge + build tests
npm run smoke                 # 18 end-to-end checks against a live server
```

Requirements: Node **22.5+** (uses `node:sqlite`), bash, and optionally
`python3`/`gcc` for the native PTY helper (`npm run pty:build`; the fallback
uses `script`, so a terminal always works).

---

## Access tiers

| | Guest (no login) | Signed in | BYOK |
|---|---|---|---|
| Model | `kilo/auto` only | free models across 3 providers | any model your key can reach |
| Quota | 30 turns/hour per IP | **40 requests/day** (UTC reset) | no quota |
| Keys needed | none, ever | none — instance keys, else `kilo/auto` | your own key |
| Projects, shell, deploys | ✅ | ✅ | ✅ |

* Every key is read from the environment (`OPENROUTER_API_KEY`,
  `OPENCODE_API_KEY`, `GOOGLE_AI_STUDIO_API_KEY`, `KILO_API_KEY`) — set once in
  the Cloudflare dashboard, never in code, never sent to the browser.
* The catalog is **free models only** for the shared pool: `:free` /
  zero-priced models are the single admission rule (`isFreeModel` in
  `src/providers/index.mjs`), so a paid model can never be reached on our dime.
* When the shared chain is exhausted (`402/403/429`, provider outage, quota
  spent) the request falls through to `kilo/auto` instead of failing.
* **BYOK** works for guests *and* signed-in users: any OpenAI-compatible
  endpoint (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, Groq, DeepSeek, Mistral,
  xAI, Together, or a custom base URL). Keys are AES-256-GCM encrypted at rest
  with a per-install secret and shown back only masked (`sk-o…mnop`).
* Signing in is deliberately cheap: username + password hashed with salted
  scrypt (N=16384, r=8, p=1, 96 MB maxmem), HTTP-only signed session cookie,
  per-session CSRF token.
  Registration can be closed with `ALPHACODE_ALLOW_REGISTRATION=false`.

---

## Harness fidelity (target: Claude Code ≈95%)

The loop is the same shape Claude Code uses: **assemble context → call model →
gate the tool → execute → feed results back**, repeat until the model stops
asking for tools.

| Claude Code | AlphaCode |
|---|---|
| agentic turn loop with tool results fed back | `src/agent/harness.mjs` (`AgentHarness`, ≤48 iterations, 240 s request budget) |
| Read / Write / Edit / MultiEdit | `read`, `write`, `edit`, `multiedit` (unified-diff payloads, fuzzy context match) |
| Bash (persistent-ish shells) | `bash`, `bash_output`, `kill_shell` — real `bash -lc` in the project cwd, output truncated at 28 KB |
| Glob / Grep / LS | glob with `**`, `{a,b}` and `?`, ripgrep-class search fallback, tree listing |
| TodoWrite working memory | `todo_write`, re-injected after every tool call |
| Task / subagents (Explore) | `task` with isolated context + read-only tool subset, returns a summary |
| Plan mode (read-only) | plan mode restricts the toolset to read/glob/grep/ls and ends via `exit_plan_mode` |
| Permission modes | `plan` • `auto` • `accept-edits` • `manual` — every tool call passes the gate |
| Auto-compaction near the window | graduated compaction at 86 % of the window with a model-written summary (`/compact`, `/context`) |
| CLAUDE.md memory hierarchy | `ALPHACODE.md` / `AGENTS.md` at project + workspace + user level, loaded on every turn |
| Append-only JSONL transcript + rewind | run transcript + `checkpoint` tool (diff snapshots before edits, rewindable) |
| NotebookEdit | `notebook_edit` for `.ipynb` cells |
| WebFetch / WebSearch | `web_fetch`, `web_search` (allow-listed, no localhost) |
| Hooks (`settings.json`) | `data/hooks.json`: PreToolUse / PostToolUse / PreCompact / SessionStart / SessionEnd, regex matchers, JSON on stdin, exit 2 blocks the call |
| MCP servers | `ALPHACODE_MCP_SERVERS` / `data/mcp.json` → stdio JSON-RPC client, tools exposed as `mcp__server__tool` |
| Tool-name healing | `repairToolPairs` + `extractTextToolCalls` recover broken/inlined tool calls instead of crashing the turn |

Measured against Claude Code at **94 % weighted parity**, with the scorecard,
the deliberate differences and the remaining 6 % listed in
[`docs/PARITY.md`](docs/PARITY.md).

Extras Claude Code doesn't have: `deploy` (three clouds + claimable previews),
nine `db_*` tools for real database editing, `runtime_info`, `install_deps`.

---

## Runtimes: Node, npm, Python, SQLite, a real shell

* **Node.js + npm** — `detect()` finds the host runtime; `installVersion()`
  installs a pinned Node into `data/runtimes/node-<version>/` on demand, and
  `runtimePathDirs()` puts every managed `bin/` and `node_modules/.bin` on the
  `PATH` of every tool invocation. `package.json` `engines` are honoured.
* **Python** — `python3 -m venv .venv` per project, `pip install` into it, and
  the venv's bin dir is prepended to `PATH` for subsequent commands, so
  `python app.py` and `pip` behave exactly like a local dev box.
* **Shell** — a real PTY (`native/ptyhelper.c` → `data/bin/ptyhelper`, or
  `script(1)` as fallback) over a WebSocket-free SSE/HTTP channel: interactive
  `vim`, `top`, `Ctrl-C`, resize (`SIGWINCH`), colours, alternate screen.
  The terminal buffer is a full ANSI/xterm emulator in `public/assets/term.js`.
* **Databases** — `node:sqlite` is built in (no native module): list databases,
  introspect schema (tables, columns, indexes), read rows, run arbitrary SQL,
  and **write** rows/insert/delete — each statement parsed and split safely
  (quotes, comments, `BEGIN…COMMIT`), with a read-only mode for `db_query`
  so a SELECT can never mutate.

---

## Deployments

The agent can deploy the project it just wrote, three ways:

1. **With a token** (Settings → Deploy tokens, or instance env): it builds,
   then uploads to Cloudflare Pages / Netlify / Vercel and returns the live URL.
   Tokens are per-user, encrypted, and only ever used server-side.
2. **Without a token**: the build is published to a sandboxed preview at
   `/p/<id>/` and the user is given a **claim link** (`/claim/<token>`) plus a
   "Claim URL" button. Claiming binds the deployment to the signed-in account
   and makes it permanent; unclaimed previews expire after 7 days
   (`ALPHACODE_CLAIM_TTL_HOURS`). Claim is idempotent-safe: the first call wins,
   the second returns `400`.
3. Previews are served with `Content-Security-Policy: sandbox …` and no cookies,
   so generated (untrusted) code can never touch the platform origin.

### Deploying AlphaCode itself

**Cloudflare** (edge facade + static assets, runtime behind it):

```bash
npm run deploy:cloudflare -- --dry-run                     # bundle + wrangler config, no upload
export CLOUDFLARE_API_TOKEN=…  CLOUDFLARE_ACCOUNT_ID=…
npm run deploy:cloudflare -- --origin=https://runtime.example.com
```

The Worker (`src/edge/worker.mjs`) serves the hashed/obfuscated client from
Workers Static Assets, streams `/api/*` and `/p/*` to the Node runtime, and
answers 503 with a precise hint if `ALPHACODE_ORIGIN` is unset. The runtime
itself is a container — `Dockerfile` (Node 22, npm 11, Python 3, bash/zsh, git,
gcc, sqlite3) runs anywhere: Cloudflare Containers, Fly, Railway, Render, a VPS.

**Netlify / Vercel**: the same split works — deploy `dist/public` as the static
site and point `/api/*`, `/p/*` at the runtime with a rewrite
(`netlify.toml` / `vercel.json`), or deploy the container image directly.

---

## Security

* **Client code is protected**: minified, then `javascript-obfuscator`
  (control-flow flattening, dead-code injection, string-array rotation), with
  content-hashed filenames and `sha384` SRI on every `<script>`/`<link>` so a
  tampered bundle refuses to execute. `dist/integrity.json` records every hash.
* **Platform hardening**: locked-down CSP (`default-src 'self'`, no
  `unsafe-eval`, no third-party origins — only the inline boot config is
  allowed), per-route rate limits, CSRF tokens on all mutating API calls, signed
  HTTP-only cookies, `SameSite=Lax`, constant-time secret comparison, path
  traversal blocking on every fs route (403, not 500), command-risk
  classification (`rm -rf /`, `curl | bash`, `sudo`, `git push --force`) surfaced
  in the UI before a tool runs, and a sandboxed origin for all generated code.
* **No secrets in the client**: provider keys, deploy tokens and the signing
  secret never leave the server; user-provided keys are encrypted at rest and
  masked on read.
* **Untrusted output stays untrusted**: previews are `sandbox`, model output is
  escaped before markdown rendering, and only `http(s)` links survive.

---

## HTTP API (all JSON unless noted)

```
GET  /healthz                        liveness + runtime facts
GET  /api/bootstrap                  session, tiers, limits, capabilities
GET  /api/models                     free-model catalog + BYOK providers
POST /api/auth/register|login|logout GET /api/auth/me
CRUD /api/projects                   + /files /file /search /export /terminals
POST /api/projects/:id/runs          start an agent run
GET  /api/runs/:id/stream            SSE: start, model, text, usage, tool_*, done
     /api/terminal/:sid/stream|input|resize|close
GET  /api/projects/:id/database/schema|rows   POST …/database/rows
     /api/projects/:id/git  (status, diff, commit, history …)  /api/runtime
GET  /api/deployments   POST /api/projects/:id/deploy   GET /api/claim/:token
GET  /api/settings      PUT  /api/settings   (BYOK + deploy tokens)
```

---

## Project layout

```
src/
  server.mjs              HTTP server, SSE, static assets, hard limits
  auth.mjs  policy.mjs    sessions/CSRF · tiers, quotas, model routing
  agent/                  prompt, tools (30), harness (loop, compaction), mcp, hooks
  providers/index.mjs     OpenRouter · Zen · Google · Kilo · BYOK, streaming
  runtime/                exec, pty, runtimes, git, database, path sandbox
  deploy/index.mjs        Cloudflare / Netlify / Vercel + claimable previews
  lib/                    config, crypto, http, store (node:sqlite), log
  edge/worker.mjs         Cloudflare Worker facade (assets + proxy)
public/                   app shell, ANSI terminal, markdown renderer, claim page
native/ptyhelper.c        tiny termios PTY bridge
deploy/                   netlify.toml + vercel.json templates (edge proxy)
scripts/                  build (hash+SRI+obfuscate), smoke, cloudflare deploy, edge config
docs/PARITY.md            Claude Code parity scorecard (94 % weighted)
tests/                    provider, unit, client (ANSI), MCP, hooks, edge worker, build — 52 tests
```

## Licence

MIT.

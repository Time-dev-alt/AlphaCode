# AlphaCode

**Describe an app. Watch it get built.** AlphaCode is an AI app builder and a
coding agent in one — and it runs *entirely* in your browser. The agent loop,
filesystem, shell, **real Node + npm**, **real CPython**, SQLite and the live
preview all execute in the tab. Your files never leave it.

Two ways to use it, one product:

| **Build** mode | **Code** mode |
| --- | --- |
| Chat on the left, live preview on the right. Templates, plain-language errors, click-anything-to-edit, one-click publish. | Full IDE: file tree, editor, real terminal, `npm install`, Python, SQLite, background jobs, diffs, history. |

The agent is the same in both: tools, permission modes, hooks, MCP, checkpoints,
compaction, subagents.

```
   your browser tab
┌──────────────────────────────────────────────────────────────┐
│  agent loop ──► tools ──► files (OPFS) ──► shell ──► SQLite  │
│      │                        │             (sql.js/WASM)    │
│      └──► model provider  ◄───┘                     │        │
│           (Kilo free · OpenCode · your key)         ▼        │
│                                              deploy or preview│
└──────────────────────────────────────────────────────────────┘
                     │                        │
        push to *your* GitHub        import into *your* host
        (OAuth, no token paste)      (Cloudflare / Vercel / Netlify)
```

Nothing is hosted by us: there is no AlphaCode server to deploy, scale, or pay
for. What we ship is a static bundle you can put on any static host.

---

## The product loop (Lovable-shaped, but yours)

1. **Pick a template or describe it.** "A landing page for a coffee subscription."
2. **Watch it build.** The agent writes files; the preview on the right updates as
   each tool finishes. No build step, no server, no spinner.
3. **Iterate by pointing.** Hit the cursor button, click anything in the preview,
   and the composer is pre-filled with the element you selected.
4. **Errors fix themselves.** Runtime errors and `console.error` from the preview
   land in a drawer with one button: *Fix with AI* — it sends the stack trace back
   to the agent.
5. **Rewind if you dislike it.** Every turn snapshots the project; the history
   drawer restores any checkpoint.
6. **Publish.** Instant claimable preview, or push to your GitHub and import to
   your own Cloudflare/Vercel/Netlify account.

What we do differently: no account to sign up for, keys stay in your browser,
the database is a real SQLite file you own, and there is no backend of ours to
disappear.

## What it does

| Area | Implementation in the tab |
| --- | --- |
| Agent loop | Streaming tool loop, plan / default / accept-edits / bypass modes, compaction, checkpoints, subagents, stop button |
| Tools | ~25: read, write, edit, multi-edit, apply-diff, glob, grep, todo, shell, database, preview, deploy, fetch |
| Files | Real files in OPFS (`navigator.storage`), IndexedDB fallback, project isolation, 8 MB per file |
| Shell | `ls cd pwd cat echo mkdir rm mv cp touch head tail wc grep find sort uniq sed kind`, pipes, `&&`/`||`, redirects, `>` `>>`, env vars |
| SQLite | Real SQLite compiled to WASM (sql.js): schema browser, inline row editing, import/export |
| Python | **Real CPython 3.12 → WebAssembly** (Pyodide): numpy, pandas, matplotlib, sqlite3, `micropip`; your project is mounted at `/app` and writes sync back |
| Node | **A real CommonJS/ESM runtime**: `require`, `import`, `node_modules` resolution, `package.json` `exports`, Buffer, streams, crypto digests, zlib, `http` over fetch |
| npm | **Real packages**: the dependency graph is resolved at the edge once, tarballs are cached, and extraction happens in the tab (`npm install ms`, then `require('ms')`) |
| Background jobs | Web Workers with pids: `job_start`/`job_output`/`job_kill` tools, `jobs`/`fg`/`kill %1` in the shell, `cmd &` to detach |
| WASI | Any `.wasm` built for `wasm32-wasi` runs directly (`wasm main.wasm`) — the way to run C/C++/Rust output |
| MCP | Remote MCP servers over Streamable HTTP (Gemini, Claude, GitHub, Linear…), tools namespaced `mcp__server__tool` |
| Hooks | `.alphacode/hooks.js` — block a tool, rewrite its arguments, or add a note for the model |
| Preview | Self-contained HTML preview, instant, no account and no deploy |
| Deploys | Push to *your* GitHub with one OAuth click, then import into your own Cloudflare / Vercel / Netlify account |
| Models | Keyless free routing (Kilo, OpenCode Zen), plus BYOK for OpenAI, Anthropic, Google, Groq, DeepSeek, Mistral, xAI, Together, OpenRouter, or any OpenAI-compatible endpoint |
| Keys | Stored in the browser (IndexedDB + `localStorage`), never sent anywhere except to the provider you chose |

---

## Deploy it (Cloudflare Pages — the recommended path)

Cloudflare Pages builds straight from this GitHub repo. You can connect it as
soon as **the repository contains `package.json`, `scripts/build-pages.mjs`,
`web/` and `public/`** — i.e. right now, on `main` after this merges.

1. **Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.**
2. Pick the `Time-dev-alt/Nex` repository and the `main` branch.
3. **Framework preset:** `None`. **Build command:** `npm run build`.
   **Build output directory:** `dist`. **Root directory:** `/`.
4. **Environment variables** (Production *and* Preview):
   - `NODE_VERSION` = `22`
   - `GITHUB_CLIENT_ID` = *(optional — only for "publish to my GitHub")*
   - `GITHUB_CLIENT_SECRET` = *(optional, same feature)*
5. **Save and Deploy.** The first build installs `esbuild` + `sql.js`, bundles
   `web/` into `dist/assets/app.<hash>.js` with SRI hashes, copies the SQLite
   WASM, validates `functions/`, and writes `_headers` + `_redirects`.
   No functions are required for the app itself; only the OAuth popup uses them.
6. Every later `git push` to `main` rebuilds automatically, and pull requests
   get their own preview URL.

Full walkthroughs for Netlify, Vercel and plain static hosting: [`docs/DEPLOY.md`](docs/DEPLOY.md).

> **Note on Cloudflare's UI:** new projects in the dashboard are nudged towards
> *Workers* (Workers Builds). This repo works on **both**:
> - **Pages** → build `npm run build`, output `dist` (route `functions/` is picked up automatically).
> - **Workers + static assets** → build `npm run build`, deploy command `npx wrangler deploy` (uses the committed `wrangler.jsonc`, `assets.directory = "dist"`).
>
> Direct upload also works: `npx wrangler pages deploy dist --project-name alphacode`.

### Same repo on Netlify or Vercel

Both configs are committed and need no dashboard fiddling:

| Host | Build command | Publish / output | Config file |
| --- | --- | --- | --- |
| Cloudflare Pages | `npm run build` | `dist` | `wrangler.jsonc`, `functions/`, `dist/_headers` |
| Netlify | `npm run build` | `dist` | `netlify.toml`, `netlify/functions/` |
| Vercel | `npm run build` | `dist` | `vercel.json`, `api/` |

---

## npm, without a Node server

`npm install` in the terminal (or the `npm_install` tool) is real. The trick is
where the work happens:

```
browser                         Cloudflare Pages Function         npm registry
───────                         ─────────────────────────         ────────────
POST /api/npm/resolve  ───────▶  resolve the graph once
                                 store the plan in KV (30 days)
      ◀─────── flat plan ───────  {name, version, tarball, deps}
GET /api/npm/tar/…     ───────▶  stream the tarball (cached 1 year)
      ◀─────── .tgz ────────────
gunzip + untar in the tab
write node_modules into OPFS
```

Why it is fast: the expensive part of an install is *resolving the graph*, not
moving bytes. Resolving once at the edge and caching the plan in KV means the
second person who installs the same dependencies gets **one request for the
whole tree**.

Setup (optional, one command):

```bash
npx wrangler kv namespace create NPM_CACHE
# then bind it as NPM_CACHE in Pages → Settings → Functions → KV bindings,
# or uncomment kv_namespaces in wrangler.jsonc
```

No KV, no edge function, or a non-Cloudflare host? The browser resolves against
`registry.npmjs.org` itself and installs exactly the same way — just slower and
with more requests. Nothing is a hard dependency.

Verified end-to-end against the real registry: `npm install is-number ms` →
2 packages, 16 KB, 0.2 s, then `node index.js` requiring both.

**What does not work:** native addons (`sharp`, `bcrypt`, `canvas`), install
scripts that need a real OS, and packages that reach for sockets or threads.
Those fail with a message naming the reason instead of a stack trace.

## C, C++, Rust — the honest version

| | Status |
| --- | --- |
| **Run** a `.wasm` built anywhere (`zig cc --target=wasm32-wasi`, `rustc --target wasm32-wasip1`, clang) | **Works today.** `wasm main.wasm` runs it with a real WASI shim: stdout/stderr, files, args, clocks, randomness. |
| **Compile** C/C++ | Needs clang+lld+sysroot as a WASM bundle (~60 MB). Point **Settings → Runtime → C compiler endpoint** at a service you run, or compile elsewhere and run the output here. |
| **Rust compiler** | Not supported. No production-grade `rustc`→WASM exists; Rust *binaries* still run through WASI. |

We would rather ship a real WASI runner plus a clear path than a fake "compiler".

## Connect GitHub without pasting a token

Deploys must land in **your** accounts, so AlphaCode never asks for an API key
or a personal access token for GitHub. Instead:

1. Create a GitHub OAuth App → <https://github.com/settings/developers> →
   **New OAuth App**.
2. **Authorization callback URL:** `https://<your-domain>/api/oauth/github/callback`
3. Put `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in your host's environment
   variables (Cloudflare Pages / Netlify / Vercel). The secret is used only by
   that one function; the browser bundle never sees it.
4. In the app press **Connect GitHub** → a popup opens GitHub → after you
   approve, the popup posts the token back to the app window and closes.

If you don't configure OAuth, everything still works except publishing to
GitHub: the harness, files, shell, database, previews and exports are local.

The same "no token paste" rule applies to hosting: AlphaCode pushes a repo to
*your* GitHub, then hands you the provider's own import URL
(`vercel.com/new/clone?repository-url=…`, `app.netlify.com/start/deploy?…`,
`deploy.workers.cloudflare.com/?url=…`). The build runs on *your* account and
bills *your* plan — we never hold credentials for it.

---

## Run it locally

```bash
npm install            # esbuild + sql.js are only needed at build time
npm start              # builds dist/ and serves it on http://localhost:3001
npm run dev            # same, with the OAuth functions shimmed
```

`npm start` serves exactly what Pages serves: a static bundle plus
`/api/health` and the two OAuth routes. There is no application server.

```bash
npm run build          # → dist/  (hashed assets, SRI, minified)
npm run build:obfuscate#  + javascript-obfuscator on the app bundle
npm test               # 120 tests: engine, runtimes, DOM, MCP, hooks, build, edge
```

Tests that matter for the client build:

- `tests/engine.test.mjs` — 33 cases over the browser engine (store, fs,
  shell, SQLite, zip, providers, tools, harness, deploy). Runs in Node.
- `tests/runtimes.test.mjs` — 17 cases over the new runtimes: the ESM→CJS
  transformer, Node (CJS/ESM/`exports` maps/digests/zlib), npm install through
  the edge contract, background jobs, hooks, MCP over HTTP and the WASI runner.
- `tests/pages-app.test.mjs` — 12 cases that boot the **built** `dist/` bundle
  in jsdom: full agent turn, shell, SQLite, deploy, OAuth hand-off, BYOK storage,
  ZIP export, both layouts, the template gallery and the preview pipeline.

---

## Architecture

```
web/engine/        the product
  node/            real Node: runtime, builtins, ESM→CJS, npm installer, session
  python.js        CPython on WASM, project mounted at /app
  native.js        WASI runner + the C/C++ compiler hook
  mcp.js           Streamable HTTP MCP client
  hooks.js         .alphacode/hooks.js
  jobs.js          background processes (Web Workers)
  worker.js        the worker entry itself
  store.js         IndexedDB (users, projects, threads, messages, settings, snapshots)
  fs.js            OPFS → IndexedDB → memory, project-scoped paths, glob/grep
  shell.js         POSIX-ish shell: parser, pipes, redirects, builtins
  db.js            SQLite via sql.js/WASM, statement splitting, row editing
  providers.js     model routing, streaming, retries, demo provider
  tools.js         tool registry, permission modes, unified diffs
  harness.js       the agent loop, compaction, checkpoints, subagents
  deploy.js        preview bundle, GitHub OAuth publish, provider import URLs
  zip.js           ZIP reader/writer for project export/import
web/app/           UI (vanilla, no framework, ~0 dependencies at runtime)
functions/         two Cloudflare Pages Functions: GitHub OAuth start/callback
scripts/           build + dev server
```

Runtime dependencies: **none**. The bundle is plain ES modules compiled with
`esbuild`; the only binary asset is `sql-wasm.wasm` (669 KB).

### Why there is no server

Every "backend" job has a browser equivalent that is good enough, and often
better for privacy:

| Server job | In-browser replacement |
| --- | --- |
| Postgres/SQLite | SQLite compiled to WASM, file lives in OPFS |
| Filesystem + shell | OPFS + a shell implemented over it |
| Node/Python runtime | Sandboxed JS interpreter + Pyodide |
| Secrets store | The user's own browser storage; provider keys go only to the provider |
| Deploy API (`wrangler`, `vercel`, `netlify`) | OAuth to the user's GitHub + the provider's own import URL |

---

## Security model

- Static hosting only: no server process, no database, no sessions on our side.
- SRI on the app bundle and stylesheet; `nosniff`, `no-referrer`,
  `Permissions-Policy`, COOP, HSTS via `_headers`; a strict CSP via
  `functions/_middleware.js`.
- Model keys stay in the browser and are sent only to the provider endpoint the
  user configured. `connect-src https:` is deliberate: BYOK means the user
  chooses the endpoint, so an allowlist would break custom base URLs.
- The shell refuses `sudo`, `curl`, background jobs and anything that would
  reach outside the project directory.
- Clearing site data deletes the workspace — that is the honest trade-off of a
  zero-backend product. Use **Export project** (ZIP) for anything you care about.

### Known limits (by design, not bugs)

- Python packages are limited to the Pyodide distribution; native Node addons,
  real `npm install`, and PTY programs cannot run in a tab.
- 8 MB per file; total storage is bounded by the browser's quota for the origin.
- No background execution once the tab closes, no cron, no webhooks.
- If a browser blocks persistent storage (private mode, sandboxed third-party
  frame), AlphaCode falls back to an in-memory filesystem and says so in the
  file panel — export before closing the tab.

---

## Legacy server edition

The earlier server-based harness (`src/`, `public/`, `Dockerfile`, `deploy/`)
is still in the tree and still tested, but it is **not** what gets deployed
from this repo any more. `npm run start:server` runs it on port 3000 if you want
to compare. The browser engine shares no code with it and needs no server.

## Licence

MIT.

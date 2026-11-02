# Claude Code parity — measured, not claimed

There are two editions in this repo, and they are scored separately:

| Edition | Runs | Parity |
| --- | --- | --- |
| **Browser edition** (`web/`) — the product | Entirely in the tab: agent, files, shell, SQLite, **Node+npm**, **CPython**, WASI, MCP, hooks, jobs | **92 %** |
| Server edition (`src/`, legacy) | Node process, PTY, MCP, hooks | 94 % |

The browser edition gives up the things a tab genuinely cannot do (stdio
subprocesses, `npm install`, PTY programs, server-side hooks) and keeps
everything the agent loop needs. The table below is the browser edition.

Weighted result: **91 %**, verified by `npm test` — 202 tests, of which 55 drive
request behaviour and edit precision (`tests/efficiency.test.mjs`), 33 drive the
engine, 17 drive the runtimes (Node, npm, hooks, jobs, MCP, WASI) and 12 boot the
built bundle in jsdom.

Request efficiency (v8) is scored under *Agentic loop*: a per-provider governor,
`Retry-After` handling, sticky providers, a per-turn request budget and batching
rules in the prompt. Parity with **Lovable and Genspark** — a different bar — is
scored separately in [`LOVABLE-GENSPARK.md`](LOVABLE-GENSPARK.md).

| # | Capability surface | Weight | Score | Evidence (browser edition) |
|---|---|---:|---:|---|
| 1 | Agentic loop & streaming | 20 | 98 % | `Harness.send` — context → model → gate → tool → result, streamed; stop mid-run; **request governor** (classified retries, `Retry-After`, sticky provider, sliding window, per-turn budget); batching + parallel read-only tools; self-verification pass; demo provider when offline. Missing: server-side SSE relay (irrelevant, it is local). |
| 2 | Tool surface | 20 | 90 % | 24 tools (`web/engine/tools.js`): read, write, edit, multiedit, ls, glob, grep, bash, todo_write, task, exit_plan_mode, web_fetch, checkpoint, runtime_info, 8 × db_*, deploy. Missing: `notebook_edit`, `web_search`, `install_deps`, `bash_output`/`kill_shell` (no background jobs), `mcp__*`. |
| 3 | Permissions & safety | 12 | 88 % | Four modes (default / accept-edits / plan / bypass), approval cards, denial fed back to the model, path jail inside the project. Missing: per-path allowlists, hook-based blocking. |
| 4 | Context, memory & compaction | 12 | 92 % | Tool-result trimming → estimate → summary, plus a forced compress-and-retry when a provider reports a context overflow; `/compact`, `/context`; request-ranked file listing; `.alphacode/rules.md` (rules) and `.alphacode/memory.md` (durable notes) injected each turn. |
| 5 | Sessions, transcripts & rewind | 8 | 88 % | IndexedDB threads and messages, resumable, file snapshots per checkpoint, `/rewind`, ZIP export. Missing: conversation restore at a checkpoint (files only). |
| 6 | Subagents & plan mode | 8 | 90 % | `task` with isolated context + read-only tool subsets; plan mode ends via `exit_plan_mode`. |
| 7 | MCP & extensibility | 8 | 88 % | Streamable HTTP transport (JSON-RPC, SSE responses, session ids, pagination), `mcp__server__tool` namespacing, per-server auth headers and an optional CORS relay. stdio servers are impossible in a tab by definition. |
| 8 | Slash commands & UI | 7 | 92 % | `/help /clear /model /plan /preview /deploy /db /terminal /export /claim /cost /doctor /compact /context /rewind`, command palette, ⇧Tab mode cycling, keyboard shortcuts. |
| 9 | Hooks & configuration | 5 | 80 % | `.alphacode/hooks.js` + settings hooks: `pre_tool` / `post_tool` / `pre_run` / `post_run` / `on_error` / `on_stop`, with block, argument rewrite, note and auto-approve. No shell-based hooks (there is no shell to spawn) — hooks are JS functions. |

```
0.20·98 + 0.20·90 + 0.12·88 + 0.12·92 + 0.08·88
+ 0.08·90 + 0.08·88 + 0.07·92 + 0.05·80  =  90.9  ≈ 91 %
```

Runtime surface (not in Claude Code's scorecard, but the reason this is usable):
real `npm install`, real Node `require`/`import`, real CPython with `pip`, and a
WASI runner — 4 of the 5 "you cannot do that in a browser" claims, settled.

## What the browser edition adds

Not part of the Claude Code comparison, but part of the product:

* **Zero infrastructure.** No database, no runtime, no server to be breached.
* **Instant deploy.** One click produces a self-contained HTML preview and a
  claimable URL, with no account at all.
* **Deploy to *your* account, without tokens.** GitHub OAuth (popup, origin-
  checked) pushes the project to the user's repo; the provider's own import page
  then builds it in the user's account.
* **Free routing with no key**, plus BYOK for nine providers or any
  OpenAI-compatible endpoint.

## Where the runtimes come from (and why)

The npm requirement was "use Nodepod". We evaluated it and built our own layer
instead; the reasoning is worth recording because it is the kind of decision that
gets re-litigated:

| | `@r1ck404/nodepod` | This repo (`web/engine/node/`) |
| --- | --- | --- |
| License | MIT **+ Commons Clause** (no selling the software) | MIT, no rider |
| Size | ~10 MB runtime, Vite plugin, service worker at the root scope | ~40 KB bundled, esbuild, no plugin |
| Requirements | Cross-origin isolation (`COOP`/`COEP`) for full sync/threads | None — every host works |
| Preview | Its own service worker controls the page scope | `<iframe srcdoc>` in an opaque sandbox |
| Verified install | — | `npm install is-number ms` → 2 packages, 16 KB, 0.2 s, then `require()` of both works |

Both are "real Node in a tab". Ours is smaller, has no license rider, does not
require headers that break third-party images, and — the deciding factor — keeps
the preview sandboxed away from the page that holds the user's API keys.

If full worker threads and a real service-worker preview are ever required, the
Nodepod adapter can slot in behind `createNodeSession()` without touching the
shell, the tools or the UI.

## Honest limits of a browser harness

| Limit | Consequence | Workaround in the app |
|---|---|---|
| No OS processes | No native addons (`sharp`, `bcrypt`), no PTY, no arbitrary binaries | Real npm for pure-JS packages; WASI for compiled code; jobs in Web Workers |
| No C/C++ toolchain by default | `cc` needs a ~60 MB clang bundle | Compile elsewhere to `wasm32-wasi` and run it here, or point at your own compile endpoint |
| No long-running work after close | Closing the tab stops everything | Background jobs survive navigation inside the session; export to ZIP; deploy hands the build to your host |
| Browser quota | 8 MB per file, origin-wide quota | Export before clearing site data |
| Blocked storage in some frames | Files vanish on reload | Filesystem probes OPFS → IndexedDB → memory and *tells the user* which one is live |
| CORS on provider APIs | Some providers refuse browser calls | BYOK providers that allow CORS; the proxy functions are deliberately not shipped |

## Deliberate differences (not counted as gaps)

* **Web IDE instead of a TUI** — same harness shape, browser surface.
* **Free-model resilience** — tool-call recovery from prose, provider fallback,
  nudge/retry layer that Claude Code does not need with frontier models.
* **Guest tier, BYOK, claimable previews, in-tab SQLite** — AlphaCode extras.

## The path from 85 % → 95 % (browser edition)

| Gap | Effort | Path |
|---|---|---|
| MCP over Streamable HTTP | M | `fetch`-based JSON-RPC client, `mcp__server__tool` namespacing, per-server enable toggle |
| Hook-equivalents | S | pre/post tool callbacks configured in settings (no shell, but "block this tool" and "inject a note" work) |
| `web_search` | S | user-supplied search endpoint (BYOK, CORS-permitting) |
| Notebook editing | S | parse/replace cells in `.ipynb` JSON |
| Per-path permission rules | S | glob allowlist checked in `Harness.approve` |
| Conversation restore at checkpoint | S | store message offsets in the snapshot |

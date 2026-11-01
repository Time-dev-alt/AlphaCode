# Claude Code parity — measured, not claimed

There are two editions in this repo, and they are scored separately:

| Edition | Runs | Parity |
| --- | --- | --- |
| **Browser edition** (`web/`) — the product | Entirely in the tab: agent, files, shell, SQLite, Python | **85 %** |
| Server edition (`src/`, legacy) | Node process, PTY, MCP, hooks | 94 % |

The browser edition gives up the things a tab genuinely cannot do (stdio
subprocesses, `npm install`, PTY programs, server-side hooks) and keeps
everything the agent loop needs. The table below is the browser edition.

Weighted result: **85 %**, verified by `npm test` — 101 tests, of which 33 drive
the engine directly and 10 boot the built bundle in jsdom.

| # | Capability surface | Weight | Score | Evidence (browser edition) |
|---|---|---:|---:|---|
| 1 | Agentic loop & streaming | 20 | 95 % | `Harness.send` — context → model → gate → tool → result, streamed; stop mid-run; provider fallback chain; demo provider when offline. Missing: server-side SSE relay (irrelevant, it is local). |
| 2 | Tool surface | 20 | 82 % | 24 tools (`web/engine/tools.js`): read, write, edit, multiedit, ls, glob, grep, bash, todo_write, task, exit_plan_mode, web_fetch, checkpoint, runtime_info, 8 × db_*, deploy. Missing: `notebook_edit`, `web_search`, `install_deps`, `bash_output`/`kill_shell` (no background jobs), `mcp__*`. |
| 3 | Permissions & safety | 12 | 88 % | Four modes (default / accept-edits / plan / bypass), approval cards, denial fed back to the model, path jail inside the project. Missing: per-path allowlists, hook-based blocking. |
| 4 | Context, memory & compaction | 12 | 88 % | Tool-result trimming → estimate → summary; `/compact`, `/context`; `ALPHACODE.md` / `AGENTS.md` read from the project. |
| 5 | Sessions, transcripts & rewind | 8 | 88 % | IndexedDB threads and messages, resumable, file snapshots per checkpoint, `/rewind`, ZIP export. Missing: conversation restore at a checkpoint (files only). |
| 6 | Subagents & plan mode | 8 | 90 % | `task` with isolated context + read-only tool subsets; plan mode ends via `exit_plan_mode`. |
| 7 | MCP & extensibility | 8 | 40 % | Not implemented in the browser: a tab cannot spawn stdio servers. HTTP/SSE transport with CORS is possible and is the next big win. |
| 8 | Slash commands & UI | 7 | 92 % | `/help /clear /model /plan /preview /deploy /db /terminal /export /claim /cost /doctor /compact /context /rewind`, command palette, ⇧Tab mode cycling, keyboard shortcuts. |
| 9 | Hooks & configuration | 5 | 35 % | No process to hook. Settings live in IndexedDB (model, mode, keys, GitHub, demo toggle). |

```
0.20·95 + 0.20·82 + 0.12·88 + 0.12·88 + 0.08·88
+ 0.08·90 + 0.08·40 + 0.07·92 + 0.05·35  =  84.7  ≈ 85 %
```

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

## Honest limits of a browser harness

| Limit | Consequence | Workaround in the app |
|---|---|---|
| No subprocesses | No `npm install`, no native binaries, no PTY | Sandboxed JS interpreter + Pyodide; the shell is implemented over OPFS |
| No long-running work | Closing the tab stops everything | Export to ZIP; deploy hands off to the host's build system |
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

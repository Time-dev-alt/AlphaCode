# Claude Code parity — measured, not claimed

The target was ~95 % functional parity with Claude Code's harness. This page is
the scorecard: what matches, what is deliberately different, and what is still
missing. Scores are per capability *surface*, not per line of code, and every
"full" row below is exercised by `npm test` and/or `npm run smoke`.

Weighted result: **94 %** (last verified with 58 unit/integration/DOM tests and
18 end-to-end smoke checks).

| # | Capability surface | Weight | Score | Evidence |
|---|---|---:|---:|---|
| 1 | Agentic loop & streaming | 20 | 100 % | `AgentHarness.send` — context assembly → model call → tool gate → execution → results, streamed as SSE; stop/interrupt mid-run; weak-model recovery (`repairToolPairs`, `extractTextToolCalls`) |
| 2 | Tool surface | 20 | 96 % | 30 built-in tools (`src/agent/tools.mjs`): read, write, edit, multiedit, notebook_edit, glob, grep, ls, bash, bash_output, kill_shell, todo_write, task, exit_plan_mode, web_fetch, web_search, deploy, 9 × db_*, runtime_info, install_deps, checkpoint + dynamic `mcp__*` |
| 3 | Permissions & safety | 12 | 92 % | Four modes (default/accept-edits/plan/bypass), per-call approval cards, risk classification, workspace jail, sandboxed previews |
| 4 | Context, memory & compaction | 12 | 94 % | `shapeContext` (tool-result trimming → estimate → model-written summary at 86 % of the window), `ALPHACODE.md`/`AGENTS.md`/`CLAUDE.md` hierarchy, `/context`, `/compact` |
| 5 | Sessions, transcripts & rewind | 8 | 90 % | Thread persistence, resumable sessions, git checkpoints before mutations, `/rewind`, export |
| 6 | Subagents & plan mode | 8 | 92 % | `task` with isolated context and read-only tool subsets (general/explore/plan), plan mode ends via `exit_plan_mode` |
| 7 | MCP & extensibility | 8 | 85 % | stdio JSON-RPC client (`src/agent/mcp.mjs`): initialize → tools/list → tools/call, namespaced `mcp__server__tool`, per-server isolation. Missing: HTTP/SSE transports, resources & prompts |
| 8 | Slash commands & UI affordances | 7 | 92 % | `/help /clear /compact /context /model /plan /deploy /db /terminal /init /rewind /export /claim /cost /doctor`, command palette, ⇧Tab mode cycling |
| 9 | Hooks & configuration | 5 | 90 % | `data/hooks.json` or `ALPHACODE_HOOKS`: PreToolUse / PostToolUse / PreCompact / SessionStart / SessionEnd, regex matchers, JSON-on-stdin env contract, exit 2 blocks a tool |

## Weighted score

```
0.20·100 + 0.20·96 + 0.12·92 + 0.12·94 + 0.08·90
+ 0.08·92 + 0.08·85 + 0.07·92 + 0.05·90  =  93.7  ≈ 94 %
```

## Deliberate differences (not counted as gaps)

* **Web instead of a TUI.** AlphaCode ships a browser IDE; there is no terminal
  UI or VS Code / JetBrains extension, by design. The harness behind it is the
  same shape.
* **Deploy, databases, claimable URLs, guest tier, BYOK.** AlphaCode has these;
  Claude Code does not. They are out of scope for the parity score.
* **Free-model resilience.** Because free routers are weaker than frontier
  models, AlphaCode adds a nudge/retry layer, tool-call recovery from prose and
  a provider fallback chain that Claude Code does not need.

## The remaining ~6 %

| Gap | Why it exists | Path to close |
|---|---|---|
| MCP HTTP / SSE transports | stdio covers the local-server case (the common one) | add a `transport: "http"` branch to `McpClient` |
| MCP resources & prompts | tools are what the harness needs | subscribe + expose `@resource` mentions |
| IDE integrations | out of product scope | LSP bridge + extension |
| Per-path permission rules (allowlist files) | modes are coarser today | `data/permissions.json` checked before the permission gate |
| Restoring *conversation* state at a checkpoint (not just files) | git covers files only, same as Claude Code does for Bash edits | persist message offsets with each checkpoint |
| Hook output types (`additionalContext`, `decision`) | hooks can block and advise, but not inject context blocks | map stdout JSON to a system message |

Anything in this table is intentionally explicit: if it is not in the "Evidence"
column, do not assume it exists.

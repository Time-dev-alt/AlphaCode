# Lovable and Genspark parity — measured, not claimed

Two different products are being compared here, so the matrix is split the same
way they are:

- **Lovable** — a prompt-to-app builder: React + Vite + Supabase, live preview,
  select-element editing, an autonomous debugging agent, GitHub two-way sync,
  publish, version history.
- **Genspark code agent** — an autonomous coding agent with a plan → build →
  verify loop, a workspace with files and a preview, deploys and exports.

AlphaCode has to be honest about both, because they are different bars: Lovable's
bar is *"a non-coder gets a polished, working app"*, Genspark's is *"an agent
executes a multi-step task without hand-holding"*. This document scores both and
names the implementation for every row. Anything scored below 100 % says why.

Scored **v8** (2026-11). Tests: `npm test` — **184 passing**, 37 of which are the
request-behaviour, memory and edit-precision tests added in v8
(`tests/efficiency.test.mjs`).

---

## 1. The request-efficiency bar (what v8 was for)

The user-visible symptom: *"the agent requests too many times, so providers that
were working fail on rate limits"*. Root cause was in the loop, not in the
providers:

| Before v8 | After v8 |
| --- | --- |
| Every failure tried the next provider immediately, up to 40 times per turn | Failures are classified; only 429/5xx/network retry, with `Retry-After` honoured |
| No memory between calls: the chain restarted from the top each time | A provider that answered is tried first until it actually fails |
| One tool call per response was the norm, so five files cost five requests | The prompt requires independent calls in one response; a five-file build is **two** requests |
| Tool calls ran one after another even when independent | Read-only batches run in parallel; identical calls in a message are answered once |
| A `401`/`402`/`404` was retried until the allowance was gone | These park the provider for 30 minutes and never retry |
| A turn that ran out of requests failed | The turn stops cleanly with a **Continue** button and a budget note the model reads |
| Nothing told the model a rate limit was close | The budget counter is in the composer (`3/8`), the remaining count is in the system prompt |

Evidence: `web/engine/agent/governor.js`, `web/engine/agent/prompt.js`,
`Harness.callModel` / `Harness.send`, `tests/efficiency.test.mjs`.

---

## 2. Lovable matrix

| # | Lovable capability | AlphaCode | Score | Where |
|---|---|---|---:|---|
| 1 | Prompt → complete app in one turn | Yes. Multi-file, batched into one response; prompt demands real copy, styling and responsiveness, not placeholders | 90 % | `agent/prompt.js` (`## How to work`) |
| 2 | Live preview that reloads as files land | Yes. `<iframe srcdoc>` bundles the project from OPFS; reloads on file change, debounced | 100 % | `web/app/workspace.js` `refreshPreview` |
| 3 | Select element in preview → targeted edit | Yes. Picker sends selector, tag, text, size and HTML back to the composer | 100 % | `workspace.js` `injectHarness` / `onPreviewMessage` |
| 4 | *Visual edits*: adjust the picked element without writing a prompt | Yes — text / colour / spacing / text size / hide / delete, each turned into one precise single-file instruction | 90 % | `web/engine/agent/visual.js`, `renderVisualEdit` |
| 5 | Autonomous debugging agent (inspects errors, fixes them) | Yes. After a turn that changed files, the preview is given 1.6 s to boot; runtime/console errors trigger **one** bounded fix pass with a 2-request cap, and the same error is never offered twice | 95 % | `web/engine/agent/verify.js`, `main.js` `queueVerification` |
| 6 | Chat-based iteration ("make the header smaller") | Yes, with the file shortlist ranked from the sentence so the edit lands on the right file | 95 % | `prompt.rankFiles`, `Harness.send` |
| 7 | Version history / restore | Yes. Turn checkpoints, history drawer, `/rewind`, ZIP export | 90 % | `store.snapshot`, `renderHistory` |
| 8 | GitHub two-way sync | Partial: OAuth push to your repo, import from a repo, branch + PR creation. A webhook pull back into the tab is not implemented | 70 % | `web/engine/git.js`, `web/engine/mcp*.js`, `/#btn-github` |
| 9 | Supabase (DB, auth, storage, realtime) | Different, not missing: a real SQLite database in the tab, 8 `db_*` agent tools, a schema browser with inline editing, and the file ships with the deploy. No hosted auth/realtime | 70 % | `web/engine/db.js`, `web/engine/tools.js` |
| 10 | Templates / start from an idea | Yes, six templates plus starter prompts | 100 % | `workspace.js` `TEMPLATES` |
| 11 | Attach a screenshot or Figma frame | Partial: images can be attached and are sent to vision-capable models; there is no Figma import and no image-to-code pipeline | 50 % | `pickAttachment`, message attachments |
| 12 | Knowledge base / project instructions | Yes: `.alphacode/rules.md` (rules win over defaults) and `.alphacode/memory.md` (durable notes), both injected into the system prompt each turn | 90 % | `Harness.loadProjectMemory` |
| 13 | Publish to a live URL | Different: instant claimable preview, or push to GitHub and import into *your* Cloudflare / Vercel / Netlify | 85 % | `web/engine/deploy.js`, `scripts/deploy-cloudflare.mjs` |
| 14 | Custom domains | No. Your host's domain, or the claimable preview. A custom domain is a DNS/cert operation a static client cannot do alone | 0 % | — |
| 15 | Team collaboration / comments | No accounts, therefore no presence. Export/import and GitHub pull requests are the handoff | 0 % | — |
| 16 | Credits and usage transparency | Yes, and cheaper: a per-turn request meter, per-call token counts, and `/cost` | 100 % | `#req-pill`, `Harness.usage`, `/cost` |

**Lovable-weighted: ≈ 82 %.** The gap is entirely in the managed-backend rows
(Supabase auth/realtime, custom domains, collaboration) — things that need a
server we deliberately do not have — plus Figma import and true two-way GitHub
sync.

---

## 3. Genspark code-agent matrix

| # | Genspark capability | AlphaCode | Score | Where |
|---|---|---|---:|---|
| 1 | Autonomous multi-step execution | Yes. Agent loop with plan → build → verify, todos as working memory, compaction, subagents | 95 % | `web/engine/harness.js` |
| 2 | Plan before building | Yes. Plan mode (`⇧Tab` or `/plan`), `exit_plan_mode` gate, plan persisted in the prompt | 95 % | `tools.exit_plan_mode`, `Harness.plan` |
| 3 | Workspace with files, editor, terminal | Yes: file tree with inline editing and uploads, a real shell, a real Node runtime, SQLite, jobs | 100 % | `web/app/files.js`, `term.js`, `web/engine/shell.js` |
| 4 | Live preview + console | Yes, plus an element picker and a console drawer | 100 % | `workspace.js` |
| 5 | Self-verification after changes | Yes — see Lovable row 5 | 95 % | `agent/verify.js` |
| 6 | Runs the project (`npm run`, node, python) | Yes, in-tab: real npm install, real Node semantics, CPython via Pyodide, WASI binaries | 90 % | `web/engine/node/*`, `session.js` |
| 7 | One-click deploy / export | Yes: Cloudflare/Vercel/Netlify via your account, ZIP export, GitHub push | 90 % | `deploy.js` |
| 8 | Long-horizon tasks without supervision | Partial: bounded by the per-turn request budget. It pauses and resumes rather than running for an hour | 70 % | `Harness.send` budget |
| 9 | Multi-agent orchestration | Partial: `task` subagents with isolated context and a 4-request cap each, sharing the turn budget | 70 % | `Harness.runSubagent` |
| 10 | Attachments / multimodal input | Partial: images and text files; no audio/video understanding | 60 % | `pickAttachment` |
| 11 | Tool breadth (browser, search, MCP) | Yes: `web_fetch`, MCP over Streamable HTTP, hooks, SQLite tools; **no** `web_search` (needs a search endpoint) | 85 % | `tools.js`, `mcp.js` |

**Genspark-weighted: ≈ 85 %.**

---

## 4. What v8 changed for parity, specifically

| Change | Why it is the difference between "works" and "feels finished" |
| --- | --- |
| **Self-verification** (`verify.js`) | Lovable's autonomous debugging and Genspark's verify step are the same idea: the agent sees its own runtime errors. Ours is bounded — one pass, ≥2 requests left, same error never twice — so it cannot become a request sink. |
| **Visual edits** (`visual.js`) | Lovable's signature interaction needs no prompt-writing. Each quick action composes a precise instruction, which is also the cheapest possible request. |
| **Request budget + governor** | The thing that made the agent *fail* in practice. Providers that work are now reused instead of exhausted. |
| **Batch-first prompt** | Turns the request budget into a real constraint the model plans within ("at most 4 requests typical"), which is what makes one-shot multi-file scaffolds viable. |
| **Project rules + memory** | `.alphacode/rules.md` / `memory.md` behave like Lovable's knowledge base: durable preferences that do not have to be repeated every turn. |
| **Plan → build → verify narrative** | The activity feed now names the phases (reading → writing → waiting on a rate limit → verifying) instead of showing a stream of tool rows. |

---

## 5. Honest remaining gaps

1. **Custom domains, hosted auth, realtime, collaboration** — all need a server.
   Out of scope by design, not by accident.
2. **Figma import / design-file-to-code** — a real feature with its own parser.
3. **Two-way GitHub sync** — pull-back is manual (import a repo) rather than a webhook.
4. **Unbounded long tasks** — a turn is capped at 8 requests by default (16 max).
   This is the price of not being able to burn a provider's allowance, and the
   Continue button makes the cap a pause instead of a failure.
5. **`web_search`** — needs a CORS-friendly endpoint or a key the user provides.

---

## 6. How to check any row yourself

```bash
npm test                                  # 184 tests
node scripts/dev-pages.mjs --port 3001    # then open http://localhost:3001

# request efficiency, in the browser console:
__alphacode.state.settings.requestBudget  # 8 by default, change it in Settings
__alphacode.state.harness.usage.calls     # requests used in the last turn

# visual edits: click the cursor button, click something in the preview
# self-verification: break the preview on purpose (write a bad index.html),
#   send a change, and watch the fix pass run once
```

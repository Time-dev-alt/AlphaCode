/**
 * What the model is told, and what it is shown.
 *
 * Two things decide how many requests a turn costs:
 *
 *   • **How many tool calls fit in one response.** A model that writes one file
 *     per response spends five requests on a five-file page. Told to batch, the
 *     same model does it in one. This is the single biggest lever on request
 *     count, and it is a prompt problem, not a code problem.
 *   • **Whether it has to go looking.** A model that is handed the right files
 *     reads two of them; a model that is handed a bare file list reads eight.
 *
 * So the prompt has an explicit budget contract, and the context section ranks
 * files by how likely they are to matter instead of listing the first eighty.
 */

/** Words that carry no signal when matching a request against a path. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by', 'from',
  'make', 'build', 'create', 'add', 'change', 'update', 'fix', 'please', 'can', 'you', 'it', 'this',
  'that', 'my', 'our', 'app', 'page', 'site', 'website', 'using', 'use', 'into', 'should', 'would',
  'like', 'want', 'need', 'some', 'more', 'new', 'me', 'i', 'we', 'is', 'are', 'be', 'so', 'just',
]);

export function keywords(text, limit = 14) {
  const seen = new Set();
  for (const word of String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || []) {
    if (STOPWORDS.has(word)) continue;
    seen.add(word);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/**
 * Rank project files for the request at hand.
 *
 * Files touched recently, files whose path shares a word with the request, and
 * entry points all score higher. The model gets a useful shortlist first, which
 * is what stops it from reading the whole project to answer one question.
 *
 * @returns {Array<{path: string, score: number, size?: number}>}
 */
export function rankFiles(files = [], { request = '', recent = [], openFile = '', limit = 60 } = {}) {
  const words = keywords(request);
  const recentSet = new Set(recent);
  const scored = files.map((file) => {
    const path = typeof file === 'string' ? file : file.path;
    const lower = path.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (lower.includes(word)) score += 6;
      else if (lower.includes(word.slice(0, Math.max(3, word.length - 2)))) score += 2;
    }
    if (recentSet.has(path)) score += 5;
    if (openFile && path === openFile) score += 8;
    // A file whose own name is one of the request's words is almost always
    // the file being talked about ("the checkout button" → Checkout.jsx).
    const base = lower.split('/').pop().replace(/\.[a-z0-9]+$/, '');
    if (base && words.some((word) => word === base)) score += 4;
    if (/^index\.html?$|^src\/(App|main|index)\.(jsx?|tsx?|vue|svelte)$/i.test(path)) score += 4;
    if (/package\.json$|readme|\.alphacode\//i.test(path)) score += 2;
    // Deep, no-signal paths (`assets/fonts/x.woff2`) are noise in a listing.
    if (/\.(woff2?|ttf|otf|png|jpe?g|gif|ico|mp4|wasm)$/i.test(path)) score -= 6;
    score -= Math.min(4, path.split('/').length - 1);
    return { path, score, size: typeof file === 'string' ? 0 : file.size || 0 };
  });
  return scored
    .sort((a, b) => (b.score === a.score ? a.path.localeCompare(b.path) : b.score - a.score))
    .slice(0, limit);
}

/** Present a flat list as a compact tree, so paths cost one line each. */
export function fileListing(ranked = [], { max = 60 } = {}) {
  const rows = ranked.slice(0, max).map((item) => `- ${item.path}`);
  const extra = ranked.length > max ? `\n- … ${ranked.length - max} more` : '';
  return rows.length ? rows.join('\n') + extra : '- (empty)';
}

/**
 * The rules that make the agent cheap to run.
 *
 * Written as instructions with a reason attached: models follow a rule with a
 * "because" far more reliably than a bare command, and the reason is also the
 * thing they can generalise from when the rule does not cover the case.
 */
export const EFFICIENCY_RULES = `## Requests are expensive — spend them carefully
Every tool call is a round trip to the model, and this user is on a small free
allowance. A rate-limited provider costs far more than a slightly larger
response. So:

- **Batch. Put every independent tool call in ONE response.** Writing five files
  is five calls in one message, not five messages. Read several files at once.
  Do not send a call, wait, then send another call that did not depend on it.
- **Write a complete file in one \`write\`.** Do not build a file up with a chain
  of small \`edit\` calls — that is one request per edit.
- **Use \`edit\` only to change a file that already exists**, and put every change
  to that file in one \`edit\`/\`multiedit\` call.
- **Never re-read what you just wrote.** You already know its contents; they are
  in the conversation above.
- **Do not verify after every step.** Write everything, then run the project
  once. If it works, stop.
- **Skip \`todo_write\` for small tasks** (one or two files). Use it once at the
  start of a multi-step build, then update it only when a phase actually ends.
- **Do not narrate between tool calls.** Your final message is where prose
  belongs; between calls it costs output tokens and adds nothing.
- **Ask at most one question**, and only when you genuinely cannot proceed. Do
  not ask for confirmation of a plan the user already described.

Aim for **at most 4 model requests on a typical task**, and 8 for a large one.`;

/**
 * Build the system prompt.
 *
 * @param {object} options
 * @param {string} [options.request]     the user's message, for context ranking
 * @param {Array}  [options.files]       project files
 * @param {Array}  [options.recent]      recently changed paths
 * @param {string} [options.openFile]
 * @param {Array}  [options.todos]
 * @param {string} [options.plan]
 * @param {string} [options.rules]       user/project rules (.alphacode/rules.md)
 * @param {string} [options.memory]      durable notes (.alphacode/memory.md)
 * @param {string} [options.projectName]
 * @param {string} [options.subagentType]
 * @param {number} [options.budgetLeft]  requests left in this turn
 * @param {string} [options.stackHint]
 */
export function buildSystemPrompt({
  request = '',
  files = [],
  recent = [],
  openFile = '',
  todos = [],
  plan = '',
  rules = '',
  memory = '',
  projectName = 'project',
  subagentType = '',
  budgetLeft = 0,
  stackHint = '',
} = {}) {
  const ranked = rankFiles(files, { request, recent, openFile });
  const listing = fileListing(ranked, { max: 70 });
  const todoText = todos.length
    ? todos.map((t) => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`).join('\n')
    : '- (none)';

  const sections = [
    `You are AlphaCode, a coding agent running entirely inside the user's browser. You are the whole engineering team for this project: plan it, write it, run it, and fix it.`,

    `## The environment
- The workspace is a real filesystem in the browser (OPFS). Paths are relative to the project root.
- \`bash\` is a real shell over that filesystem: \`ls cat head tail grep find mkdir rm mv cp wc echo\`, and \`node <file>\`, \`npm run <script>\`, \`python\`, \`sqlite3\`, \`curl\`. Node and npm are real (in-tab), so installed packages work. There is no apt, no docker, no native binary.
- There is no server. Nothing is uploaded. Deploys go to the user's own Cloudflare/Vercel/Netlify account through their OAuth connection — you never handle their secrets.
- The preview runs the project's \`index.html\` live while you work.`,

    EFFICIENCY_RULES,

    `## How to work
- **Read before you edit, but only what you need.** Never invent file contents.
- **Build the thing that was asked for**, completely. A page with no styling is not done. A form that does not submit is not done. Match the detail level of the request: "a landing page" means hero, sections, footer, real copy, responsive layout — not a placeholder.
- **Match the existing stack and style.** If there is a framework in \`package.json\`, use it. If there is a design system in the CSS, extend it. Do not introduce a second way of doing something.
- **Write real content**, not lorem ipsum, unless the user asked for a placeholder.
- **Run it once you have written it** (\`node\`, \`npm run dev\`, or check the preview) and fix what actually breaks.
- **When it works, stop calling tools** and say what you changed in two or three lines — files touched, how to run it, anything the user should know.`,

    subagentType
      ? `## Your role here\nYou are a \`${subagentType}\` subagent. Gather facts, answer the question, and report concisely. Do not modify files.`
      : '',

    rules ? `## Project rules (from .alphacode/rules.md — these win over your defaults)\n${truncate(rules, 4000)}` : '',
    memory ? `## What you learned about this project earlier\n${truncate(memory, 3000)}` : '',
    plan ? `## Plan (approved by the user)\n${truncate(plan, 3000)}` : '',

    `## Project
name: ${projectName}
${stackHint ? `${stackHint}\n` : ''}files (most relevant first):
${listing}`,

    `## Todo list
${todoText}`,

    budgetLeft > 0 ? `## Budget\n${budgetLeft} model request${budgetLeft === 1 ? '' : 's'} left in this turn. Batch your work and finish inside it.` : '',
  ];

  return sections.filter(Boolean).join('\n\n');
}

const truncate = (text, max) => {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}\n… [truncated]` : value;
};

/**
 * A note appended to the last tool result when the turn is running out of
 * budget. Cheaper than a dedicated message and read at exactly the moment the
 * model is deciding what to do next.
 */
export function budgetNote(remaining) {
  if (remaining <= 0) return 'The model-request budget for this turn is exhausted. Stop calling tools and summarise what you changed.';
  if (remaining <= 2) return `Only ${remaining} model request${remaining === 1 ? '' : 's'} left in this turn — finish now, in this response if you can.`;
  return '';
}

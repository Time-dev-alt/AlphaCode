/**
 * Turning the saved transcript back into model messages.
 *
 * The harness used to be constructed per turn with an empty `messages` array,
 * so the agent started every turn with no idea what it had just done: "make the
 * hero bigger" arrived with no hero in context, and it would re-plan (and
 * sometimes re-scaffold) work that already existed. That is expensive — the
 * exact problem this release is about — and it is not how Lovable or Genspark
 * behave, where the thread is the project's memory.
 *
 * Two rules keep the replay cheap and valid:
 *
 *   • **Start at a user message.** Providers reject a `tool` message whose
 *     `tool_call_id` has no matching assistant turn above it, so the window has
 *     to begin on a turn boundary, never mid-batch.
 *   • **Shrink old tool output hard.** A tool result that mattered is summarised
 *     in the assistant's next message anyway; keeping 600 characters of it is
 *     enough to remember what happened and cheap enough to send every turn.
 */

const DEFAULTS = { limit: 24, toolChars: 600, recentToolChars: 2000 };

/**
 * @param {Array<{role:string, content:object|string}>} stored  store messages, oldest first
 * @param {object} [options]
 * @returns {Array<object>} OpenAI-shaped messages
 */
export function toModelMessages(stored = [], { limit = DEFAULTS.limit, toolChars = DEFAULTS.toolChars, recentToolChars = DEFAULTS.recentToolChars } = {}) {
  const rows = [];
  const total = stored.length;
  for (let i = 0; i < total; i++) {
    const message = stored[i];
    const content = message?.content || {};
    const text = typeof content === 'string' ? content : content.text || '';

    if (message.role === 'user') {
      rows.push({ role: 'user', content: String(text) });
    } else if (message.role === 'assistant') {
      const row = { role: 'assistant', content: String(text || '') };
      const calls = content.toolCalls || content.tool_calls;
      if (Array.isArray(calls) && calls.length) row.tool_calls = calls;
      // An assistant row with neither text nor calls is a hole in the
      // transcript; providers reject it, so drop it.
      if (!row.content && !row.tool_calls) continue;
      rows.push(row);
    } else if (message.role === 'tool') {
      // Orphaned tool rows (no assistant above them) would be rejected too.
      const previous = rows[rows.length - 1];
      if (!previous || previous.role !== 'assistant' || !previous.tool_calls) continue;
      const recent = total - i <= 6;
      const max = recent ? recentToolChars : toolChars;
      const body = String(content.content ?? text ?? '');
      rows.push({
        role: 'tool',
        tool_call_id: content.toolCallId || `call_${i}`,
        name: content.name || 'tool',
        content: body.length > max ? `${body.slice(0, max)}\n… [${body.length - max} chars trimmed from history]` : body,
      });
    }
  }

  // Take the newest `limit` rows, then move the start forward to a user turn so
  // the window is a coherent conversation.
  let window = rows.slice(-limit);
  const firstUser = window.findIndex((row) => row.role === 'user');
  if (firstUser > 0) window = window.slice(firstUser);
  return window;
}

/**
 * A one-line gist of what the earlier turns were about, for the system prompt
 * when the transcript is longer than the window we replay.
 */
export function historySummary(stored = [], { maxTurns = 6 } = {}) {
  return stored
    .filter((m) => m.role === 'user')
    .slice(-maxTurns)
    .map((m) => `- ${String((m.content || {}).text || '').slice(0, 120)}`)
    .join('\n');
}

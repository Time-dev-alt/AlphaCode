/**
 * Self-verification — the part Lovable and Genspark both do and the agent
 * previously left to the user's eyes.
 *
 * After a turn writes files, the preview reloads and may throw. Instead of
 * waiting for someone to notice the ✖ badge, the agent gets one more turn whose
 * only job is to fix what actually broke.
 *
 * It is deliberately bounded, because this is exactly the place where an agent
 * can spend a hundred requests "fixing" things that were never broken:
 *
 *   • only runtime/console errors — never warnings, never a hunch;
 *   • only after a turn that changed files and stopped normally (not stopped by
 *     the user, not cut off by the budget);
 *   • only once per turn, and only with budget left;
 *   • only if the same error was not already offered for fixing.
 *
 * The decision is a pure function so it can be tested without a browser.
 */

/** Errors worth spending a request on. */
export const FIXABLE_KINDS = new Set(['runtime', 'console', 'preview']);

/**
 * Whether verification is worth waiting for at all — decided before the preview
 * has reported anything, so a stopped or empty turn does not sit for a second
 * and a half for nothing.
 */
export function canVerify({ finishReason = 'stop', filesChanged = false, budgetLeft = 0, verifyAlready = false, enabled = true } = {}) {
  if (!enabled) return false;
  if (finishReason !== 'stop') return false;
  if (!filesChanged) return false;
  if (verifyAlready) return false;
  return budgetLeft >= 2;
}

/**
 * @param {object} input
 * @param {string} input.finishReason   how the turn ended
 * @param {Array}  input.errors         preview errors collected so far
 * @param {boolean} input.verifyAlready whether this turn already had a verify pass
 * @param {boolean} input.filesChanged  whether the turn wrote anything
 * @param {number} input.budgetLeft     model requests left in this turn
 * @param {Set<string>} [input.seen]    error keys already offered for fixing
 */
export function verifyDecision({
  finishReason = 'stop',
  errors = [],
  verifyAlready = false,
  filesChanged = false,
  budgetLeft = 0,
  seen = new Set(),
  enabled = true,
} = {}) {
  if (!enabled) return { go: false, reason: 'disabled' };
  if (finishReason !== 'stop') return { go: false, reason: finishReason };
  if (!filesChanged) return { go: false, reason: 'nothing changed' };
  if (verifyAlready) return { go: false, reason: 'already verified' };
  if (budgetLeft < 2) return { go: false, reason: 'no budget' };

  const fixable = errors.filter((error) => FIXABLE_KINDS.has(error?.kind || 'runtime'));
  const fresh = fixable.filter((error) => !seen.has(keyOf(error)));
  if (!fresh.length) return { go: false, reason: fixable.length ? 'already reported' : 'no errors' };

  return { go: true, errors: fresh, reason: 'runtime errors in the preview' };
}

/** Stable identity for an error, so the same one is never fixed twice. */
export function keyOf(error) {
  const message = String(error?.message || '').replace(/:\d+:\d+/g, ':LINE');
  return `${error?.kind || 'runtime'}|${message}`.slice(0, 240);
}

/**
 * The message the agent sends itself.
 *
 * Phrased as a user report, not as an instruction from the harness: the model
 * takes a bug report seriously and a system-level reproach defensively, and it
 * already has the files it wrote in context.
 */
export function verificationPrompt(errors = [], { where = '' } = {}) {
  const list = errors
    .slice(0, 6)
    .map((error, i) => {
      const location = error.where ? ` (${error.where})` : '';
      const stack = error.stack ? `\n   ${String(error.stack).split('\n').slice(0, 2).join('\n   ')}` : '';
      return `${i + 1}. ${error.message}${location}${stack}`;
    })
    .join('\n');
  return [
    where === 'preview' ? 'The preview is throwing these errors after the last change:' : 'The last change left these errors:',
    '',
    list,
    '',
    'Fix the cause in the files you just wrote — do not rewrite the whole project, and do not touch anything unrelated. Then run it once to confirm it is clean.',
  ].join('\n');
}

/**
 * A compact, human sentence for the activity feed: what was verified and how it
 * went. Used by the UI so the three states read the same everywhere.
 */
export function verifySummary(errors, { fixed = true } = {}) {
  const count = errors?.length || 0;
  if (!count) return fixed ? 'Verified — preview is clean' : 'Verified';
  return fixed
    ? `Caught ${count} preview error${count === 1 ? '' : 's'} and fixed ${count === 1 ? 'it' : 'them'}`
    : `Preview has ${count} error${count === 1 ? '' : 's'}`;
}

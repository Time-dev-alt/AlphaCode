/**
 * Visual edits — the prompt side of "click the thing you want changed".
 *
 * Lovable's signature interaction is: click an element in the preview, adjust it
 * directly. AlphaCode already had the picker (it puts the selector in the
 * prompt), but a selector plus "change: " still leaves the user to invent the
 * instruction. These builders turn a click plus one value into a precise,
 * one-file, one-edit instruction — which is both easier for a non-coder and
 * cheaper for the model, because a precise instruction needs one request.
 */

/** What each quick edit is called in the UI. */
export const VISUAL_ACTIONS = [
  { id: 'text', label: 'Text' },
  { id: 'color', label: 'Colour' },
  { id: 'space', label: 'Spacing' },
  { id: 'size', label: 'Text size' },
  { id: 'hide', label: 'Hide' },
  { id: 'delete', label: 'Delete' },
];

/**
 * Compose the instruction the agent receives.
 *
 * @param {{selector?:string, tag?:string, text?:string}} target  the picked element
 * @param {{action:string, value?:string, unit?:string}} edit
 * @returns {string}
 */
export function visualEditPrompt(target = {}, edit = {}) {
  const where = describeTarget(target);
  const value = String(edit.value ?? '').trim();
  const unit = edit.unit || '';

  switch (edit.action) {
    case 'text':
      return `${where}, change the text to "${value}". Keep everything else in the file identical — one edit, no restyling.`;
    case 'color':
      return `${where}, change its colour to ${value}. If it is text, change the text colour; if it is a surface, its background. Keep the rest of the design identical.`;
    case 'space':
      return `${where}, change its outer spacing to ${value}${unit || 'px'} (padding first, margin only if padding does not fit). Keep the layout otherwise identical.`;
    case 'size':
      return `${where}, change the font size to ${value}${unit || 'px'}. Keep the rest of the design identical.`;
    case 'hide':
      return `${where}, hide it from the page (do not delete the markup or the styles, just stop it rendering).`;
    case 'delete':
      return `${where}, delete it entirely — markup, its styles if they are now unused, and any handler that only existed for it.`;
    default:
      return `${where}, change: ${value}`;
  }
}

function describeTarget(target = {}) {
  const tag = target.tag ? `a <${target.tag}>` : 'the selected element';
  const selector = target.selector ? ` (${target.selector})` : '';
  const label = target.text ? ` showing “${String(target.text).slice(0, 40)}”` : '';
  return `In the preview, ${tag}${selector}${label}`;
}

/** Human summary for the toast: "Text of h2 → Hello" */
export function visualEditSummary(target = {}, edit = {}) {
  const what = edit.action === 'text' ? 'Text' : VISUAL_ACTIONS.find((a) => a.id === edit.action)?.label || 'Change';
  const tag = target.tag ? target.tag : 'element';
  return `${what} of <${tag}>${edit.value ? ` → ${String(edit.value).slice(0, 32)}` : ''}`;
}

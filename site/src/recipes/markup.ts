/**
 * The only inline markup a recipe's ingredient/instruction/note text uses is
 * `**bold**`, for quantities and measurements — not a general Markdown
 * renderer, and no dependency for one. Escapes the source text first so
 * nothing else it contains can inject markup; `**` is the one thing this
 * adds back in, deliberately.
 *
 * Two renderings of the same `**...**` markup, not one, because ingredients
 * and instructions are read differently: ingredients are scanned for
 * amounts, so those get full bold. Instructions are read continuously, so
 * the same markers there get a quieter, merely-semibold treatment instead —
 * full bold on every number in a paragraph reads as noisy and interrupts
 * the sentence.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function render(text: string, open: string, close: string): string {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, `${open}$1${close}`);
}

/** Ingredients: full bold — this is where a reader scans for amounts. */
export function renderInline(text: string): string {
  return render(text, '<strong>', '</strong>');
}

/** Instructions and notes: quiet, semibold emphasis only — read continuously, not scanned. */
export function renderQuiet(text: string): string {
  return render(text, '<span class="measurement">', '</span>');
}

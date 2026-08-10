/**
 * Ingredients and steps are real checkboxes (`.recipe-check`) — checked
 * without this script too, and the strikethrough/muted treatment on a
 * checked item is pure CSS (`:checked ~ span`), not something this script
 * draws. What JS adds on top: remembering which boxes were checked (per
 * recipe, per section, in localStorage — so leaving the kitchen mid-recipe
 * and coming back doesn't lose your place) and a small "6/11 · 55%"
 * counter next to each section heading, which has no honest server-
 * rendered value (nothing is checked yet on a fresh load) and so is left
 * out of the markup entirely rather than rendered as "0/11 · 0%".
 */

// An empty export makes this a real ES module rather than a global script —
// without one, `init` below is a *global* declaration (same as
// photography/browse.ts's own top-level `init`), and TypeScript, correctly,
// refuses to compile two different global functions with the same name.
export {};

function sectionStorageKey(slug: string, sectionName: string): string {
  return `recipe-checklist:${slug}:${sectionName}`;
}

function init(): void {
  const scope = document.querySelector<HTMLElement>('[data-recipe-slug]');
  const slug = scope?.dataset['recipeSlug'];
  if (!slug) return;

  const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-checklist]'));
  for (const section of sections) {
    const name = section.dataset['checklist'];
    if (!name) continue;
    const boxes = Array.from(section.querySelectorAll<HTMLInputElement>('.recipe-check'));
    if (boxes.length === 0) continue;
    const progress = section.querySelector<HTMLElement>('[data-recipe-progress]');
    const key = sectionStorageKey(slug, name);

    let stored: Set<number>;
    try {
      stored = new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as number[]);
    } catch {
      stored = new Set();
    }
    boxes.forEach((box, index) => {
      box.checked = stored.has(index);
    });

    const update = (): void => {
      const checkedCount = boxes.filter((box) => box.checked).length;
      if (progress) {
        progress.textContent =
          checkedCount === 0
            ? ''
            : `${String(checkedCount)}/${String(boxes.length)} · ${String(Math.round((checkedCount / boxes.length) * 100))}%`;
      }
    };
    update();

    for (const box of boxes) {
      box.addEventListener('change', () => {
        const checkedIndices = boxes
          .map((candidate, index) => (candidate.checked ? index : null))
          .filter((index): index is number => index !== null);
        localStorage.setItem(key, JSON.stringify(checkedIndices));
        update();
      });
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

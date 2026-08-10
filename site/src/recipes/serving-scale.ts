import { scaleQuantity } from './scale.ts';

/**
 * Progressive enhancement over a plain, correct 1x recipe: without this
 * script the buttons still render (see the styles below hiding nothing
 * server-side) but do nothing, and every quantity is exactly what was
 * written. Each `<strong>`'s original text is cached in a data attribute
 * the first time it's touched, so switching ½x -> 2x -> ½x always scales
 * from the source text rather than re-scaling an already-scaled, already-
 * rounded display value and drifting.
 */
function init(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-scale-factor]'));
  if (buttons.length === 0) return;

  const quantities = Array.from(document.querySelectorAll<HTMLElement>('.recipe-doc-list strong'));
  const servingsEl = document.querySelector<HTMLElement>('[data-servings-value]');

  function original(el: HTMLElement): string {
    const cached = el.dataset['original'];
    if (cached !== undefined) return cached;
    el.dataset['original'] = el.textContent ?? '';
    return el.dataset['original'];
  }

  function apply(factor: number): void {
    for (const el of quantities) {
      el.textContent = scaleQuantity(original(el), factor);
    }
    if (servingsEl) {
      servingsEl.textContent = scaleQuantity(original(servingsEl), factor);
    }
    for (const button of buttons) {
      const isActive = Number(button.dataset['scaleFactor']) === factor;
      button.setAttribute('aria-pressed', String(isActive));
    }
  }

  for (const button of buttons) {
    button.addEventListener('click', () => {
      const factor = Number(button.dataset['scaleFactor']);
      if (!Number.isNaN(factor)) apply(factor);
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

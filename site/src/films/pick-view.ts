/**
 * Pick for me: draws a number of films from whatever the page is showing
 * (the genre filter narrows the pool; Shuffle's order doesn't matter) and
 * lights them where they stand — the gallery is the result. Every other
 * film dims to 25% until Clear or the next pick; nothing moves, hides or
 * reflows. Picks are numbered in the order they sit on the page, and
 * each one's mark carries a jump to the next, so picks a long scroll apart
 * are never lost. One film by default, two or three on request. Shuffle,
 * which is for browsing rather than deciding, clears the picks.
 */
import { pickCount, pickRandom } from './pick.ts';

const form = document.querySelector<HTMLFormElement>('[data-film-pick]');
const status = document.querySelector<HTMLElement>('[data-film-pick-status]');
const clearButton = document.querySelector<HTMLButtonElement>('[data-film-pick-clear]');
const genreSelect = document.querySelector<HTMLSelectElement>('[data-film-genre-select]');
const cards = Array.from(document.querySelectorAll<HTMLElement>('.film-card'));
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

if (form && status && clearButton && cards.length > 0) {
  form.hidden = false;
  const root = document.documentElement;
  root.classList.add('films-pick-ready');
  let picked: HTMLElement[] = [];

  const eligible = (): HTMLElement[] => cards.filter((card) => card.hidden === false);
  // Smooth for a nearby pick; a pick thousands of pixels away is reached
  // at once (a browser's smooth scroll across 775 films takes seconds),
  // and the spotlight's own fade makes the arrival gentle anyway.
  const scrollTo = (card: HTMLElement): void => {
    const box = card.getBoundingClientRect();
    const far =
      Math.abs(box.top + box.height / 2 - window.innerHeight / 2) > 2.5 * window.innerHeight;
    card.scrollIntoView({
      behavior: reducedMotion.matches || far ? 'instant' : 'smooth',
      block: 'center',
    });
  };
  const inPageOrder = (a: HTMLElement, b: HTMLElement): number =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  const visiblePicks = (): HTMLElement[] =>
    picked.filter((card) => card.hidden === false).sort(inPageOrder);

  const describe = (card: HTMLElement): string => {
    const { title = '', year = '' } = card.dataset;
    return year ? `${title} (${year})` : title;
  };

  /** Centred where it fits; focus follows for a keyboard or screen-reader visitor. */
  const goTo = (card: HTMLElement): void => {
    scrollTo(card);
    card.tabIndex = -1;
    card.focus({ preventScroll: true });
  };

  /**
   * (Re)writes each visible pick's mark in page order: "Picked for you" for
   * one, "Picked · 2 of 4" and a jump to the next for several. Run after a
   * pick, a Shuffle (which reorders the page) and a genre change.
   */
  const label = (): void => {
    const shown = visiblePicks();
    shown.forEach((card, index) => {
      card.querySelector('.film-picked-mark')?.remove();
      const mark = document.createElement('p');
      mark.className = 'film-picked-mark';
      const text = document.createElement('span');
      text.textContent =
        shown.length === 1
          ? 'Picked for you'
          : `Picked · ${String(index + 1)} of ${String(shown.length)}`;
      mark.append(text);
      const next = shown[(index + 1) % shown.length];
      if (shown.length > 1 && next) {
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'film-picked-next';
        const last = index === shown.length - 1;
        jump.textContent = last ? 'first ↑' : 'next ↓';
        jump.setAttribute('aria-label', `${last ? 'First' : 'Next'} pick: ${describe(next)}`);
        jump.addEventListener('click', () => goTo(next));
        mark.append(jump);
      }
      card.querySelector('.film-card-body')?.prepend(mark);
    });
  };

  const clear = (): void => {
    for (const card of picked) {
      card.classList.remove('is-picked');
      card.querySelector('.film-picked-mark')?.remove();
    }
    picked = [];
    root.classList.remove('films-picking');
    clearButton.hidden = true;
  };

  const pick = (): void => {
    const pool = eligible();
    const requested =
      form.querySelector<HTMLInputElement>('input[name="film-pick-count"]:checked')?.value ?? '1';
    const count = pickCount(requested, pool.length);
    // The old picks' marks go and the new ones' arrive in the same frame,
    // so the opacity transition carries the light from one set to the next.
    clear();
    if (count === 0) {
      status.textContent = 'No films to pick from with this genre.';
      return;
    }
    picked = pickRandom(pool, count);
    for (const card of picked) card.classList.add('is-picked');
    root.classList.add('films-picking');
    clearButton.hidden = false;
    label();

    const asked = Number(requested);
    const genre = genreSelect?.value ?? '';
    const where = genre ? ` in ${genre}` : '';
    status.textContent =
      Number.isFinite(asked) && asked > pool.length
        ? `Only ${String(pool.length)} films${where}, so all of them are picked.`
        : count === 1
          ? `Picked ${describe(picked[0] as HTMLElement)}.`
          : `Picked ${String(count)} films${where}. The first is in view; each pick links to the next.`;

    const [first] = visiblePicks();
    if (first) scrollTo(first);
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    pick();
  });

  // Browsers don't submit a form on Enter from a radio; here it should,
  // since the numerals sit after the button in the tab order.
  form.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'radio') return;
    event.preventDefault();
    pick();
  });

  clearButton.addEventListener('click', () => {
    clear();
    status.textContent = 'Picks cleared.';
    // The Clear button just hid itself.
    form.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
  });

  // Both run after the page's own listeners (this module loads after its
  // script), so the cards are already reordered or filtered here.
  // Shuffle is for browsing: it puts the whole wall back in the light.
  // Caught in the capture phase so this runs before the page's own Shuffle
  // listener, and without the fade, so motion.ts settles every card
  // towards full opacity rather than towards the dimmed 25%.
  document.addEventListener(
    'click',
    (event) => {
      if (picked.length === 0) return;
      if (!(event.target instanceof Element) || !event.target.closest('[data-film-shuffle]'))
        return;
      root.classList.add('films-pick-snap');
      clear();
      status.textContent = 'Picks cleared.';
      requestAnimationFrame(() => root.classList.remove('films-pick-snap'));
    },
    { capture: true },
  );
  genreSelect?.addEventListener('change', () => {
    if (picked.length === 0) return;
    // A filter that hides every pick would leave a dimmed wall with
    // nothing lit — that's a cleared pick, said plainly.
    if (visiblePicks().length === 0) {
      clear();
      status.textContent = 'Picks cleared: none of them are in this genre.';
    } else {
      label();
    }
  });
}

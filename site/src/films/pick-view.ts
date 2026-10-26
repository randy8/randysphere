/**
 * Pick for me: one film drawn from whatever the page is showing (the genre
 * filter narrows the pool; Shuffle's order doesn't matter), lit where it
 * stands — the gallery is the result. Every other film dims to 25% and the
 * pick is centred in view; nothing moves, hides or reflows. Pressing it
 * again picks another. Shuffle, which is for browsing rather than
 * deciding, puts the whole wall back in the light, as does Escape.
 */
import { pickRandom } from './pick.ts';

const form = document.querySelector<HTMLFormElement>('[data-film-pick]');
const status = document.querySelector<HTMLElement>('[data-film-pick-status]');
const genreSelect = document.querySelector<HTMLSelectElement>('[data-film-genre-select]');
const cards = Array.from(document.querySelectorAll<HTMLElement>('.film-card'));
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

if (form && status && cards.length > 0) {
  form.hidden = false;
  const root = document.documentElement;
  root.classList.add('films-pick-ready');
  let picked: HTMLElement | null = null;

  // Smooth for a nearby film; one thousands of pixels away is reached at
  // once (a browser's smooth scroll across 775 films takes seconds), and
  // the spotlight's own fade makes the arrival gentle anyway.
  const scrollTo = (card: HTMLElement): void => {
    const box = card.getBoundingClientRect();
    const far =
      Math.abs(box.top + box.height / 2 - window.innerHeight / 2) > 2.5 * window.innerHeight;
    card.scrollIntoView({
      behavior: reducedMotion.matches || far ? 'instant' : 'smooth',
      block: 'center',
    });
  };

  const clear = (): void => {
    if (picked === null) return;
    picked.classList.remove('is-picked');
    picked.querySelector('.film-picked-mark')?.remove();
    picked = null;
    root.classList.remove('films-picking');
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const pool = cards.filter((card) => card.hidden === false && card !== picked);
    // The old pick's light goes out and the new one's comes on in the same
    // frame, so the opacity transition carries it from one to the next.
    clear();
    const [card] = pickRandom(pool, 1);
    if (card === undefined) {
      status.textContent = 'No films to pick from with this genre.';
      return;
    }
    picked = card;
    card.classList.add('is-picked');
    // Words as well as the warm frame, so the pick never depends on colour.
    const mark = document.createElement('p');
    mark.className = 'film-picked-mark';
    mark.textContent = 'Picked for you';
    card.querySelector('.film-card-body')?.prepend(mark);
    root.classList.add('films-picking');
    // The title from its heading, the release year from the card itself.
    const title = card.querySelector('.film-title')?.textContent?.trim() ?? '';
    const year = card.dataset['year'] ?? '';
    status.textContent = `Picked ${title}${year ? ` (${year})` : ''}.`;
    scrollTo(card);
    // Focus follows, for a keyboard or screen-reader visitor; the card is
    // focusable only for this, never in the tab order.
    card.tabIndex = -1;
    card.focus({ preventScroll: true });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || picked === null) return;
    clear();
    status.textContent = 'Pick cleared.';
  });

  // Shuffle is for browsing: it puts the whole wall back in the light.
  // Caught in the capture phase so this runs before the page's own Shuffle
  // listener, and without the fade, so motion.ts settles every card
  // towards full opacity rather than towards the dimmed 25%.
  document.addEventListener(
    'click',
    (event) => {
      if (picked === null) return;
      if (!(event.target instanceof Element) || !event.target.closest('[data-film-shuffle]'))
        return;
      root.classList.add('films-pick-snap');
      clear();
      requestAnimationFrame(() => root.classList.remove('films-pick-snap'));
    },
    { capture: true },
  );

  // A genre that hides the pick leaves nothing lit on a dimmed wall:
  // that's a cleared pick, said plainly. Runs after the page's own genre
  // listener (this module loads after it), so `hidden` is current here.
  genreSelect?.addEventListener('change', () => {
    if (picked === null || picked.hidden === false) return;
    clear();
    status.textContent = 'Pick cleared: it isn’t in this genre.';
  });
}

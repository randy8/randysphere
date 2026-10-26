/**
 * Pick for me: one film drawn from whatever the page is showing (the genre
 * filter narrows the pool; Shuffle's order doesn't matter), shown at once
 * in a dialog over wherever the visitor is — its own card: poster, date
 * watched, title (the Letterboxd link), credits, synopsis. The page behind
 * stays put, seen through a translucent paper backdrop, and can't scroll
 * while it's open; closing (×, Escape, a click outside) returns to exactly
 * where it was. "Another" draws again without closing.
 *
 * (Until 2026-10-26 a pick dimmed every other film and scrolled the page
 * to the chosen one, losing the visitor's place.)
 */
import { pickRandom } from './pick.ts';

const form = document.querySelector<HTMLFormElement>('[data-film-pick]');
const status = document.querySelector<HTMLElement>('[data-film-pick-status]');
const dialog = document.querySelector<HTMLDialogElement>('[data-film-pick-dialog]');
const body = dialog?.querySelector<HTMLElement>('[data-film-pick-body]');
const cards = Array.from(document.querySelectorAll<HTMLElement>('.film-card'));

if (form && status && dialog && body && cards.length > 0) {
  form.hidden = false;
  let current: HTMLElement | null = null;
  let scrollY = 0;

  // The page holds still under the dialog: fixed in place at its own
  // offset, so nothing behind moves, and put back exactly on close.
  const lock = (): void => {
    scrollY = window.scrollY;
    const style = document.body.style;
    style.position = 'fixed';
    style.top = `${String(-scrollY)}px`;
    style.left = '0';
    style.right = '0';
  };
  const unlock = (): void => {
    const style = document.body.style;
    style.position = '';
    style.top = '';
    style.left = '';
    style.right = '';
    window.scrollTo({ top: scrollY, behavior: 'instant' });
  };

  /** The picked film's card, as the dialog shows it: a copy, never the card itself. */
  const show = (card: HTMLElement): void => {
    const copy = card.cloneNode(true) as HTMLElement;
    copy.removeAttribute('id');
    copy.removeAttribute('hidden');
    copy.classList.add('film-pick-card');
    copy.querySelector('.film-title')?.setAttribute('id', 'film-pick-title');
    // The poster is already loaded on the page; never lazy here.
    copy.querySelector('img')?.setAttribute('loading', 'eager');
    body.replaceChildren(copy);
    current = card;
    const title = card.querySelector('.film-title')?.textContent?.trim() ?? '';
    const year = card.dataset['year'] ?? '';
    status.textContent = `Picked ${title}${year ? ` (${year})` : ''}.`;
  };

  const pick = (): HTMLElement | undefined => {
    const pool = cards.filter((card) => card.hidden === false && card !== current);
    return pickRandom(pool, 1)[0];
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const card = pick();
    if (card === undefined) {
      status.textContent = 'No films to pick from with this genre.';
      return;
    }
    show(card);
    lock();
    dialog.showModal();
    // Focus starts on the sheet itself, not the × (where a browser would
    // put it, ringed): Tab still reaches ×, the title and Another.
    dialog.querySelector<HTMLElement>('[data-film-pick-sheet]')?.focus({ preventScroll: true });
  });

  dialog.querySelector('[data-film-pick-again]')?.addEventListener('click', () => {
    const card = pick();
    if (card !== undefined) show(card);
  });
  dialog.querySelector('[data-film-pick-close]')?.addEventListener('click', () => dialog.close());
  // A click on the backdrop lands on the dialog element itself.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  // Escape, ×, a click outside — every way out comes through here.
  dialog.addEventListener('close', () => {
    unlock();
    current = null;
    form.querySelector('button')?.focus({ preventScroll: true });
  });
}

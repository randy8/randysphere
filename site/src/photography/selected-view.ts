/**
 * Selected Work's two controls — a film-stock filter and Shuffle — both
 * progressive enhancement over a grid that already renders complete, in
 * featuredOrder, with no script at all. The toolbar is server-rendered
 * `hidden` and only revealed here, so a no-JS visitor never sees a control
 * that can't do anything.
 *
 * Neither control reloads the page: both rearrange the grid's own
 * <figure>s in place and hand the resulting order to the lightbox
 * (setLightboxOrder), so prev/next always steps through exactly what the
 * grid shows. The filter lives in `?film=<stock>` so a filtered view
 * survives a reload and can be shared; shuffle order is deliberately not
 * kept anywhere — a reload goes back to the editorial sequence.
 */

import { setLightboxOrder } from './lightbox.ts';

const FILM_PARAM = 'film';

function shuffled<T>(values: readonly T[]): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

function init(): void {
  const grid = document.querySelector<HTMLElement>('[data-grid]');
  const toolbar = document.querySelector<HTMLElement>('[data-selected-toolbar]');
  if (grid === null || toolbar === null) return;

  const select = toolbar.querySelector<HTMLSelectElement>('[data-film-filter]');
  const shuffleButton = toolbar.querySelector<HTMLButtonElement>('[data-shuffle]');
  const figures = Array.from(grid.querySelectorAll<HTMLElement>(':scope > [data-photo-id]'));

  const apply = (): void => {
    const stock = select?.value ?? '';
    const visible: string[] = [];
    for (const figure of Array.from(
      grid.querySelectorAll<HTMLElement>(':scope > [data-photo-id]'),
    )) {
      const shown = stock === '' || figure.dataset['filmStock'] === stock;
      figure.hidden = !shown;
      if (shown) visible.push(figure.dataset['photoId'] ?? '');
    }
    setLightboxOrder(visible);
  };

  if (select !== null) {
    const requested = new URL(location.href).searchParams.get(FILM_PARAM) ?? '';
    if (Array.from(select.options).some((option) => option.value === requested)) {
      select.value = requested;
    }
    select.addEventListener('change', () => {
      const url = new URL(location.href);
      if (select.value === '') url.searchParams.delete(FILM_PARAM);
      else url.searchParams.set(FILM_PARAM, select.value);
      history.replaceState(null, '', url);
      apply();
    });
  }

  shuffleButton?.addEventListener('click', () => {
    for (const figure of shuffled(figures)) grid.appendChild(figure);
    apply();
  });

  toolbar.hidden = false;
  apply();
}

init();

/**
 * Selected Work's controls — location and film-stock filters, and Shuffle —
 * all progressive enhancement over a grid that already renders complete,
 * in featuredOrder, with no script at all. With script, every visit opens
 * on a fresh random order (and Shuffle deals another); a no-JS visitor
 * gets the editorial sequence. The toolbar is server-rendered `hidden` and
 * only revealed here, so a no-JS visitor never sees a control that can't
 * do anything.
 *
 * Nothing reloads the page: shuffling rearranges the grid's own <figure>s
 * in place, and every change hands the resulting order to the lightbox
 * (setLightboxOrder), so prev/next always steps through exactly what the
 * grid shows. The filters live in `?location=<city>` and `?film=<stock>`
 * (both apply at once) so a filtered view survives a reload and can be
 * shared; the order deliberately isn't kept anywhere.
 */

import { setLightboxOrder } from './lightbox.ts';
import { shuffled } from './shuffle-grid.ts';

const FILM_PARAM = 'film';
const LOCATION_PARAM = 'location';

function init(): void {
  const grid = document.querySelector<HTMLElement>('[data-grid]');
  const toolbar = document.querySelector<HTMLElement>('[data-selected-toolbar]');
  if (grid === null || toolbar === null) return;

  const select = toolbar.querySelector<HTMLSelectElement>('[data-film-filter]');
  const locationSelect = toolbar.querySelector<HTMLSelectElement>('[data-location-filter]');
  const shuffleButton = toolbar.querySelector<HTMLButtonElement>('[data-shuffle]');
  // The exhibition plays whatever the filters show.
  const exhibit = toolbar.querySelector<HTMLAnchorElement>('[data-exhibit]');
  const figures = Array.from(grid.querySelectorAll<HTMLElement>(':scope > [data-photo-id]'));

  const apply = (): void => {
    const stock = select?.value ?? '';
    const place = locationSelect?.value ?? '';
    const visible: string[] = [];
    for (const figure of Array.from(
      grid.querySelectorAll<HTMLElement>(':scope > [data-photo-id]'),
    )) {
      const shown =
        (stock === '' || figure.dataset['filmStock'] === stock) &&
        (place === '' || (figure.dataset['cities'] ?? '').split(' ').includes(place));
      figure.hidden = !shown;
      if (shown) visible.push(figure.dataset['photoId'] ?? '');
    }
    setLightboxOrder(visible);
    if (exhibit !== null) {
      const query = new URLSearchParams();
      if (place !== '') query.set('tag', place);
      if (stock !== '') query.set('film', stock);
      const search = query.toString();
      exhibit.href = `/exposures/gallery/${search === '' ? '' : `?${search}`}`;
    }
  };

  // Each filter mirrors itself into one query parameter, so a filtered view
  // survives a reload and can be shared.
  for (const [control, param] of [
    [select, FILM_PARAM],
    [locationSelect, LOCATION_PARAM],
  ] as const) {
    if (control === null) continue;
    const requested = new URL(location.href).searchParams.get(param) ?? '';
    if (Array.from(control.options).some((option) => option.value === requested)) {
      control.value = requested;
    }
    control.addEventListener('change', () => {
      const url = new URL(location.href);
      if (control.value === '') url.searchParams.delete(param);
      else url.searchParams.set(param, control.value);
      history.replaceState(null, '', url);
      apply();
    });
  }

  const shuffle = (): void => {
    for (const figure of shuffled(figures, (tile) => Number(tile.dataset['w']) || 1)) {
      grid.appendChild(figure);
    }
  };
  shuffleButton?.addEventListener('click', () => {
    shuffle();
    apply();
  });

  // The first deal happened before the first paint (GridLayout.astro); only
  // the Shuffle button deals again.
  toolbar.hidden = false;
  apply();
}

init();

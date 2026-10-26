/**
 * One preference — the original recipes, or vegan — remembered in this
 * browser and shared by every page that shows recipes:
 *
 * - a recipe that can be made vegan offers Original · Vegan beside its
 *   scale, and shows whichever is chosen (the CSS keyed on data-version
 *   does the showing; both versions are already in the page);
 * - the Dishes index offers All · Vegan, and with Vegan shows only the
 *   recipes that are vegan or can be made so.
 *
 * Choosing Vegan in either place chooses it in both, so a recipe opened
 * from the Vegan list opens in its vegan version. Without JavaScript both
 * controls stay hidden and every recipe reads as written.
 */

const KEY = 'dishes:version';
type Version = 'original' | 'vegan';

function stored(): Version {
  try {
    return localStorage.getItem(KEY) === 'vegan' ? 'vegan' : 'original';
  } catch {
    return 'original';
  }
}

function store(version: Version): void {
  try {
    localStorage.setItem(KEY, version);
  } catch {
    // Private browsing or storage off: the choice holds for this page only.
  }
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function press(buttons: readonly HTMLButtonElement[], attribute: string, value: string): void {
  for (const button of buttons)
    button.setAttribute('aria-pressed', String(button.dataset[attribute] === value));
}

function initRecipe(): void {
  const article = document.querySelector<HTMLElement>('.recipe-doc');
  const toggle = document.querySelector<HTMLElement>('[data-version-toggle]');
  if (article === null || toggle === null) return;
  const buttons = Array.from(toggle.querySelectorAll<HTMLButtonElement>('[data-version-choice]'));
  const lists = Array.from(
    article.querySelectorAll<HTMLElement>('.recipe-doc-list, .recipe-doc-steps, .v-only'),
  );

  const show = (version: Version, animate: boolean): void => {
    article.dataset['version'] = version;
    press(buttons, 'versionChoice', version);
    // A short settle so the change registers, not a performance.
    if (animate && !reducedMotion.matches) {
      for (const list of lists)
        list.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    }
  };

  toggle.hidden = false;
  show(stored(), false);
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const version: Version = button.dataset['versionChoice'] === 'vegan' ? 'vegan' : 'original';
      if (article.dataset['version'] === version) return;
      store(version);
      show(version, true);
    });
  }
}

function initIndex(): void {
  const filter = document.querySelector<HTMLElement>('[data-diet-filter]');
  if (filter === null) return;
  const buttons = Array.from(filter.querySelectorAll<HTMLButtonElement>('[data-diet-choice]'));
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-diet]'));
  const status = document.querySelector<HTMLElement>('[data-diet-status]');

  const show = (version: Version): void => {
    let shown = 0;
    for (const item of items) {
      item.hidden = version === 'vegan' && item.dataset['diet'] === 'none';
      if (!item.hidden) shown += 1;
    }
    press(buttons, 'dietChoice', version === 'vegan' ? 'vegan' : 'all');
    if (status !== null) {
      status.textContent =
        version === 'vegan' ? `${String(shown)} recipes shown, vegan or adaptable` : '';
    }
  };

  filter.hidden = false;
  show(stored());
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const version: Version = button.dataset['dietChoice'] === 'vegan' ? 'vegan' : 'original';
      store(version);
      show(version);
    });
  }
}

initRecipe();
initIndex();

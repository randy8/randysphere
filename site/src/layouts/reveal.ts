/**
 * The site's one entrance motion: an image-bearing item rises 24px and
 * fades in over 750ms as it first enters the viewport, items arriving
 * together following each other in reading order 80ms apart, captions and
 * words 150ms behind their image. Large single images rise less, more
 * slowly. Each item once per visit; never on Back/Forward, under reduced
 * motion, or without the browser features it needs — the head script in
 * Base.astro decides that, by setting `.motion` on <html> before the first
 * paint, and base.css hides an unrevealed item only while that class is
 * there (so a failure here can never leave the page blank; the head
 * script also lifts the class if this never runs).
 *
 * Opacity and transform only, through the Web Animations API; the rise is
 * added to an item's own transform (`composite: 'add'`), so the photo
 * grid's masonry positions are never disturbed. An item waits for its
 * image (at most 1.2s) so a blank box never fades in. Lightboxes, the
 * Pick dialog and Exhibition keep their own transitions.
 */

/** Keep in step with the selector in base.css (`.motion :is(…)`). */
const TARGETS =
  ':is([data-grid], [data-saved-grid], [data-share-grid]) > [data-photo-id], .film-card:not(.film-pick-card), .archive-entry';
/** What follows its image a beat later. */
const FOLLOWERS = 'figcaption, .frame-mark, .film-card-body, .archive-entry-mark';

const DURATION = 750;
const STAGGER = 80;
const MAX_STEPS = 8;
const RISE = 24;
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
const IMAGE_WAIT = 1200;

const root = document.documentElement;
(window as unknown as { __motion: boolean }).__motion = true;

/** Resolves once the item's image can be shown (or after IMAGE_WAIT). */
function ready(item: Element): Promise<void> {
  const img = item.querySelector('img');
  if (img === null || (img.complete && img.naturalWidth > 0)) return Promise.resolve();
  return new Promise((done) => {
    const finish = (): void => {
      clearTimeout(timer);
      done();
    };
    const timer = setTimeout(finish, IMAGE_WAIT);
    img.addEventListener('load', finish, { once: true });
    img.addEventListener('error', finish, { once: true });
  });
}

function reveal(item: HTMLElement, step: number): void {
  const large = item.getBoundingClientRect().width > window.innerWidth * 0.6;
  const duration = large ? DURATION + 200 : DURATION;
  const rise = large ? RISE * 0.6 : RISE;
  const delay = Math.min(step, MAX_STEPS) * STAGGER;
  item.classList.add('is-revealed');
  item.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration,
    delay,
    easing: EASE,
    fill: 'backwards',
  });
  item.animate([{ transform: `translateY(${String(rise)}px)` }, { transform: 'translateY(0)' }], {
    duration,
    delay,
    easing: EASE,
    fill: 'backwards',
    composite: 'add',
  });
  for (const follower of item.querySelectorAll<HTMLElement>(FOLLOWERS)) {
    follower.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: duration * 0.8,
      delay: delay + 150,
      easing: EASE,
      fill: 'backwards',
    });
  }
}

if (root.classList.contains('motion')) {
  const observer = new IntersectionObserver(
    (entries) => {
      // Arriving together, revealed in reading order: top to bottom, then
      // left to right.
      const arriving = entries
        .filter((entry) => entry.isIntersecting)
        .map((entry) => entry.target as HTMLElement)
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return Math.abs(ra.top - rb.top) > 8 ? ra.top - rb.top : ra.left - rb.left;
        });
      arriving.forEach((item, step) => {
        observer.unobserve(item);
        void ready(item).then(() => reveal(item, step));
      });
    },
    { rootMargin: '0px 0px -6% 0px' },
  );
  const watch = (): void => {
    for (const item of document.querySelectorAll<HTMLElement>(TARGETS)) {
      if (!item.classList.contains('is-revealed')) observer.observe(item);
    }
  };
  watch();
}

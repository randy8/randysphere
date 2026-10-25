/**
 * The Pictures page's motion, all of it short: a poster that arrives
 * rises 8px as it fades in, one that moves glides from where it was. Only
 * posters on screen ever animate — 775 cards are on the page, a dozen or
 * so are visible. Transform and opacity only, through the Web Animations
 * API, so nothing triggers layout while it runs. The page's first arrival
 * (an inline script in pictures/index.astro, which has to run before
 * first paint and so can't import this) uses the same numbers; keep them
 * in step.
 */

export const SETTLE_MS = 360;
export const STAGGER_MS = 14;
// Past this many, every poster starts with the last one: a wide screen
// shows twenty, and they should land together, not one at a time.
export const STAGGER_CAP = 12;
export const MOVE_MS = 420;
// Quick out of the gate, long gentle landing; no overshoot.
export const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const running = new Set<Animation>();

function track(animation: Animation): void {
  running.add(animation);
  const done = (): void => {
    running.delete(animation);
  };
  animation.finished.then(done, done);
}

function onScreen(box: DOMRect): boolean {
  return box.bottom > 0 && box.top < window.innerHeight && box.width > 0;
}

/**
 * Runs `change`, which rearranges `cards` (and may scroll), then animates
 * the result — FLIP, limited to what's visible afterwards. A card that was
 * on screen before glides from its old place to its new one; a card that
 * wasn't settles in where it lands. A second call mid-animation measures
 * every card where it visibly is right then, cancels what's running and
 * starts from there, so rapid clicks never stack or jump.
 */
export function rearrange(cards: readonly HTMLElement[], change: () => void): void {
  if (reducedMotion.matches || typeof Element.prototype.animate !== 'function') {
    change();
    return;
  }

  const before = new Map<HTMLElement, DOMRect>();
  for (const card of cards) {
    if (card.hidden !== false) continue;
    const box = card.getBoundingClientRect();
    if (onScreen(box)) before.set(card, box);
  }
  for (const animation of running) animation.cancel();
  running.clear();

  change();

  let settling = 0;
  for (const card of cards) {
    if (card.hidden !== false) continue;
    const box = card.getBoundingClientRect();
    if (!onScreen(box)) continue;
    const from = before.get(card);
    if (from) {
      const dx = from.left - box.left;
      const dy = from.top - box.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      track(
        card.animate(
          [{ transform: `translate(${String(dx)}px, ${String(dy)}px)` }, { transform: 'none' }],
          { duration: MOVE_MS, easing: EASE },
        ),
      );
    } else {
      // Settle to the card's resting opacity, not to 1: a film dimmed by
      // Pick for me would otherwise brighten and then snap back.
      const opacity = getComputedStyle(card).opacity;
      track(
        card.animate(
          [
            { opacity: 0, transform: 'translateY(8px)' },
            { opacity, transform: 'none' },
          ],
          {
            duration: SETTLE_MS,
            delay: Math.min(settling, STAGGER_CAP) * STAGGER_MS,
            easing: EASE,
            fill: 'backwards',
          },
        ),
      );
      settling += 1;
    }
  }
}

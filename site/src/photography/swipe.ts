/**
 * Touch gestures for the open lightbox photo, on top of lightbox.ts's
 * buttons and keys: swipe left/right to move between photographs — the
 * photo follows the finger with its neighbour sliding in beside it, then
 * settles or springs back — and swipe down to close, the backdrop fading
 * as the photo is pulled away.
 *
 * One finger only, and never while the photo is pinch-zoomed (zoom.ts owns
 * pans then, and marks the frame `.is-zoomed`). The axis is decided once,
 * after a few pixels of movement, so a slightly diagonal swipe never
 * wobbles between the two gestures.
 */

const AXIS_LOCK_DISTANCE = 8;
/** Fraction of the stage width past which a released swipe commits. */
const COMMIT_FRACTION = 0.2;
/** px/ms — a quick flick commits even when short. */
const FLICK_VELOCITY = 0.45;
const CLOSE_DISTANCE = 110;
/** Space between a photo and the neighbour sliding in beside it. */
const GAP = 24;
const SETTLE = 'transform 0.32s cubic-bezier(0.16, 1, 0.3, 1)';

export interface SwipeHooks {
  readonly current: () => HTMLElement | null;
  readonly neighbours: () => { prev: HTMLElement | null; next: HTMLElement | null };
  readonly advance: (forward: boolean) => void;
  readonly close: () => void;
}

interface Drag {
  readonly startX: number;
  readonly startY: number;
  readonly startTime: number;
  axis: 'x' | 'y' | null;
  dx: number;
  dy: number;
  current: HTMLElement;
  prev: HTMLElement | null;
  next: HTMLElement | null;
}

function setTransform(element: HTMLElement | null, value: string, transition: string): void {
  if (element === null) return;
  element.style.transition = transition;
  element.style.transform = value;
}

function clearTransform(element: HTMLElement | null): void {
  if (element === null) return;
  element.style.transition = '';
  element.style.transform = '';
}

export function initSwipe(root: HTMLElement, hooks: SwipeHooks): void {
  const stage = root.querySelector<HTMLElement>('[data-lightbox-stage]');
  if (stage === null) return;

  let drag: Drag | null = null;
  let settling = false;

  const place = (state: Drag, dx: number, transition: string): void => {
    const width = stage.clientWidth + GAP;
    setTransform(state.current, `translate3d(${String(dx)}px, 0, 0)`, transition);
    setTransform(state.prev, `translate3d(${String(dx - width)}px, 0, 0)`, transition);
    setTransform(state.next, `translate3d(${String(dx + width)}px, 0, 0)`, transition);
  };

  const finish = (state: Drag): void => {
    for (const element of [state.current, state.prev, state.next]) {
      clearTransform(element);
      element?.classList.remove('is-peek');
    }
    root.style.removeProperty('--lightbox-backdrop');
    settling = false;
  };

  // Resolves once the settle transition ends (or a beat after, if the
  // browser skips it — a transform that didn't change fires no event).
  const afterSettle = (element: HTMLElement, done: () => void): void => {
    let called = false;
    const once = (): void => {
      if (called) return;
      called = true;
      done();
    };
    element.addEventListener('transitionend', once, { once: true });
    window.setTimeout(once, 400);
  };

  stage.addEventListener(
    'touchstart',
    (event) => {
      if (settling || event.touches.length !== 1) {
        if (drag !== null) {
          place(drag, 0, SETTLE);
          const state = drag;
          drag = null;
          afterSettle(state.current, () => {
            finish(state);
          });
        }
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      // Controls (Save, the film-stock link) keep their own taps.
      if (target !== null && target.closest('button, a') !== null) return;
      const current = hooks.current();
      if (current === null || current.querySelector('.lightbox-frame.is-zoomed') !== null) return;
      const touch = event.touches[0];
      if (touch === undefined) return;
      drag = {
        startX: touch.clientX,
        startY: touch.clientY,
        startTime: performance.now(),
        axis: null,
        dx: 0,
        dy: 0,
        current,
        prev: null,
        next: null,
      };
    },
    { passive: true },
  );

  stage.addEventListener(
    'touchmove',
    (event) => {
      if (drag === null) return;
      const touch = event.touches[0];
      if (touch === undefined) return;
      drag.dx = touch.clientX - drag.startX;
      drag.dy = touch.clientY - drag.startY;

      if (drag.axis === null) {
        if (Math.hypot(drag.dx, drag.dy) < AXIS_LOCK_DISTANCE) return;
        drag.axis = Math.abs(drag.dx) > Math.abs(drag.dy) ? 'x' : 'y';
        if (drag.axis === 'x') {
          const { prev, next } = hooks.neighbours();
          drag.prev = prev === drag.current ? null : prev;
          drag.next = next === drag.current ? null : next;
          // With exactly two photographs both neighbours are the same
          // element; it can only stand on the side the swipe is heading.
          if (drag.prev !== null && drag.prev === drag.next) {
            if (drag.dx < 0) drag.prev = null;
            else drag.next = null;
          }
          drag.prev?.classList.add('is-peek');
          drag.next?.classList.add('is-peek');
        }
      }
      event.preventDefault();

      if (drag.axis === 'x') {
        place(drag, drag.dx, 'none');
      } else {
        // Only downward closes; an upward pull just resists.
        const dy = drag.dy > 0 ? drag.dy : drag.dy / 4;
        const scale = 1 - Math.min(0.12, Math.max(0, dy) / 2000);
        setTransform(
          drag.current,
          `translate3d(0, ${String(dy)}px, 0) scale(${String(scale)})`,
          'none',
        );
        const fade = 1 - Math.min(0.6, Math.max(0, dy) / 400);
        root.style.setProperty('--lightbox-backdrop', String(fade));
      }
    },
    { passive: false },
  );

  const end = (): void => {
    if (drag === null) return;
    const state = drag;
    drag = null;
    if (state.axis === null) return;
    const elapsed = Math.max(1, performance.now() - state.startTime);
    settling = true;

    if (state.axis === 'x') {
      const width = stage.clientWidth + GAP;
      const velocity = state.dx / elapsed;
      const forward = state.dx < 0;
      const neighbour = forward ? state.next : state.prev;
      const commits =
        neighbour !== null &&
        (Math.abs(state.dx) > stage.clientWidth * COMMIT_FRACTION ||
          Math.abs(velocity) > FLICK_VELOCITY);
      place(state, commits ? (forward ? -width : width) : 0, SETTLE);
      afterSettle(state.current, () => {
        if (commits) hooks.advance(forward);
        finish(state);
      });
      return;
    }

    const velocity = state.dy / elapsed;
    if (state.dy > CLOSE_DISTANCE || (state.dy > 30 && velocity > FLICK_VELOCITY)) {
      setTransform(state.current, `translate3d(0, ${String(window.innerHeight)}px, 0)`, SETTLE);
      root.style.setProperty('--lightbox-backdrop', '0');
      afterSettle(state.current, () => {
        hooks.close();
        finish(state);
      });
    } else {
      setTransform(state.current, 'translate3d(0, 0, 0)', SETTLE);
      root.style.removeProperty('--lightbox-backdrop');
      afterSettle(state.current, () => {
        finish(state);
      });
    }
  };

  stage.addEventListener('touchend', end);
  stage.addEventListener('touchcancel', end);
}

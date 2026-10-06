/**
 * Pinch-to-zoom and pan for the open photo in the lightbox — touch-only,
 * purely additive on top of lightbox.ts, and deliberately not double-tap.
 * A plain tap on the photo itself does nothing in the lightbox (navigation
 * is the explicit prev/next buttons, not a tap-zone on the image), so
 * there's no competing single-tap gesture to protect — pinch was simply
 * the gesture worth building: it always takes two touches, which nothing
 * else here ever does, so it can't be mistaken for anything. Once zoomed,
 * a plain tap on the photo is repurposed to back out to fit, since that's
 * otherwise the only way to leave a zoomed-in crop without reaching for
 * the close button or Escape.
 *
 * One delegated listener set on the stage, not one per photo (a Selected
 * Work lightbox alone holds hundreds of frames) — state for whichever
 * frame is actually mid-gesture lives in a WeakMap, created lazily on
 * first touch.
 */

const MAX_SCALE = 4;
const TAP_MOVE_THRESHOLD = 10;
const SNAP_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

interface Point {
  x: number;
  y: number;
}

interface ZoomState {
  scale: number;
  tx: number;
  ty: number;
  pointers: Map<number, Point>;
  pinchStartDist: number;
  pinchStartScale: number;
  panStart: Point | null;
  panStartOffset: Point;
  moved: boolean;
  zoomHandled: boolean;
}

function freshState(): ZoomState {
  return {
    scale: 1,
    tx: 0,
    ty: 0,
    pointers: new Map(),
    pinchStartDist: 0,
    pinchStartScale: 1,
    panStart: null,
    panStartOffset: { x: 0, y: 0 },
    moved: false,
    zoomHandled: false,
  };
}

const states = new WeakMap<HTMLElement, ZoomState>();

function stateFor(frame: HTMLElement): ZoomState {
  let state = states.get(frame);
  if (state === undefined) {
    state = freshState();
    states.set(frame, state);
  }
  return state;
}

// Map#values() iteration order follows insertion order, but TypeScript has
// no way to know a two-entry Map destructures to two defined points — these
// centralize the one non-null assertion each call site would otherwise need.
function onePoint(pointers: Map<number, Point>): Point | null {
  return Array.from(pointers.values())[0] ?? null;
}
function twoPoints(pointers: Map<number, Point>): [Point, Point] | null {
  const [a, b] = Array.from(pointers.values());
  return a !== undefined && b !== undefined ? [a, b] : null;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function localPoint(frame: HTMLElement, touch: Touch): Point {
  const rect = frame.getBoundingClientRect();
  return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
}

function setTransition(img: HTMLElement, on: boolean): void {
  img.style.transition = on ? `transform 0.3s ${SNAP_EASE}` : 'none';
}

function apply(frame: HTMLElement, img: HTMLElement, state: ZoomState): void {
  img.style.transform = `translate(${String(state.tx)}px, ${String(state.ty)}px) scale(${String(state.scale)})`;
  frame.classList.toggle('is-zoomed', state.scale > 1.01);
}

function clamp(frame: HTMLElement, img: HTMLElement, state: ZoomState): void {
  const maxX = Math.max(0, (img.offsetWidth * state.scale - frame.clientWidth) / 2);
  const maxY = Math.max(0, (img.offsetHeight * state.scale - frame.clientHeight) / 2);
  state.tx = Math.min(maxX, Math.max(-maxX, state.tx));
  state.ty = Math.min(maxY, Math.max(-maxY, state.ty));
}

// Rescales around `focal` (frame-local coordinates) rather than the frame's
// own centre, so the point under the fingers — the pinch midpoint — stays
// visually fixed while the scale around it changes.
function zoomAt(frame: HTMLElement, state: ZoomState, focal: Point, requested: number): void {
  const next = Math.min(MAX_SCALE, Math.max(1, requested));
  const centerX = frame.clientWidth / 2 + state.tx;
  const centerY = frame.clientHeight / 2 + state.ty;
  const ratio = next / state.scale;
  state.tx = focal.x - (focal.x - centerX) * ratio - frame.clientWidth / 2;
  state.ty = focal.y - (focal.y - centerY) * ratio - frame.clientHeight / 2;
  state.scale = next;
}

function reset(frame: HTMLElement, img: HTMLElement, state: ZoomState): void {
  if (state.scale === 1 && state.tx === 0 && state.ty === 0) return;
  setTransition(img, true);
  state.scale = 1;
  state.tx = 0;
  state.ty = 0;
  apply(frame, img, state);
}

function suppressNextClick(event: Event): void {
  event.stopPropagation();
  event.preventDefault();
}

function frameAndImg(
  target: EventTarget | null,
): { frame: HTMLElement; img: HTMLImageElement } | null {
  if (!(target instanceof Element)) return null;
  const frame = target.closest<HTMLElement>('.lightbox-frame');
  const img = frame?.querySelector('img') ?? null;
  if (frame === null || img === null) return null;
  return { frame, img };
}

export function initZoom(root: HTMLElement): void {
  const stage = root.querySelector<HTMLElement>('[data-lightbox-stage]');
  if (stage === null) return;

  stage.addEventListener(
    'touchstart',
    (event) => {
      const found = frameAndImg(event.target);
      if (found === null) return;
      const { frame, img } = found;
      const state = stateFor(frame);

      if (state.pointers.size === 0) {
        state.moved = false;
        state.zoomHandled = state.scale > 1;
      }
      setTransition(img, false);
      for (const touch of Array.from(event.changedTouches)) {
        state.pointers.set(touch.identifier, localPoint(frame, touch));
      }

      const startPair = state.pointers.size === 2 ? twoPoints(state.pointers) : null;
      if (startPair !== null) {
        state.pinchStartDist = distance(startPair[0], startPair[1]);
        state.pinchStartScale = state.scale;
        state.panStart = null;
        state.zoomHandled = true;
        event.preventDefault();
      } else if (state.pointers.size === 1 && state.scale > 1) {
        const p = onePoint(state.pointers);
        if (p !== null) {
          state.panStart = p;
          state.panStartOffset = { x: state.tx, y: state.ty };
        }
      }
    },
    { passive: false },
  );

  stage.addEventListener(
    'touchmove',
    (event) => {
      const found = frameAndImg(event.target);
      if (found === null) return;
      const { frame, img } = found;
      const state = stateFor(frame);

      for (const touch of Array.from(event.changedTouches)) {
        if (state.pointers.has(touch.identifier)) {
          state.pointers.set(touch.identifier, localPoint(frame, touch));
        }
      }

      const movePair = state.pointers.size === 2 ? twoPoints(state.pointers) : null;
      if (movePair !== null && state.pinchStartDist > 0) {
        const [a, b] = movePair;
        zoomAt(
          frame,
          state,
          midpoint(a, b),
          state.pinchStartScale * (distance(a, b) / state.pinchStartDist),
        );
        clamp(frame, img, state);
        apply(frame, img, state);
        state.moved = true;
        event.preventDefault();
      } else if (state.pointers.size === 1 && state.panStart !== null) {
        const p = onePoint(state.pointers);
        if (p !== null) {
          const dx = p.x - state.panStart.x;
          const dy = p.y - state.panStart.y;
          if (Math.abs(dx) > TAP_MOVE_THRESHOLD || Math.abs(dy) > TAP_MOVE_THRESHOLD)
            state.moved = true;
          state.tx = state.panStartOffset.x + dx;
          state.ty = state.panStartOffset.y + dy;
          clamp(frame, img, state);
          apply(frame, img, state);
          event.preventDefault();
        }
      }
    },
    { passive: false },
  );

  const end = (event: TouchEvent): void => {
    const found = frameAndImg(event.target);
    if (found === null) return;
    const { frame, img } = found;
    const state = stateFor(frame);

    for (const touch of Array.from(event.changedTouches)) state.pointers.delete(touch.identifier);

    const remainingPair = state.pointers.size === 2 ? twoPoints(state.pointers) : null;
    if (remainingPair !== null) {
      // A third finger lifted off a group of three — re-arm against
      // whichever two remain rather than treating this as the gesture's end.
      state.pinchStartDist = distance(remainingPair[0], remainingPair[1]);
      state.pinchStartScale = state.scale;
      return;
    }
    if (state.pointers.size === 1) {
      // The pinch collapsed to one finger — hand off to panning if still
      // zoomed in, so the gesture doesn't just stop dead.
      state.pinchStartDist = 0;
      const p = state.scale > 1 ? onePoint(state.pointers) : null;
      if (p !== null) {
        state.panStart = p;
        state.panStartOffset = { x: state.tx, y: state.ty };
      }
      return;
    }

    // Every finger is up — the gesture, if any, is over.
    state.pinchStartDist = 0;
    state.panStart = null;
    if (!state.zoomHandled) return;

    // A pinch or a real drag just happened; the browser would otherwise
    // synthesize a click from this same touch sequence, which the nav
    // zones underneath would read as "advance." Swallow just that one.
    event.preventDefault();
    frame.addEventListener('click', suppressNextClick, { capture: true, once: true });
    if (!state.moved && state.scale > 1) reset(frame, img, state);
  };

  stage.addEventListener('touchend', end);
  stage.addEventListener('touchcancel', end);

  // Navigating away from a zoomed-in photo — prev/next, the keyboard, or
  // Saved's contact-sheet grid opening a different one — always resets it,
  // the same way a real photo viewer never leaves the next photograph
  // zoomed in from whatever the last one was left at. Watching `.is-active`
  // itself (rather than calling into lightbox.ts's own navigation
  // functions) keeps this file self-contained — every way a photo stops
  // being active flips this same class (see lightbox.ts's
  // activate()/close()), so there's exactly one thing to watch.
  const items = Array.from(stage.querySelectorAll<HTMLElement>('.lightbox-item'));
  if (items.length === 0) return;
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const item = mutation.target as HTMLElement;
      if (item.classList.contains('is-active')) continue;
      const frame = item.querySelector<HTMLElement>('.lightbox-frame');
      const img = frame?.querySelector('img') ?? null;
      if (frame === null || img === null) continue;
      reset(frame, img, stateFor(frame));
    }
  });
  items.forEach((item) => observer.observe(item, { attributes: true, attributeFilter: ['class'] }));
}

/**
 * /exposures/exhibition/: one photograph at a time, full screen, on a dark
 * wall. What plays and how comes from the URL (exhibition-model.ts); this
 * draws it.
 *
 * Two layers, never more: the photograph on the wall and the next one,
 * loading behind it. A transition starts only once the next photograph is
 * fully decoded, so nothing half-loaded is ever shown; on a slow
 * connection the current photograph simply stays up longer. Memory stays
 * at two images however large the collection.
 *
 * Exactly one photograph is on the wall except during a transition, and a
 * new step first settles any transition still running — so stepping fast
 * can never leave two photographs (or a stale one) showing. Each
 * photograph gets a fresh <img>: a reused one keeps painting its previous
 * photograph until the new bytes arrive, and its decode() can resolve
 * against the old image.
 *
 * A crossfade only between photographs whose frames coincide (the same
 * aspect ratio, so the same box on the wall); otherwise the first goes to
 * the wall before the next arrives, so one frame's edges never show beside
 * the other's. The drift is a scale of at most 3% inside the photograph's
 * margin — it never crops — and doesn't run under reduced motion. Pause
 * holds the drift and the timer; a transition already under way finishes.
 */

import { formatDate } from './date.ts';
import {
  defaultOrder,
  drift,
  fitBox,
  labelOf,
  Playlist,
  readSettings,
  readSource,
  returnHref,
  selectPhotos,
  titleOf,
  writeSettings,
} from './exhibition-model.ts';
import type {
  ExhibitionData,
  ExhibitionPhoto,
  Order,
  Preferences,
  Settings,
} from './exhibition-model.ts';

const PREFERENCES_KEY = 'exhibition-preferences';
const IDLE_MS = 2500;
const LOAD_TIMEOUT_MS = 20_000;
/** A visitor stepping by hand wants the next photograph now, not after the full transition. */
const MANUAL_FADE_S = 0.8;
const SWIPE_PX = 48;

function loadPreferences(): Preferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}');
    return typeof value === 'object' && value !== null ? value : {};
  } catch {
    return {};
  }
}

function savePreferences(settings: Settings): void {
  const { slide, fade, motion, info } = settings;
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ slide, fade, motion, info }));
  } catch {
    // Private browsing or storage disabled: the URL still carries them.
  }
}

interface Layer {
  readonly root: HTMLElement;
  readonly motion: HTMLElement;
  img: HTMLImageElement;
  readonly avif: HTMLSourceElement | undefined;
  readonly webp: HTMLSourceElement | undefined;
  readonly label: HTMLElement;
  photo: ExhibitionPhoto | null;
  ready: Promise<boolean>;
}

function layerOf(root: HTMLElement): Layer | null {
  const motion = root.querySelector<HTMLElement>('[data-motion]');
  const img = root.querySelector('img');
  const label = root.querySelector<HTMLElement>('[data-label]');
  if (motion === null || img === null || label === null) return null;
  const [avif, webp] = Array.from(root.querySelectorAll('source'));
  return { root, motion, img, avif, webp, label, photo: null, ready: Promise.resolve(false) };
}

function start(root: HTMLElement, data: ExhibitionData): void {
  const params = new URLSearchParams(location.search);
  const source = readSource(params);
  const photos = selectPhotos(data.photos, source);
  const naturalOrder: Order = defaultOrder(source);
  let settings = readSettings(params, loadPreferences(), naturalOrder);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  const stage = root.querySelector<HTMLElement>('[data-stage]');
  const layers = Array.from(root.querySelectorAll<HTMLElement>('[data-layer]'), layerOf).filter(
    (layer): layer is Layer => layer !== null,
  );
  const [first, second] = layers;
  if (stage === null || first === undefined || second === undefined) return;

  const title = titleOf(source, data.titles);
  document.title = `${title} — ${document.title}`;
  stage.setAttribute('aria-label', title);
  const titleEl = root.querySelector('[data-title]');
  if (titleEl !== null) titleEl.textContent = title;
  for (const link of root.querySelectorAll<HTMLAnchorElement>('[data-close]')) {
    link.href = returnHref(source);
  }
  root.hidden = false;

  if (photos.length === 0) {
    for (const el of root.querySelectorAll<HTMLElement>('[data-chrome], [data-stage]')) {
      el.hidden = true;
    }
    const empty = root.querySelector<HTMLElement>('[data-empty]');
    if (empty !== null) empty.hidden = false;
    return;
  }

  // --- Drawing one photograph into a layer -----------------------------------

  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  // A low-memory device (most televisions' browsers) decodes nothing wider
  // than 1920 device pixels; two 2560-wide AVIFs at once is where they fail.
  const widestDevicePixels = deviceMemory <= 2 ? 1920 : Number.POSITIVE_INFINITY;

  const size = (layer: Layer): void => {
    const photo = layer.photo;
    if (photo === null) return;
    const style = getComputedStyle(layer.root);
    const areaWidth =
      layer.root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const areaHeight =
      layer.root.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const box = fitBox(photo.width, photo.height, areaWidth, areaHeight);
    layer.img.style.width = `${String(box.width)}px`;
    layer.img.style.height = `${String(box.height)}px`;
    // Exactly the width it's shown at, so a portrait never downloads the
    // width a landscape needs.
    const sizes = `${String(Math.ceil(Math.min(box.width, widestDevicePixels / devicePixelRatio)))}px`;
    for (const el of [layer.avif, layer.webp, layer.img]) el?.setAttribute('sizes', sizes);
  };

  const fill = (layer: Layer, photo: ExhibitionPhoto): Promise<boolean> => {
    if (layer.photo?.id === photo.id) return layer.ready;
    layer.photo = photo;
    for (const animation of layer.motion.getAnimations()) animation.cancel();
    layer.root.style.opacity = '0';
    layer.motion.style.transform = '';
    // A fresh element, inserted empty (so it fetches nothing until every
    // attribute below is set): no earlier photograph to paint, or to decode.
    const img = document.createElement('img');
    img.decoding = 'async';
    layer.img.replaceWith(img);
    layer.img = img;
    for (const [el, value] of [
      [layer.avif, photo.avif],
      [layer.webp, photo.webp],
    ] as const) {
      if (el === undefined) continue;
      if (value === null) el.removeAttribute('srcset');
      else el.srcset = value;
    }
    size(layer);
    if (photo.jpeg === null) layer.img.removeAttribute('srcset');
    else layer.img.srcset = photo.jpeg;
    layer.img.width = photo.width;
    layer.img.height = photo.height;
    layer.img.alt = photo.alt;
    layer.img.style.backgroundColor = photo.color;
    layer.img.src = photo.src;
    const label = labelOf(photo, formatDate);
    layer.label.replaceChildren(
      ...label.flatMap((part, index) => {
        const span = document.createElement('span');
        span.textContent = part;
        if (photo.date !== null && index === label.length - 1) span.className = 'dateline';
        return index === 0 ? [span] : [document.createTextNode(' · '), span];
      }),
    );
    layer.ready = Promise.race([
      layer.img.decode().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((done) => setTimeout(() => done(false), LOAD_TIMEOUT_MS)),
    ]).then((ok) => {
      // Decoded and painted with no background: the colour only covered the
      // wait, and must not show around a photograph with transparent edges.
      if (ok && layer.photo?.id === photo.id) layer.img.style.backgroundColor = '';
      return ok;
    });
    return layer.ready;
  };

  // --- Playing -----------------------------------------------------------------

  let playlist = new Playlist(
    photos.map((photo) => photo.weight),
    settings.order,
  );
  let front = first;
  let back = second;
  let playing = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let slideStarted = 0;
  let remaining = 0;
  /** Bumped on every step, so a load that finishes after the visitor has moved on is ignored. */
  let step = 0;
  let failures = 0;

  const moving = (): boolean => settings.motion && !reducedMotion.matches;

  const startMotion = (layer: Layer, fadeSeconds: number): void => {
    if (!moving()) return;
    const path = drift();
    layer.motion.style.transformOrigin = `${String(path.x)}% ${String(path.y)}%`;
    layer.motion.animate(
      [{ transform: `scale(${String(path.from)})` }, { transform: `scale(${String(path.to)})` }],
      {
        // Through the fade in, the hold, and the fade out: always moving
        // while it's seen, never starting or stopping on screen.
        duration: (settings.slide + fadeSeconds * 2) * 1000,
        easing: 'linear',
        fill: 'forwards',
      },
    );
    if (!playing) pauseAnimations();
  };

  // Only the drift pauses. A fade left frozen part-way would hold two
  // photographs on the wall until something else moved it.
  const pauseAnimations = (): void => {
    for (const layer of layers)
      for (const animation of layer.motion.getAnimations()) animation.pause();
  };
  const resumeAnimations = (): void => {
    for (const layer of layers) {
      for (const animation of layer.motion.getAnimations()) {
        if (animation.playState === 'paused') animation.play();
      }
    }
  };

  // --- Fades: every opacity change on the wall goes through here ---------------------

  /** The fades still running. Finished ones leave their end opacity inline and are gone. */
  let fades: Animation[] = [];
  const conclude = (animation: Animation): void => {
    animation.commitStyles();
    animation.cancel();
    fades = fades.filter((other) => other !== animation);
  };
  const fade = (
    layer: Layer,
    keyframes: Keyframe[],
    options: { duration: number; easing: string; delay?: number },
  ): void => {
    const animation = layer.root.animate(keyframes, { ...options, fill: 'forwards' });
    fades.push(animation);
    // The promise, not the 'finish' event: it settles first, so anything
    // awaiting the fade (preloadNext) already sees it concluded.
    animation.finished.then(
      () => {
        if (fades.includes(animation)) conclude(animation);
      },
      () => {},
    );
  };
  /** A transition still running ends now, at its end: one photograph on the wall, the other layer dark. */
  const settle = (): void => {
    for (const animation of fades) {
      animation.finish();
      conclude(animation);
    }
  };

  /** Same aspect ratio within 2%: the two fill the same box, so a crossfade shows no edges. */
  const sameFrame = (a: ExhibitionPhoto | null, b: ExhibitionPhoto | null): boolean =>
    a !== null && b !== null && Math.abs((a.width / a.height) * (b.height / b.width) - 1) < 0.02;

  const reveal = (incoming: Layer, fadeSeconds: number): void => {
    const outgoing = front;
    const ms = fadeSeconds * 1000;
    incoming.root.style.zIndex = '2';
    outgoing.root.style.zIndex = '1';
    if (outgoing === incoming) {
      // Already on the wall (a one-photograph exhibition): nothing to change.
      if (incoming.root.style.opacity !== '1') {
        fade(incoming, [{ opacity: 0 }, { opacity: 1 }], {
          duration: Math.max(ms, 1200),
          easing: 'ease-out',
        });
      }
    } else if (outgoing.photo === null) {
      fade(incoming, [{ opacity: 0 }, { opacity: 1 }], {
        duration: Math.max(ms, 1200),
        easing: 'ease-out',
      });
    } else if (sameFrame(outgoing.photo, incoming.photo)) {
      // The outgoing photograph holds until halfway, so where the two
      // overlap the blend never dips toward the wall.
      fade(incoming, [{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: 'ease-in-out' });
      fade(outgoing, [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], {
        duration: ms,
        easing: 'ease-in',
      });
    } else {
      // Different frames: one leaves before the other arrives, so a
      // landscape's edges never show beside a portrait (or a 3:2 around a
      // square). The total time matches the crossfade's.
      fade(outgoing, [{ opacity: 1 }, { opacity: 0 }], { duration: ms * 0.45, easing: 'ease-in' });
      fade(incoming, [{ opacity: 0 }, { opacity: 1 }], {
        duration: ms * 0.55,
        delay: ms * 0.45,
        easing: 'ease-out',
      });
    }
    startMotion(incoming, fadeSeconds);
    if (outgoing !== incoming) {
      front = incoming;
      back = outgoing;
    }
    root
      .querySelector('[data-position]')
      ?.replaceChildren(`${String(playlist.position)} / ${String(playlist.length)}`);
  };

  const schedule = (delay: number): void => {
    clearTimeout(timer);
    timer = undefined;
    if (photos.length < 2) return;
    slideStarted = performance.now();
    remaining = delay;
    if (playing) timer = setTimeout(advance, delay);
  };

  /** Show playlist.current: load it into the back layer, then bring it forward. */
  const present = async (fadeSeconds: number, announce: boolean): Promise<void> => {
    step += 1;
    const mine = step;
    // Whatever was mid-transition lands now, so the back layer is dark
    // before it's refilled and only one photograph waits on the wall.
    settle();
    const photo = photos[playlist.current];
    if (photo === undefined) return;
    const target = front.photo?.id === photo.id ? front : back;
    const ok = await fill(target, photo);
    if (mine !== step) return;
    if (!ok) {
      // A photograph that won't load is skipped, not waited on forever — and
      // if none will, the exhibition stops on whatever it last showed.
      failures += 1;
      if (failures < photos.length) {
        playlist.next();
        void present(fadeSeconds, announce);
      }
      return;
    }
    failures = 0;
    reveal(target, fadeSeconds);
    if (announce) {
      const live = root.querySelector('[data-announce]');
      if (live !== null) {
        live.textContent = `${photo.alt || 'Photograph'}, ${String(playlist.position)} of ${String(playlist.length)}`;
      }
    }
    schedule((settings.slide + fadeSeconds) * 1000);
    preloadNext(mine);
  };

  /** The next photograph loads behind this one as soon as the last one has finished leaving. */
  const preloadNext = (mine: number): void => {
    const upcoming = photos[playlist.peek()];
    if (upcoming === undefined || photos.length < 2) return;
    const leaving = back;
    void Promise.allSettled(fades.map((animation) => animation.finished)).then(() => {
      if (mine === step && leaving === back && fades.length === 0) void fill(back, upcoming);
    });
  };

  function advance(): void {
    playlist.next();
    void present(settings.fade, false);
  }

  const goTo = (direction: 'next' | 'previous'): void => {
    if (direction === 'next') playlist.next();
    else playlist.previous();
    void present(Math.min(settings.fade, MANUAL_FADE_S), true);
  };

  // --- Wake lock, pause, visibility ---------------------------------------------

  let wakeLock: WakeLockSentinel | null = null;
  const keepAwake = async (on: boolean): Promise<void> => {
    try {
      if (on && wakeLock === null && 'wakeLock' in navigator && !document.hidden) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      } else if (!on && wakeLock !== null) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch {
      // Not allowed here (no user gesture yet, battery saver): the screen may sleep.
    }
  };

  const playButton = root.querySelector<HTMLButtonElement>('[data-play]');
  const setPlaying = (value: boolean): void => {
    if (value === playing) return;
    playing = value;
    root.dataset['paused'] = String(!playing);
    if (playButton !== null) playButton.textContent = playing ? 'Pause' : 'Play';
    if (playing) {
      resumeAnimations();
      if (photos.length > 1) {
        slideStarted = performance.now();
        timer = setTimeout(advance, remaining);
      }
    } else {
      clearTimeout(timer);
      timer = undefined;
      remaining = Math.max(0, remaining - (performance.now() - slideStarted));
      pauseAnimations();
    }
    void keepAwake(playing);
  };

  // A hidden tab neither advances nor downloads; it picks up where it was.
  let pausedByVisibility = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && playing) {
      pausedByVisibility = true;
      setPlaying(false);
    } else if (!document.hidden && pausedByVisibility) {
      pausedByVisibility = false;
      setPlaying(true);
    }
  });

  // --- Controls: shown on any input, gone after a moment of stillness --------------

  const settingsPanel = root.querySelector<HTMLElement>('[data-settings]');
  const settingsToggle = root.querySelector<HTMLButtonElement>('[data-settings-toggle]');
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const pointerOverChrome = (): boolean =>
    root.querySelector('[data-chrome]:hover, [data-settings]:hover') !== null;
  const idle = (): void => {
    if (settingsPanel?.hidden === false || pointerOverChrome()) return;
    if (root.querySelector('[data-chrome] :focus-visible') !== null) return;
    root.dataset['idle'] = 'true';
  };
  const wake = (): void => {
    delete root.dataset['idle'];
    clearTimeout(idleTimer);
    idleTimer = setTimeout(idle, IDLE_MS);
  };
  root.addEventListener('pointermove', (event) => {
    // A touch's synthetic moves aren't someone reaching for the controls.
    if (event.pointerType === 'mouse') wake();
  });
  root.addEventListener('focusin', wake);
  wake();

  // Touch: a tap shows or hides the controls; a horizontal swipe steps.
  let touchStart: { x: number; y: number } | null = null;
  stage.addEventListener('pointerdown', (event) => {
    touchStart = { x: event.clientX, y: event.clientY };
  });
  stage.addEventListener('pointerup', (event) => {
    if (touchStart === null) return;
    const dx = event.clientX - touchStart.x;
    const dy = event.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
      goTo(dx < 0 ? 'next' : 'previous');
      wake();
      return;
    }
    if (settingsPanel?.hidden === false) {
      closeSettings();
      return;
    }
    if (root.dataset['idle'] === 'true' || event.pointerType === 'mouse') wake();
    else {
      clearTimeout(idleTimer);
      root.dataset['idle'] = 'true';
    }
  });
  stage.addEventListener('pointercancel', () => {
    touchStart = null;
  });

  playButton?.addEventListener('click', () => {
    setPlaying(!playing);
  });
  root.querySelector('[data-next]')?.addEventListener('click', () => {
    goTo('next');
  });
  root.querySelector('[data-previous]')?.addEventListener('click', () => {
    goTo('previous');
  });

  // --- Full screen ------------------------------------------------------------------

  // iPhone Safari has no full-screen mode for pages (only for video); the
  // page already fills the viewport, so the button simply isn't offered.
  const fullscreenButton = root.querySelector<HTMLButtonElement>('[data-fullscreen]');
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement !== null) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  };
  if (fullscreenButton !== null && document.fullscreenEnabled) {
    fullscreenButton.hidden = false;
    fullscreenButton.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', () => {
      fullscreenButton.textContent =
        document.fullscreenElement === null ? 'Full screen' : 'Exit full screen';
    });
  }

  // --- Settings -----------------------------------------------------------------------

  const infoButton = root.querySelector<HTMLButtonElement>('[data-info]');
  const reflect = (): void => {
    root.dataset['info'] = String(settings.info);
    infoButton?.setAttribute('aria-pressed', String(settings.info));
    if (settingsPanel === null) return;
    const values: Record<string, string> = {
      slide: String(settings.slide),
      fade: String(settings.fade),
      order: settings.order,
      motion: moving() ? '1' : '0',
    };
    for (const input of settingsPanel.querySelectorAll<HTMLInputElement>('input[type=radio]')) {
      input.checked = values[input.name] === input.value;
      if (input.name === 'motion') input.disabled = reducedMotion.matches;
    }
    const note = settingsPanel.querySelector<HTMLElement>('[data-reduced-note]');
    if (note !== null) note.hidden = !reducedMotion.matches;
  };

  const update = (change: Partial<Settings>): void => {
    const previous = settings;
    settings = { ...settings, ...change };
    savePreferences(settings);
    const url = new URL(location.href);
    writeSettings(url, settings, naturalOrder);
    history.replaceState(null, '', url);
    reflect();

    if (settings.order !== previous.order) {
      // Carry on from the photograph on the wall, in the new order.
      const current = playlist.current;
      playlist = new Playlist(
        photos.map((photo) => photo.weight),
        settings.order,
      );
      playlist.seek(current);
      preloadNext(step);
    }
    if (settings.slide !== previous.slide && timer !== undefined) {
      const elapsed = performance.now() - slideStarted;
      schedule(Math.max(0, (settings.slide + settings.fade) * 1000 - elapsed));
    }
    if (settings.motion !== previous.motion) restartMotion();
  };

  /** Motion switched on or off mid-photograph: the one on the wall follows at once. */
  const restartMotion = (): void => {
    for (const animation of front.motion.getAnimations()) animation.cancel();
    front.motion.style.transform = '';
    startMotion(front, 0);
  };

  const openSettings = (): void => {
    if (settingsPanel === null) return;
    settingsPanel.hidden = false;
    settingsToggle?.setAttribute('aria-expanded', 'true');
    settingsPanel.querySelector<HTMLInputElement>('input:checked')?.focus();
    wake();
  };
  function closeSettings(): void {
    if (settingsPanel === null || settingsPanel.hidden) return;
    settingsPanel.hidden = true;
    settingsToggle?.setAttribute('aria-expanded', 'false');
    settingsToggle?.focus();
    wake();
  }
  settingsToggle?.addEventListener('click', () => {
    if (settingsPanel?.hidden === false) closeSettings();
    else openSettings();
  });
  settingsPanel?.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.name === 'slide' || input.name === 'fade')
      update({ [input.name]: Number(input.value) });
    else if (input.name === 'order')
      update({ order: input.value === 'shuffle' ? 'shuffle' : 'sequence' });
    else if (input.name === 'motion') update({ motion: input.value === '1' });
  });
  infoButton?.addEventListener('click', () => {
    update({ info: !settings.info });
  });
  reducedMotion.addEventListener('change', () => {
    reflect();
    restartMotion();
  });

  // --- Keyboard -------------------------------------------------------------------------

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    wake();
    const target = event.target;
    const inControl =
      target instanceof HTMLButtonElement ||
      target instanceof HTMLAnchorElement ||
      target instanceof HTMLInputElement;
    if (event.key === 'Escape') {
      if (settingsPanel?.hidden === false) closeSettings();
      else if (document.fullscreenElement === null) location.href = returnHref(source);
      return;
    }
    // Inside the settings panel, arrows move between choices.
    if (target instanceof HTMLInputElement) return;
    if (event.key === 'ArrowRight') goTo('next');
    else if (event.key === 'ArrowLeft') goTo('previous');
    else if ((event.key === ' ' && !inControl) || event.key === 'k' || event.key === 'K') {
      setPlaying(!playing);
    } else if (event.key === 'f' || event.key === 'F') {
      if (document.fullscreenEnabled) toggleFullscreen();
    } else if (event.key === 'i' || event.key === 'I') {
      update({ info: !settings.info });
    } else return;
    event.preventDefault();
  });

  // --- Size ---------------------------------------------------------------------------------

  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      size(front);
      size(back);
    });
  });

  // Browsers grant a wake lock only after a gesture: ask now, and again on the first one.
  void keepAwake(true);
  root.addEventListener(
    'pointerdown',
    () => {
      void keepAwake(playing);
    },
    { once: true },
  );
  window.addEventListener(
    'keydown',
    () => {
      void keepAwake(playing);
    },
    { once: true },
  );
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void keepAwake(playing);
  });

  root.dataset['paused'] = 'false';
  reflect();
  void present(settings.fade, false);
}

const root = document.querySelector<HTMLElement>('[data-exhibition]');
const payload = document.querySelector('[data-exhibition-photos]');
if (root !== null && payload?.textContent) {
  start(root, JSON.parse(payload.textContent) as ExhibitionData);
}

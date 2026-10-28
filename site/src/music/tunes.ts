/**
 * The Tunes page's progressive enhancement over plain links: a thumbnail
 * that steps down when YouTube has no full-size still for a video, and the
 * screening room — a full-screen viewer the clicked still expands into
 * (a View Transition where the browser has them), lit by colours read from
 * that still (palette.ts). The viewer creates its iframe on open and on
 * every step between songs, and throws it away on close, which is also
 * what stops playback.
 */
import { FALLBACK_AMBIENT, ambientPalette } from './palette.ts';

// maxresdefault (the server-rendered src) is missing for some uploads.
// YouTube answers with a 120×90 grey placeholder, sometimes with a 404 and
// sometimes not, so both the error and a too-small load count as missing.
// hq720 is 16:9; sddefault and hqdefault are 4:3 with the video letterboxed
// inside, and object-fit: cover in a 16:9 box crops exactly those bars.
// hqdefault exists for every video.
const FALLBACKS = ['hq720', 'sddefault', 'hqdefault'];
const PLACEHOLDER_WIDTH = 120;

function watchThumbnail(img: HTMLImageElement): void {
  const videoId = img.dataset['videoId'];
  if (videoId === undefined) return;
  let step = 0;
  const fallBack = (): void => {
    const next = FALLBACKS[step];
    if (next === undefined) return;
    step += 1;
    img.src = `https://i.ytimg.com/vi/${videoId}/${next}.jpg`;
  };
  const check = (): void => {
    if (img.naturalWidth <= PLACEHOLDER_WIDTH) fallBack();
  };
  img.addEventListener('load', check);
  img.addEventListener('error', fallBack);
  // An eager thumbnail can finish before this module runs.
  if (img.complete) {
    if (img.naturalWidth === 0) fallBack();
    else check();
  }
}

document.querySelectorAll<HTMLImageElement>('[data-tune-thumb]').forEach(watchThumbnail);

interface Tune {
  readonly link: HTMLAnchorElement;
  readonly still: HTMLElement | null;
  readonly thumb: HTMLImageElement | null;
  readonly platform: string;
  readonly embed: string;
  readonly title: string;
  readonly artist: string;
  readonly videoId: string | null;
}

const tunes: Tune[] = [...document.querySelectorAll<HTMLAnchorElement>('[data-tune-open]')].map(
  (link) => {
    const thumb = link.querySelector<HTMLImageElement>('[data-tune-thumb]');
    return {
      link,
      still: link.querySelector<HTMLElement>('.tune-still'),
      thumb,
      platform: link.dataset['platform'] ?? 'youtube',
      embed: link.dataset['embed'] ?? '',
      title: link.dataset['title'] ?? '',
      artist: link.dataset['artist'] ?? '',
      videoId: thumb?.dataset['videoId'] ?? null,
    };
  },
);

const viewer = document.querySelector<HTMLElement>('[data-tune-viewer]');
const page = document.querySelector<HTMLElement>('.wrap');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Whatever the browser has decoded within this long goes into the
// transition; anything slower arrives a moment later on its own (the
// ambient colours fade in, the poster is the grid's cached image anyway).
const TRANSITION_WAIT_MS = 250;

function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

/**
 * Three ambient colours from the video's 320×180 still. i.ytimg.com sends
 * `Access-Control-Allow-Origin: *`, so a CORS-mode image can be read back
 * from a canvas; anything that goes wrong (a tainted canvas, a failed
 * load) quietly gets the warm fallback. Never the iframe — its pixels are
 * YouTube's, not readable, and not ours to read. Cached per video.
 */
const palettes = new Map<string, Promise<readonly string[]>>();
function paletteFor(videoId: string | null): Promise<readonly string[]> {
  if (videoId === null) return Promise.resolve(FALLBACK_AMBIENT);
  const cached = palettes.get(videoId);
  if (cached !== undefined) return cached;
  const palette = new Promise<readonly string[]>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.addEventListener('load', () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 18;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (context === null) throw new Error('no 2d context');
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(ambientPalette(context.getImageData(0, 0, canvas.width, canvas.height).data));
      } catch {
        resolve(FALLBACK_AMBIENT);
      }
    });
    img.addEventListener('error', () => resolve(FALLBACK_AMBIENT));
    img.src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  });
  palettes.set(videoId, palette);
  return palette;
}

/**
 * Whether YouTube will play this video anywhere but youtube.com. Its oEmbed
 * endpoint answers CORS requests and refuses (401/403) a video whose owner
 * has turned embedding off, and 400s or 404s one that's private or gone — one small
 * request per video, instead of loading the IFrame Player API on every
 * visit just to hear the same thing from its onError. Any other failure
 * counts as playable: the iframe then shows YouTube's own message, and the
 * viewer's YouTube link is always there. Cached per video.
 */
const embeddable = new Map<string, Promise<boolean>>();
function isEmbeddable(tune: Tune): Promise<boolean> {
  if (tune.platform !== 'youtube') return Promise.resolve(true);
  const cached = embeddable.get(tune.link.href);
  if (cached !== undefined) return cached;
  const check = fetch(
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(tune.link.href)}`,
  )
    .then((response) => ![400, 401, 403, 404].includes(response.status))
    .catch(() => true);
  embeddable.set(tune.link.href, check);
  return check;
}

const screen = viewer?.querySelector<HTMLElement>('[data-tune-screen]');
const poster = viewer?.querySelector<HTMLImageElement>('[data-tune-poster]');
const blocked = viewer?.querySelector<HTMLElement>('[data-tune-blocked]');
const blockedLink = viewer?.querySelector<HTMLAnchorElement>('[data-tune-blocked-link]');
const titleEl = viewer?.querySelector<HTMLElement>('[data-tune-title]');
const artistEl = viewer?.querySelector<HTMLElement>('[data-tune-artist]');
const external = viewer?.querySelector<HTMLAnchorElement>('[data-tune-external]');

if (
  viewer &&
  page &&
  screen &&
  poster &&
  blocked &&
  blockedLink &&
  titleEl &&
  artistEl &&
  external &&
  tunes.length > 0
) {
  // Out of .wrap, so .wrap can go inert behind it without taking it along.
  document.body.append(viewer);

  let current = -1;
  let opener: HTMLAnchorElement | null = null;
  let savedScroll = 0;

  const animated = (): boolean =>
    typeof document.startViewTransition === 'function' && !reducedMotion.matches;

  const applyPalette = (colors: readonly string[]): void => {
    colors.forEach((color, i) => {
      viewer.style.setProperty(`--ambient-${String(i + 1)}`, color);
    });
  };

  const removePlayer = (): void => {
    screen.querySelector('iframe')?.remove();
  };

  const startPlayer = (tune: Tune): void => {
    removePlayer();
    const src = new URL(tune.embed);
    if (tune.platform === 'youtube') {
      // Opened by a click (or a step), so autoplay is allowed; rel=0 keeps
      // the end screen to this channel's videos; playsinline stops iOS from
      // jumping straight to its own fullscreen player.
      src.searchParams.set('autoplay', '1');
      src.searchParams.set('rel', '0');
      src.searchParams.set('playsinline', '1');
    }
    const iframe = document.createElement('iframe');
    iframe.src = src.href;
    iframe.title = tune.artist ? `${tune.title} — ${tune.artist}` : tune.title;
    iframe.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
    iframe.allowFullscreen = true;
    // YouTube refuses to play some embeds without a Referer.
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    // Faded in over the poster once YouTube's page has loaded, so the
    // still holds the screen instead of a black rectangle.
    iframe.addEventListener('load', () => iframe.classList.add('is-loaded'), { once: true });
    screen.append(iframe);
  };

  /** Fills the viewer for one song. Resolves once its poster and colours are in hand, or soon after. */
  const show = async (index: number): Promise<void> => {
    const tune = tunes[index];
    if (tune === undefined) return;
    current = index;

    titleEl.textContent = tune.title;
    artistEl.textContent = tune.artist;
    const where = tune.platform === 'spotify' ? 'Spotify' : 'YouTube';
    external.href = tune.link.href;
    external.textContent = `${where} ↗`;
    blockedLink.href = tune.link.href;
    blocked.hidden = true;
    screen.dataset['platform'] = tune.platform;

    // The grid's own image, so whichever fallback size it settled on is
    // the one that expands, already in the cache.
    poster.src = tune.thumb?.currentSrc || tune.thumb?.src || '';
    poster.hidden = tune.thumb === null;

    startPlayer(tune);
    void isEmbeddable(tune).then((ok) => {
      if (ok || current !== index) return;
      removePlayer();
      blocked.hidden = false;
    });

    const palette = paletteFor(tune.videoId);
    void palette.then((colors) => {
      if (current === index) applyPalette(colors);
    });
    await within(
      Promise.all([poster.decode().catch(() => undefined), palette]),
      TRANSITION_WAIT_MS,
    );

    // The neighbours' colours, so a step lands already lit.
    const before = tunes[(index - 1 + tunes.length) % tunes.length];
    const after = tunes[(index + 1) % tunes.length];
    void paletteFor(before?.videoId ?? null);
    void paletteFor(after?.videoId ?? null);
  };

  const open = async (index: number): Promise<void> => {
    const tune = tunes[index];
    if (tune === undefined) return;
    opener = tune.link;
    savedScroll = window.scrollY;

    const enter = async (): Promise<void> => {
      if (tune.still) tune.still.style.viewTransitionName = '';
      await show(index);
      viewer.hidden = false;
      page.inert = true;
      document.documentElement.classList.add('tune-viewing');
    };

    if (animated() && tune.still) {
      // The still is the shared element: it grows into the screen, whose
      // poster is the same picture, so nothing changes but its size.
      tune.still.style.viewTransitionName = 'tune-screen';
      await document.startViewTransition(enter).updateCallbackDone;
    } else {
      await enter();
    }
    viewer.querySelector<HTMLElement>('[data-tune-close]')?.focus({ preventScroll: true });
  };

  const close = (): void => {
    if (viewer.hidden) return;
    const target = tunes[current]?.still ?? null;

    const leave = (): void => {
      removePlayer();
      viewer.hidden = true;
      page.inert = false;
      document.documentElement.classList.remove('tune-viewing');
      window.scrollTo(0, savedScroll);
      // Shrink back into the song now playing, if it's on screen where the
      // visitor left the grid; otherwise the room just fades away.
      if (target !== null) {
        const box = target.getBoundingClientRect();
        if (box.bottom > 0 && box.top < window.innerHeight) {
          target.style.viewTransitionName = 'tune-screen';
        }
      }
      // Only once the page is no longer inert can it take focus back.
      opener?.focus({ preventScroll: true });
      opener = null;
    };

    if (animated()) {
      const transition = document.startViewTransition(leave);
      void transition.finished.finally(() => {
        if (target !== null) target.style.viewTransitionName = '';
      });
    } else {
      leave();
    }
  };

  const step = (offset: number): void => {
    const next = (current + offset + tunes.length) % tunes.length;
    if (animated()) {
      // Read by the ::view-transition rules in music.css, which hang off
      // <html>: the caption leaves the way the visitor is going.
      const root = document.documentElement;
      root.dataset['tuneStep'] = offset > 0 ? 'next' : 'previous';
      void document
        .startViewTransition(() => show(next))
        .finished.finally(() => delete root.dataset['tuneStep']);
    } else {
      void show(next);
    }
  };

  viewer.querySelector('[data-tune-close]')?.addEventListener('click', close);
  viewer.querySelectorAll<HTMLButtonElement>('[data-tune-step]').forEach((button) => {
    button.addEventListener('click', () => step(Number(button.dataset['tuneStep'])));
  });

  // Keys reach this only while focus is outside the player: inside it,
  // YouTube's own shortcuts (arrows seek) keep working.
  document.addEventListener('keydown', (event) => {
    if (viewer.hidden || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      step(event.key === 'ArrowRight' ? 1 : -1);
    }
  });

  tunes.forEach((tune, index) => {
    tune.link.addEventListener('click', (event) => {
      // A modified click still means "open the link", in a new tab or window.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      void open(index);
    });
  });
}

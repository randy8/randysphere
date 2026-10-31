/**
 * The Tunes page's progressive enhancement over plain links: a thumbnail
 * that steps down when YouTube has no full-size still for a video, and the
 * screening room — a full-screen viewer the clicked still expands into
 * (a View Transition where the browser has them), lit by colours read from
 * that still (palette.ts). The viewer creates its iframe on open and on
 * every step between songs, and throws it away on close, which is also
 * what stops playback. With Autoplay on, the list plays as a radio: the
 * YouTube player says when a song has ended (its postMessage channel —
 * the same one the IFrame Player API wraps, without loading that script)
 * and the next one is loaded into the same player.
 *
 * Browse while it plays: the room folds into a bar along the bottom (the
 * same elements, restyled — moving the player's iframe would reload it)
 * and every page of the site the visitor then opens is shown in a frame
 * above the bar, so this document, and the song, never unload. The address
 * bar and title follow the frame; Back walks the frame's pages, then
 * returns to Tunes. A refresh loads the page itself, without the music.
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
const autoplayButton = viewer?.querySelector<HTMLButtonElement>('[data-tune-autoplay]');
const autoplayState = viewer?.querySelector<HTMLElement>('[data-tune-autoplay-state]');
const playAll = document.querySelector<HTMLButtonElement>('[data-tune-play-all]');
const pauseButton = viewer?.querySelector<HTMLButtonElement>('[data-tune-pause]');
const pauseIcon = viewer?.querySelector<SVGElement>('[data-tune-pause-icon]');
const playIcon = viewer?.querySelector<SVGElement>('[data-tune-play-icon]');
const closeButton = viewer?.querySelector<HTMLButtonElement>('[data-tune-close]');

const YOUTUBE_ORIGIN = 'https://www.youtube.com';
const AUTOPLAY_KEY = 'tunes:autoplay';

/**
 * Pages that can't be shown in the frame: the chats, /private, /system and
 * /infra refuse to be framed at all (tools/serve's SECURITY_HEADERS), and a
 * full-size photograph is better opened on its own. Going to one leaves
 * Tunes, and the music stops.
 */
const UNFRAMED = ['/family', '/disc', '/private', '/system', '/infra', '/p/'];
function framable(url: URL): boolean {
  return (
    url.origin === window.location.origin &&
    !UNFRAMED.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
  );
}
const isTunes = (url: URL): boolean => url.pathname.startsWith('/tunes/');
const plainClick = (event: MouseEvent): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
/** The link a click landed on, from either document (so no instanceof). */
function linkOf(event: MouseEvent): HTMLAnchorElement | null {
  const target = event.target as Element | null;
  const link = typeof target?.closest === 'function' ? target.closest('a[href]') : null;
  return link as HTMLAnchorElement | null;
}

function storedAutoplay(): boolean {
  try {
    return localStorage.getItem(AUTOPLAY_KEY) === 'on';
  } catch {
    return false;
  }
}

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
  autoplayButton &&
  autoplayState &&
  pauseButton &&
  pauseIcon &&
  playIcon &&
  closeButton &&
  tunes.length > 0
) {
  const root = document.documentElement;
  // Out of .wrap, so .wrap can go inert behind it without taking it along.
  document.body.append(viewer);

  let current = -1;
  let opener: HTMLAnchorElement | null = null;
  let savedScroll = 0;
  let autoplay = storedAutoplay();
  // The YouTube player now on screen, once it has answered us: only then
  // can the next song be loaded into it rather than into a new iframe —
  // which matters on phones, where a new iframe started without a tap may
  // not be allowed to make a sound.
  let player: { readonly frame: HTMLIFrameElement; ready: boolean } | null = null;
  // The song whose end has already moved us on: the player reports an
  // ending more than once (a state change, then its periodic report).
  let ended = -1;
  // Songs skipped in a row because they can't play here; a whole list of
  // them stops the radio instead of going round forever.
  let skipped = 0;
  let skippedFrom = -1;
  // The room folded into the bar along the bottom, music still playing.
  let docked = false;
  // As the player last said; drives the bar's pause button.
  let playing = false;
  // The rest of the site, shown above the bar (created on first use), and
  // whether it's on screen now rather than the Tunes list.
  let site: HTMLIFrameElement | null = null;
  let browsing = false;
  let listScroll = 0;
  let syncTimer = 0;
  const tunesTitle = document.title;

  const renderAutoplay = (): void => {
    autoplayButton.setAttribute('aria-pressed', String(autoplay));
    autoplayState.textContent = autoplay ? 'on' : 'off';
  };
  const setAutoplay = (on: boolean): void => {
    autoplay = on;
    renderAutoplay();
    try {
      localStorage.setItem(AUTOPLAY_KEY, on ? 'on' : 'off');
    } catch {
      // Storage off: the setting lasts this visit.
    }
  };
  renderAutoplay();

  const animated = (): boolean =>
    typeof document.startViewTransition === 'function' && !reducedMotion.matches;

  const applyPalette = (colors: readonly string[]): void => {
    colors.forEach((color, i) => {
      viewer.style.setProperty(`--ambient-${String(i + 1)}`, color);
    });
  };

  const renderPause = (): void => {
    // Only a YouTube player can be told to pause; a Spotify embed has its own button.
    pauseButton.hidden = player === null;
    pauseButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    pauseIcon.toggleAttribute('hidden', !playing);
    playIcon.toggleAttribute('hidden', playing);
  };

  const removePlayer = (): void => {
    screen.querySelector('iframe')?.remove();
    player = null;
    playing = false;
    renderPause();
  };

  const command = (func: string, args: readonly unknown[] = []): void => {
    player?.frame.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' }),
      YOUTUBE_ORIGIN,
    );
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
      // Lets this page hear the player's state (for Autoplay); nothing else.
      src.searchParams.set('enablejsapi', '1');
      src.searchParams.set('origin', window.location.origin);
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
    iframe.addEventListener(
      'load',
      () => {
        iframe.classList.add('is-loaded');
        if (tune.platform !== 'youtube') return;
        // Ask the player to report to this page; it answers with
        // messages handled below, which is what marks it ready.
        iframe.contentWindow?.postMessage(
          JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }),
          YOUTUBE_ORIGIN,
        );
      },
      { once: true },
    );
    screen.append(iframe);
    player = tune.platform === 'youtube' ? { frame: iframe, ready: false } : null;
    playing = true;
    renderPause();
  };

  /** The next song into the player already playing, if there is one that can take it. */
  const continuePlayer = (tune: Tune): boolean => {
    if (tune.platform !== 'youtube' || tune.videoId === null) return false;
    if (player === null || !player.ready) return false;
    command('loadVideoById', [tune.videoId]);
    player.frame.title = tune.artist ? `${tune.title} — ${tune.artist}` : tune.title;
    return true;
  };

  /** Fills the viewer for one song. Resolves once its poster and colours are in hand, or soon after. */
  const show = async (index: number, continuing = false): Promise<void> => {
    const tune = tunes[index];
    if (tune === undefined) return;
    current = index;
    ended = -1;
    skippedFrom = -1;

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

    if (!continuing || !continuePlayer(tune)) startPlayer(tune);
    void isEmbeddable(tune).then((ok) => {
      if (current !== index) return;
      if (ok) {
        skipped = 0;
        return;
      }
      // The radio moves past it; a song the visitor chose is explained.
      if (autoplay && continuing && !viewer.hidden) {
        skipOver(index);
        return;
      }
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

  // The bar's height, which the Tunes list and the site's frame leave free.
  new ResizeObserver(() => {
    if (docked) root.style.setProperty('--tune-dock-space', `${String(viewer.offsetHeight)}px`);
  }).observe(viewer);

  /** The room as a full-screen dialog, or as the bar along the bottom. */
  const setDocked = (on: boolean): void => {
    docked = on;
    viewer.classList.toggle('is-docked', on);
    if (on) {
      viewer.setAttribute('role', 'region');
      viewer.setAttribute('aria-label', 'Now playing');
      viewer.removeAttribute('aria-modal');
      viewer.removeAttribute('aria-labelledby');
      root.style.setProperty('--tune-dock-space', `${String(viewer.offsetHeight)}px`);
    } else {
      viewer.setAttribute('role', 'dialog');
      viewer.setAttribute('aria-modal', 'true');
      viewer.setAttribute('aria-labelledby', 'tune-viewer-title');
      viewer.removeAttribute('aria-label');
      root.style.removeProperty('--tune-dock-space');
    }
    const modal = !on && !viewer.hidden;
    page.inert = modal;
    if (site) site.inert = modal;
    root.classList.toggle('tune-viewing', modal);
    root.classList.toggle('tune-docked', on);
  };

  const renderClose = (): void => {
    // Over the site, there's no Tunes list to go back to: closing just stops.
    closeButton.lastChild!.textContent = browsing ? ' Close' : ' Tunes';
    closeButton.setAttribute(
      'aria-label',
      browsing ? 'Stop and close the player' : 'Back to Tunes',
    );
  };

  const dock = (): void => {
    if (viewer.hidden || docked) return;
    const fold = (): void => {
      setDocked(true);
      if (!browsing) window.scrollTo(0, savedScroll);
    };
    if (animated()) document.startViewTransition(fold);
    else fold();
    (browsing ? site : opener)?.focus({ preventScroll: true });
  };

  const expand = (): void => {
    if (!docked) return;
    if (!browsing) savedScroll = window.scrollY;
    const unfold = (): void => setDocked(false);
    if (animated()) document.startViewTransition(unfold);
    else unfold();
    closeButton.focus({ preventScroll: true });
  };

  // ---- The site in a frame -------------------------------------------------

  /** The address bar and title follow the page in the frame. */
  const sync = (): void => {
    if (!browsing || site === null) return;
    try {
      const where = site.contentWindow!.location;
      const here = `${where.pathname}${where.search}${where.hash}`;
      if (here !== `${location.pathname}${location.search}${location.hash}`) {
        history.replaceState(history.state, '', here);
      }
      document.title = site.contentDocument?.title || tunesTitle;
    } catch {
      // Not readable (it can't be: only this site is framed); leave it be.
    }
  };

  const showSite = (): void => {
    if (site === null) return;
    browsing = true;
    listScroll = window.scrollY;
    site.hidden = false;
    root.classList.add('tune-browsing');
    syncTimer = window.setInterval(sync, 1000);
    renderClose();
  };

  const hideSite = (): void => {
    if (site === null || !browsing) return;
    browsing = false;
    site.hidden = true;
    root.classList.remove('tune-browsing');
    window.clearInterval(syncTimer);
    document.title = tunesTitle;
    window.scrollTo(0, listScroll);
    renderClose();
  };

  /** Clicks inside the framed page: off-site links open beside it, Tunes comes home. */
  const onSiteClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || !plainClick(event)) return;
    const link = linkOf(event);
    if (link === null || link.target === '_blank' || link.hasAttribute('download')) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin) {
      event.preventDefault();
      window.open(url.href, '_blank', 'noopener');
    } else if (isTunes(url)) {
      event.preventDefault();
      history.pushState(null, '', url.pathname);
      hideSite();
    } else if (!framable(url)) {
      // A page that won't be framed: go there, and the music stops.
      event.preventDefault();
      location.assign(url.href);
    }
  };

  const onSiteLoad = (): void => {
    if (site === null) return;
    let frameDocument: Document;
    let frameUrl: URL;
    try {
      frameDocument = site.contentDocument!;
      frameUrl = new URL(site.contentWindow!.location.href);
    } catch {
      return;
    }
    frameDocument.addEventListener('click', onSiteClick);
    if (!browsing) return;
    if (isTunes(frameUrl)) {
      // Tunes itself, reached some other way (a form, a redirect): this is it.
      history.replaceState(null, '', frameUrl.pathname);
      hideSite();
      return;
    }
    sync();
  };

  const browse = (href: string): void => {
    if (site === null) {
      site = document.createElement('iframe');
      site.className = 'tune-site';
      site.name = 'tune-site';
      site.title = 'The site, while the music plays';
      site.allow = 'fullscreen; clipboard-write; web-share';
      site.hidden = true;
      site.addEventListener('load', onSiteLoad);
      document.body.insertBefore(site, viewer);
      site.src = href;
    } else {
      // In place of whatever the frame last showed: the entry pushed below
      // is the one Back returns from.
      site.contentWindow?.location.replace(href);
    }
    history.pushState({ tuneSite: true }, '', href);
    showSite();
    site.focus({ preventScroll: true });
  };

  // Back past the first framed page shows Tunes again; Forward, the frame.
  window.addEventListener('popstate', (event) => {
    const wanted = (event.state as { tuneSite?: unknown } | null)?.tuneSite === true;
    if (wanted && !browsing && site !== null) {
      showSite();
      sync();
    } else if (!wanted && browsing) {
      hideSite();
    }
  });

  // From the Tunes list while the bar plays: a link to anywhere on the site
  // opens in the frame; off-site, beside it. Tunes' own links have already
  // been handled (and prevented) by the time this hears the click.
  document.addEventListener('click', (event) => {
    if (!docked || event.defaultPrevented || !plainClick(event)) return;
    const link = linkOf(event);
    if (link === null || viewer.contains(link) || link.target === '_blank') return;
    const url = new URL(link.href);
    if (url.origin !== location.origin) {
      event.preventDefault();
      window.open(url.href, '_blank', 'noopener');
    } else if (framable(url) && !isTunes(url)) {
      event.preventDefault();
      browse(url.href);
    }
  });

  const open = async (index: number): Promise<void> => {
    const tune = tunes[index];
    if (tune === undefined) return;
    opener = tune.link;
    savedScroll = window.scrollY;

    const enter = async (): Promise<void> => {
      if (tune.still) tune.still.style.viewTransitionName = '';
      await show(index);
      viewer.hidden = false;
      setDocked(false);
    };

    // From the bar, the screen is already on the page: no second one to grow from.
    if (animated() && tune.still && !docked) {
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
    // From the bar, the list stays where it's been scrolled; over the
    // site, there's no still on screen to shrink back into.
    if (docked) savedScroll = window.scrollY;
    const target = browsing ? null : (tunes[current]?.still ?? null);

    const leave = (): void => {
      removePlayer();
      viewer.hidden = true;
      setDocked(false);
      if (!browsing) window.scrollTo(0, savedScroll);
      // Shrink back into the song now playing, if it's on screen where the
      // visitor left the grid; otherwise the room just fades away.
      if (target !== null) {
        const box = target.getBoundingClientRect();
        if (box.bottom > 0 && box.top < window.innerHeight) {
          target.style.viewTransitionName = 'tune-screen';
        }
      }
      // Only once the page is no longer inert can it take focus back.
      (browsing ? site : opener)?.focus({ preventScroll: true });
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

  const step = (offset: number, continuing = false): void => {
    const next = (current + offset + tunes.length) % tunes.length;
    // A hidden tab (the radio playing behind another) gets no transition.
    if (animated() && !document.hidden) {
      // Read by the ::view-transition rules in music.css, which hang off
      // <html>: the caption leaves the way the visitor is going.
      const root = document.documentElement;
      root.dataset['tuneStep'] = offset > 0 ? 'next' : 'previous';
      void document
        .startViewTransition(() => show(next, continuing))
        .finished.finally(() => delete root.dataset['tuneStep']);
    } else {
      void show(next, continuing);
    }
  };

  /** Autoplay past a song that can't play here, unless none of them can. */
  const skipOver = (index: number): void => {
    // The oEmbed check and the player's own error can both report it.
    if (current !== index || skippedFrom === index) return;
    skippedFrom = index;
    skipped += 1;
    if (skipped >= tunes.length) {
      skipped = 0;
      blocked.hidden = false;
      return;
    }
    step(1, true);
  };

  // The YouTube player's reports. Only the player on screen is listened
  // to; the payload is JSON from YouTube, read defensively.
  window.addEventListener('message', (event) => {
    if (player === null || event.source !== player.frame.contentWindow) return;
    if (event.origin !== YOUTUBE_ORIGIN || typeof event.data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const { event: kind, info } = message as { event?: unknown; info?: unknown };
    if (!player.ready) {
      player.ready = true;
      command('addEventListener', ['onStateChange']);
      command('addEventListener', ['onError']);
    }
    const state =
      kind === 'onStateChange'
        ? info
        : kind === 'infoDelivery' && typeof info === 'object' && info !== null
          ? (info as { playerState?: unknown }).playerState
          : undefined;
    // 1 playing, 3 buffering; 2 paused, 0 ended. (-1 and 5, cued, say nothing new.)
    if (state === 1 || state === 3 || state === 2 || state === 0) {
      const now = state === 1 || state === 3;
      if (now !== playing) {
        playing = now;
        renderPause();
      }
    }
    if (!autoplay || viewer.hidden) return;
    // 0 is "ended". An error (embedding refused, video gone) skips ahead.
    if (state === 0 && ended !== current) {
      ended = current;
      skipped = 0;
      step(1, true);
    } else if (kind === 'onError') {
      skipOver(current);
    }
  });

  autoplayButton.addEventListener('click', () => setAutoplay(!autoplay));

  viewer.querySelector('[data-tune-dock]')?.addEventListener('click', dock);
  viewer.querySelector('[data-tune-expand]')?.addEventListener('click', expand);
  viewer.querySelector('[data-tune-stop]')?.addEventListener('click', close);
  pauseButton.addEventListener('click', () => {
    command(playing ? 'pauseVideo' : 'playVideo');
    // Shown at once; the player's own report follows and settles it.
    playing = !playing;
    renderPause();
  });
  renderPause();

  if (playAll) {
    playAll.hidden = false;
    playAll.addEventListener('click', () => {
      setAutoplay(true);
      skipped = 0;
      // From the top of the list as it's dealt on screen.
      void open(0);
    });
  }

  closeButton.addEventListener('click', close);
  viewer.querySelectorAll<HTMLButtonElement>('[data-tune-step]').forEach((button) => {
    button.addEventListener('click', () => step(Number(button.dataset['tuneStep'])));
  });

  // Keys reach this only while focus is outside the player: inside it,
  // YouTube's own shortcuts (arrows seek) keep working.
  document.addEventListener('keydown', (event) => {
    // In the bar, the keys belong to the page underneath.
    if (viewer.hidden || docked || event.defaultPrevented) return;
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
      if (!plainClick(event)) return;
      event.preventDefault();
      void open(index);
    });
  });
}

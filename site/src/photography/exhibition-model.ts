/**
 * The exhibition's decisions, kept apart from the DOM so they can be
 * tested: what to show (from the URL), in what order, for how long, and
 * at what size. exhibition.ts does the drawing.
 */

import type { LightboxPhoto } from './lightbox-data.ts';
import { resolveIds, sharedPrefixes } from './share-code.ts';
import { filmStockName } from './film-stocks.ts';

export interface ExhibitionPhoto extends LightboxPhoto {
  readonly tags: readonly string[];
  /** City names (albums/cities.yaml) the photograph is tagged with. */
  readonly places: readonly string[];
  /** YYYY-MM-DD, or null when neither the frame nor its roll carries a date. */
  readonly date: string | null;
}

export interface ExhibitionData {
  readonly photos: readonly ExhibitionPhoto[];
  /** Each tag's display title — the same one its own page uses. */
  readonly titles: Readonly<Record<string, string>>;
}

// --- What to show ----------------------------------------------------------

/**
 * Where the photographs come from, read from the URL in the vocabulary the
 * rest of Exposures already uses: `?tag=` (a trip, a place, a subject),
 * `?film=` (a stock, exactly as its page names it), both at once, or a
 * share code (`?p=`, or the original `?s=`) — a Saved or Shared selection,
 * in its sender's order. Nothing: all of Selected Work.
 */
export interface Source {
  readonly tag: string | null;
  readonly film: string | null;
  /** The share code's ids (prefixes), in order; empty when there's no code or it decodes to nothing. */
  readonly shared: readonly string[];
  /** The code exactly as given, to carry back to the Share page on close. */
  readonly code: string | null;
}

export function readSource(params: URLSearchParams): Source {
  const nonEmpty = (name: string): string | null => {
    const value = params.get(name);
    return value === null || value === '' ? null : value;
  };
  const shared = sharedPrefixes(params);
  const p = nonEmpty('p');
  const s = nonEmpty('s');
  return {
    tag: nonEmpty('tag'),
    film: nonEmpty('film'),
    shared,
    // A code that decodes to nothing (truncated, mangled) is still a share
    // link: it plays nothing, as the Share page shows nothing, never everything.
    code: p !== null ? `p=${p}` : s !== null ? `s=${s}` : null,
  };
}

export function selectPhotos(
  photos: readonly ExhibitionPhoto[],
  source: Source,
): ExhibitionPhoto[] {
  if (source.code !== null) {
    const byId = new Map(photos.map((photo) => [photo.id, photo]));
    return resolveIds(source.shared, byId.keys()).flatMap((id) => byId.get(id) ?? []);
  }
  return photos.filter(
    (photo) =>
      (source.tag === null || photo.tags.includes(source.tag)) &&
      (source.film === null || photo.filmStock === source.film),
  );
}

/** What the exhibition is called on screen, and in the tab. */
export function titleOf(source: Source, titles: Readonly<Record<string, string>>): string {
  if (source.code !== null) return 'Shared photographs';
  const parts = [
    source.tag === null ? null : (titles[source.tag] ?? source.tag),
    source.film === null ? null : filmStockName(source.film),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : 'Selected Work';
}

/** Where Close goes: the page this exhibition was opened from. */
export function returnHref(source: Source): string {
  if (source.code !== null) return `/exposures/share/?${source.code}`;
  if (source.tag !== null && source.film === null) {
    return `/exposures/${encodeURIComponent(source.tag)}/`;
  }
  if (source.film !== null && source.tag === null) {
    return `/exposures/film/${encodeURIComponent(source.film)}/`;
  }
  return '/exposures/';
}

// --- How it plays ------------------------------------------------------------

export type Order = 'sequence' | 'shuffle';

export interface Settings {
  /** Seconds each photograph holds, fades excluded. */
  readonly slide: number;
  /** Seconds each transition takes. */
  readonly fade: number;
  /** A slow drift (Ken Burns) within the photograph's margin; off under reduced motion. */
  readonly motion: boolean;
  /** The one-line wall label: film stock, place, date. */
  readonly info: boolean;
  readonly order: Order;
}

export const SLIDE_CHOICES = [5, 8, 12, 20, 30] as const;
export const FADE_CHOICES = [1, 2, 4] as const;

/** The settings a visitor's preferences can carry from one exhibition to the next. Order belongs to the source. */
export type Preferences = Partial<Omit<Settings, 'order'>>;

export const DEFAULTS: Omit<Settings, 'order'> = { slide: 8, fade: 1, motion: true, info: false };

/**
 * A shared selection plays in its sender's order; everything else
 * shuffles, as every photo page on the site opens in a random order.
 */
export function defaultOrder(source: Source): Order {
  return source.code !== null ? 'sequence' : 'shuffle';
}

const choice = <T extends number>(value: unknown, choices: readonly T[]): T | undefined =>
  choices.find((option) => option === Number(value));

const flag = (value: string | null): boolean | undefined =>
  value === '1' ? true : value === '0' ? false : undefined;

const bool = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/** URL first (a link plays as it was set up), then this visitor's preferences, then defaults. */
export function readSettings(
  params: URLSearchParams,
  preferences: Preferences,
  order: Order,
): Settings {
  const requested = params.get('order');
  return {
    slide:
      choice(params.get('slide'), SLIDE_CHOICES) ??
      choice(preferences.slide, SLIDE_CHOICES) ??
      DEFAULTS.slide,
    fade:
      choice(params.get('fade'), FADE_CHOICES) ??
      choice(preferences.fade, FADE_CHOICES) ??
      DEFAULTS.fade,
    motion: flag(params.get('motion')) ?? bool(preferences.motion) ?? DEFAULTS.motion,
    info: flag(params.get('info')) ?? bool(preferences.info) ?? DEFAULTS.info,
    order: requested === 'sequence' || requested === 'shuffle' ? requested : order,
  };
}

/** Writes the settings into the URL — only those that differ from the defaults, so a plain link stays plain. */
export function writeSettings(url: URL, settings: Settings, order: Order): void {
  const entries: [string, string | null][] = [
    ['slide', settings.slide === DEFAULTS.slide ? null : String(settings.slide)],
    ['fade', settings.fade === DEFAULTS.fade ? null : String(settings.fade)],
    ['motion', settings.motion === DEFAULTS.motion ? null : settings.motion ? '1' : '0'],
    ['info', settings.info === DEFAULTS.info ? null : settings.info ? '1' : '0'],
    ['order', settings.order === order ? null : settings.order],
  ];
  for (const [name, value] of entries) {
    if (value === null) url.searchParams.delete(name);
    else url.searchParams.set(name, value);
  }
}

/** Fisher–Yates; `random` is injectable for tests. */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

/**
 * The running order over `length` photographs. In sequence it simply
 * loops. Shuffled, every photograph is shown once before any repeats, and
 * a new round never opens on the photograph the last one closed with.
 * `peek` names the photograph after the current one without moving, so
 * it can load while the current one is on the wall.
 */
export class Playlist {
  #round: number[];
  #nextRound: number[] | null = null;
  #position = 0;
  readonly #shuffled: boolean;
  readonly #random: () => number;

  constructor(length: number, order: Order, random: () => number = Math.random) {
    this.#shuffled = order === 'shuffle';
    this.#random = random;
    this.#round = this.#deal(length, null);
  }

  get current(): number {
    return this.#round[this.#position] ?? 0;
  }

  get length(): number {
    return this.#round.length;
  }

  /** 1-based place in the current round, for "3 / 48". */
  get position(): number {
    return this.#position + 1;
  }

  peek(): number {
    if (this.#position + 1 < this.#round.length) return this.#round[this.#position + 1] ?? 0;
    this.#nextRound ??= this.#deal(this.#round.length, this.current);
    return this.#nextRound[0] ?? 0;
  }

  next(): number {
    if (this.#position + 1 < this.#round.length) {
      this.#position += 1;
    } else {
      this.#round = this.#nextRound ?? this.#deal(this.#round.length, this.current);
      this.#nextRound = null;
      this.#position = 0;
    }
    return this.current;
  }

  /** Moves to `index` (a photograph, not a position), wherever it falls in this round. */
  seek(index: number): void {
    const at = this.#round.indexOf(index);
    if (at === -1) return;
    this.#position = at;
    this.#nextRound = null;
  }

  previous(): number {
    this.#position = (this.#position - 1 + this.#round.length) % this.#round.length;
    return this.current;
  }

  #deal(length: number, avoidFirst: number | null): number[] {
    const indices = Array.from({ length }, (_, index) => index);
    if (!this.#shuffled) return indices;
    const round = shuffle(indices, this.#random);
    if (round.length > 1 && round[0] === avoidFirst) {
      [round[0], round[1]] = [round[1] as number, round[0]];
    }
    return round;
  }
}

// --- At what size ------------------------------------------------------------

/**
 * The largest box a `width`×`height` photograph fits inside `areaWidth`×
 * `areaHeight` without cropping — the whole frame, always.
 */
export function fitBox(
  width: number,
  height: number,
  areaWidth: number,
  areaHeight: number,
): { width: number; height: number } {
  const scale = Math.min(areaWidth / width, areaHeight / height);
  return { width: Math.floor(width * scale), height: Math.floor(height * scale) };
}

/**
 * A slide's slow drift: a scale of at most `MOTION_SCALE`, growing or
 * settling, about an origin near the middle. The photograph's margin is
 * wider than the most this can grow on any side, so motion never crops it.
 */
export const MOTION_SCALE = 1.03;

export interface Drift {
  readonly from: number;
  readonly to: number;
  /** transform-origin, in percent. */
  readonly x: number;
  readonly y: number;
}

export function drift(random: () => number = Math.random): Drift {
  const inward = random() < 0.5;
  const near = (): number => Math.round(30 + random() * 40);
  return {
    from: inward ? 1 : MOTION_SCALE,
    to: inward ? MOTION_SCALE : 1,
    x: near(),
    y: near(),
  };
}

/** The wall label's line: film stock, the first place, the date — whichever exist. */
export function labelOf(photo: ExhibitionPhoto, formatDate: (iso: string) => string): string[] {
  return [
    photo.filmStock === null || photo.filmStock === '' ? null : filmStockName(photo.filmStock),
    photo.places[0] ?? null,
    photo.date === null ? null : formatDate(photo.date),
  ].filter((part): part is string => part !== null && part !== '');
}

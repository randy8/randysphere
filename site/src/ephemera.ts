/**
 * Side projects: apps and ideas on this site that aren't collections and
 * don't earn a place in the masthead. Hand-written; this list is the whole
 * of it. A live entry is served by something other than the Astro build
 * (tools/serve), so this file only links to it; an idea has no link yet.
 */
export interface Ephemeron {
  readonly title: string;
  /** One or two words: what kind of thing it is (Game, Tool, Sketch…). */
  readonly kind: string;
  readonly description: string;
  /** Absent for an idea that isn't built yet. */
  readonly href?: string;
  /** A small drawing on the card (pages/ephemera/index.astro); absent for none. */
  readonly glyph?: 'board';
}

export const ephemera: readonly Ephemeron[] = [
  {
    title: 'Trivia',
    kind: 'Game',
    href: '/trivia/',
    glyph: 'board',
    description:
      'A television-style quiz for a living room. The board goes on the TV, phones become buzzers, and one person hosts. Play alone, practise one clue at a time, or write your own games.',
  },
];

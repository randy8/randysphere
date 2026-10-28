/**
 * Which browser tests a change needs, from the paths it touched. One
 * ordered table, read top to bottom, first match wins per path; the
 * change's risk is the highest of its paths', and its areas are the union.
 * Deliberately a table rather than an import graph: it can be read in a
 * minute, and every rule says why.
 *
 * What it never decides: the smoke suite (smoke.browser.ts, which includes
 * the security checks) runs on every deploy whatever this says. A path no
 * rule recognises is high risk and runs everything — unsure means broader.
 */

export type Risk = 'low' | 'medium' | 'high';
export const AREAS = ['gallery', 'lightbox', 'exhibition', 'share', 'pictures', 'dishes'] as const;
export type Area = (typeof AREAS)[number];

interface Rule {
  readonly match: RegExp;
  readonly risk: Risk;
  readonly areas: readonly Area[];
  readonly why: string;
}

const ALL = AREAS;

export const RULES: readonly Rule[] = [
  {
    match: /(^|\/)[^/]+\.md$|^docs\/|^LICENSE$|^\.claude\//,
    risk: 'low',
    areas: [],
    why: 'documentation',
  },
  {
    match: /^tools\/serve\//,
    risk: 'high',
    areas: ALL,
    why: 'the production server: routing, caching, the /private boundary',
  },
  { match: /^deploy\//, risk: 'high', areas: ALL, why: 'deployment and its services' },
  {
    match:
      /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|site\/package\.json|site\/astro\.config\.mjs|tsconfig[^/]*\.json|site\/tsconfig\.json|\.npmrc|\.node-version)$/,
    risk: 'high',
    areas: ALL,
    why: 'dependencies or build configuration: every page',
  },
  {
    match: /^tools\/qa\//,
    risk: 'medium',
    areas: ALL,
    why: 'the checks themselves changed: run them all',
  },
  {
    match:
      /^site\/src\/photography\/(exhibition[^/]*|exhibit-link\.ts)$|^site\/src\/pages\/exposures\/exhibition\//,
    risk: 'high',
    areas: ['exhibition'],
    why: 'the Exhibition transition lifecycle',
  },
  {
    match:
      /^site\/src\/photography\/(image|archive|manifest|config|lightbox-data|date|camera)\.ts$/,
    risk: 'high',
    areas: ALL,
    why: 'photograph data and URLs every photo page reads',
  },
  {
    match: /^site\/src\/photography\/(lightbox\.ts|swipe\.ts|zoom\.ts|Lightbox\.astro)$/,
    risk: 'medium',
    areas: ['lightbox'],
    why: 'the lightbox',
  },
  {
    match:
      /^site\/src\/photography\/(grid-layout\.js|GridLayout\.astro|Photo\.astro|shuffle-[^/]+|grid-save\.ts|selected-view\.ts)$/,
    risk: 'medium',
    areas: ['gallery', 'lightbox'],
    why: 'the photo grid (the lightbox opens from it)',
  },
  {
    match:
      /^site\/src\/photography\/(saved[^/]*|share[^/]*|SavedCart\.astro)$|^site\/src\/pages\/exposures\/(saved|share)\//,
    risk: 'medium',
    areas: ['share'],
    why: 'Saved and Share',
  },
  {
    match: /^site\/src\/(layouts|styles)\/|^site\/src\/collections\.ts$/,
    risk: 'medium',
    areas: ALL,
    why: 'layout or styles shared by every page',
  },
  {
    match: /^site\/src\/pages\/exposures\//,
    risk: 'medium',
    areas: ['gallery', 'lightbox'],
    why: 'a photo page',
  },
  {
    match: /^site\/src\/films\/|^site\/src\/pages\/pictures\/|^films\//,
    risk: 'medium',
    areas: ['pictures'],
    why: 'Pictures, the film log',
  },
  {
    match: /^site\/src\/recipes\/|^site\/src\/pages\/dishes\/|^recipes\/substitutions\//,
    risk: 'medium',
    areas: ['dishes'],
    why: 'Dishes: recipes, scaling, Make It Vegan',
  },
  {
    match: /^site\/src\/pages\/collections\//,
    risk: 'low',
    areas: [],
    why: 'the collections index (the smoke suite loads it)',
  },
  {
    match: /^(albums|generated\/albums|recipes)\//,
    risk: 'low',
    areas: [],
    why: 'content, not code',
  },
  {
    match: /^tools\/pipeline\//,
    risk: 'medium',
    areas: ['gallery'],
    why: 'the image pipeline (unit-tested; the gallery checks its output)',
  },
  { match: /^tools\/films\//, risk: 'low', areas: [], why: 'film lookups (unit-tested)' },
  {
    match:
      /^(\.prettierrc\.json|\.prettierignore|eslint\.config\.js|\.editorconfig|\.gitignore|\.gitattributes|\.githooks\/.*)$/,
    risk: 'low',
    areas: [],
    why: 'tooling configuration (pnpm check covers it)',
  },
];

export interface Classification {
  readonly risk: Risk;
  readonly areas: readonly Area[];
  /** One line per path: what it matched and why. */
  readonly reasons: readonly string[];
}

const ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export function classify(paths: readonly string[]): Classification {
  let risk: Risk = 'low';
  const areas = new Set<Area>();
  const reasons: string[] = [];
  for (const path of paths) {
    const rule = RULES.find((candidate) => candidate.match.test(path));
    const pathRisk = rule?.risk ?? 'high';
    const pathAreas = rule?.areas ?? ALL;
    if (ORDER[pathRisk] > ORDER[risk]) risk = pathRisk;
    for (const area of pathAreas) areas.add(area);
    reasons.push(
      `${pathRisk.padEnd(6)} ${path} — ${rule?.why ?? 'no rule recognises this path, so everything runs'}`,
    );
  }
  return { risk, areas: AREAS.filter((area) => areas.has(area)), reasons };
}

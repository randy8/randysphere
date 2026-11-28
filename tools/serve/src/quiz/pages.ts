/**
 * The quiz's HTML: one small shell per page, each loading the shared
 * stylesheet, the default theme and its own script. The scripts build the
 * interface; the server only says which page and which room. Everything
 * interpolated is escaped, and none of it comes from a request without
 * having matched a strict pattern first (quiz.ts).
 */

export type PageName =
  | 'home'
  | 'setup'
  | 'host'
  | 'play'
  | 'display'
  | 'join'
  | 'solosetup'
  | 'solo'
  | 'practice'
  | 'boards'
  | 'edit';

const TITLES: Record<PageName, string> = {
  home: 'Quiz',
  setup: 'Host a game · Quiz',
  host: 'Host · Quiz',
  play: 'Play · Quiz',
  display: 'Quiz',
  join: 'Join a game · Quiz',
  solosetup: 'Single player · Quiz',
  solo: 'Single player · Quiz',
  practice: 'Practice · Quiz',
  boards: 'Your games · Quiz',
  edit: 'Editor · Quiz',
};

/** Pages that are a full-screen surface rather than a document. */
const STAGE: ReadonlySet<PageName> = new Set(['display', 'play', 'solo']);

const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

export function renderPage(name: PageName, data: Record<string, string> = {}): string {
  const attributes = Object.entries({ page: name, ...data })
    .map(([key, value]) => ` data-${key}="${escape(value)}"`)
    .join('');
  const viewport =
    name === 'play' || name === 'solo'
      ? 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'
      : 'width=device-width, initial-scale=1, viewport-fit=cover';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="${viewport}">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#060ce9">
<title>${escape(TITLES[name])}</title>
<link rel="stylesheet" href="/trivia/static/quiz.css">
<link rel="stylesheet" href="/trivia/themes/classic/theme.css" id="theme-css">
<script type="module" src="/trivia/static/${name === 'solosetup' ? 'solo-setup' : name}.js"></script>
</head>
<body class="quiz quiz-${name}${STAGE.has(name) ? ' stage-page' : ''}"${attributes}>
<noscript><p class="noscript">This game runs in the browser and needs JavaScript.</p></noscript>
<main id="app"></main>
<footer class="fan-note">An unofficial, independent quiz game. Not affiliated with any television program.</footer>
</body>
</html>
`;
}

import type { Note } from './notes.ts';

/**
 * The private area's own tiny stylesheet — copied from the values in
 * site/src/styles/base.css (paper/ink/muted/rule/serif) rather than linked
 * to the public build's hashed CSS asset, which would be fragile to
 * reference from a process that never runs the Astro build itself. A small
 * duplication of design tokens is cheaper than that coupling.
 */
const STYLE = `
  :root {
    --paper: #f6f1e6; --ink: #16130f; --muted: #7c7364; --rule: #ddd3c0;
    --serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
    --sans: ui-sans-serif, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root { --paper: #0d0c09; --ink: #ece6d8; --muted: #948a76; --rule: #262219; }
  }
  * { box-sizing: border-box; }
  html { background: var(--paper); color-scheme: light dark; }
  body {
    margin: 0; background: var(--paper); color: var(--ink);
    font-family: var(--serif); line-height: 1.5;
  }
  main { max-width: 40rem; margin: 0 auto; padding: 4rem 1.5rem 6rem; }
  h1 { font-size: 1.75rem; font-weight: 500; margin: 0 0 1.5rem; }
  a { color: inherit; }
  form.gate { display: flex; gap: 0.6rem; }
  input[type='password'] {
    flex: 1; font: inherit; font-size: 1rem; padding: 0.6rem 0.75rem;
    border: 1px solid var(--rule); background: transparent; color: var(--ink);
    border-radius: 3px;
  }
  button {
    font: inherit; font-size: 0.95rem; padding: 0.6rem 1rem; cursor: pointer;
    border: 1px solid var(--ink); background: var(--ink); color: var(--paper);
    border-radius: 3px;
  }
  .error { color: #a3372f; margin: 0 0 1rem; font-size: 0.9rem; }
  .private-header {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 1rem; margin-bottom: 1.5rem;
  }
  .private-header form button, .quiet-button {
    background: none; color: var(--muted); border: none; font-size: 0.85rem;
    padding: 0; text-decoration: underline;
  }
  .private-filter {
    display: flex; gap: 1.25rem; margin: 0 0 2.5rem; padding: 0; list-style: none;
    font-family: var(--sans); font-size: 0.85rem; text-transform: uppercase;
    letter-spacing: 0.04em; color: var(--muted);
  }
  .private-filter a { text-decoration: none; border-bottom: 1px solid transparent; cursor: pointer; }
  .private-filter a.active { color: var(--ink); border-bottom-color: var(--ink); }
  .private-entries { list-style: none; margin: 0; padding: 0; }
  .private-entry { padding: 1.1rem 0; border-top: 1px solid var(--rule); }
  .private-entry:last-child { border-bottom: 1px solid var(--rule); }
  .private-entry time {
    display: block; font-family: var(--sans); font-size: 0.75rem;
    color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em;
    margin-bottom: 0.35rem;
  }
  .private-entry p { margin: 0; font-size: 1.05rem; }
  .private-entry img {
    display: block; max-width: 100%; height: auto; margin-top: 0.75rem;
    border-radius: 2px;
  }
  .private-empty { color: var(--muted); }
`;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

export function renderGate(wrongPassword: boolean): string {
  return shell(
    'Private',
    `
<h1>Private</h1>
${wrongPassword ? '<p class="error">Wrong password.</p>' : ''}
<form class="gate" method="POST" action="/private/login">
  <input type="password" name="password" autofocus autocomplete="current-password">
  <button type="submit">Enter</button>
</form>
`,
  );
}

function formatDate(date: string): string {
  // Left as-authored ("2026-08-08" or a full timestamp) rather than
  // reformatted — this is a private notebook for one reader who wrote the
  // dates themselves, not a public page that needs a polished date format.
  return date;
}

function renderEntry(note: Note): string {
  const photo = note.photo
    ? `<img src="/private/photos/${encodeURIComponent(note.photo)}" alt="" loading="lazy">`
    : '';
  return `<li class="private-entry" data-joy="${String(note.joy)}" data-photo="${String(note.photo !== null)}">
  <time>${escapeHtml(formatDate(note.date))}</time>
  <p>${escapeHtml(note.text)}</p>
  ${photo}
</li>`;
}

export function renderArchive(notes: readonly Note[]): string {
  const entries =
    notes.length > 0
      ? `<ul class="private-entries">${notes.map(renderEntry).join('\n')}</ul>`
      : '<p class="private-empty">Nothing here yet.</p>';

  return shell(
    'Private — Notes',
    `
<div class="private-header">
  <h1>Notes</h1>
  <form method="POST" action="/private/logout"><button type="submit" class="quiet-button">Log out</button></form>
</div>
<nav>
  <ul class="private-filter" data-private-filter>
    <li><a href="#" data-filter="all" class="active">All</a></li>
    <li><a href="#" data-filter="joy">Joys</a></li>
    <li><a href="#" data-filter="photo">Photos</a></li>
  </ul>
</nav>
${entries}
<script>
(function () {
  var nav = document.querySelector('[data-private-filter]');
  if (!nav) return;
  var links = nav.querySelectorAll('a');
  var items = document.querySelectorAll('.private-entry');
  nav.addEventListener('click', function (event) {
    var link = event.target.closest('a[data-filter]');
    if (!link) return;
    event.preventDefault();
    links.forEach(function (l) { l.classList.toggle('active', l === link); });
    var filter = link.dataset.filter;
    items.forEach(function (item) {
      var show = filter === 'all'
        || (filter === 'joy' && item.dataset.joy === 'true')
        || (filter === 'photo' && item.dataset.photo === 'true');
      item.style.display = show ? '' : 'none';
    });
  });
})();
</script>
`,
  );
}

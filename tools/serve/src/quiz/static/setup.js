// Host a game: choose what to play and how, then go to the host console.

import { api, el, loadTheme, storage } from './lib.js';

const app = document.getElementById('app');
await loadTheme('classic');

let library = { episodes: [], themes: ['classic'] };
try {
  library = await api('/quiz/api/library');
} catch {
  // Shown below as an empty library.
}

/** Boards this browser has written (boards.js keeps the list). */
function myBoards() {
  try {
    return JSON.parse(storage.get('quiz:boards') ?? '[]');
  } catch {
    return [];
  }
}

const error = el('p', { class: 'panel-error', role: 'alert' });
const choice = el('fieldset', { class: 'choices' }, el('legend', {}, 'What to play'));
const radio = (value, label, detail, checked = false) =>
  el(
    'label',
    { class: 'choice' },
    el('input', { type: 'radio', name: 'source', value, checked }),
    el('span', {}, el('strong', {}, label), detail ? el('small', {}, detail) : null),
  );

choice.append(
  radio('random', 'A random board', 'Six complete categories per round from the library', true),
);
const query = el('input', {
  type: 'text',
  name: 'query',
  placeholder: 'Prefer categories containing… (optional)',
  maxlength: 60,
});
choice.append(el('div', { class: 'indent' }, query));
for (const episode of library.episodes) {
  const detail = [
    episode.airDate ? `aired ${episode.airDate}` : null,
    episode.credit,
    episode.source ? `source: ${episode.source}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  choice.append(radio(`episode:${episode.id}`, episode.title, detail));
}
for (const board of myBoards())
  choice.append(
    radio(
      `board:${board.id}:${board.key}`,
      board.title || 'Untitled game',
      'Written in this browser',
    ),
  );
choice.append(radio('link', 'A game from an editor link', 'Paste the link from the editor'));
const linkInput = el('input', { type: 'url', placeholder: 'https://…/quiz/edit/123#…' });
choice.append(el('div', { class: 'indent' }, linkInput));

const number = (name, label, value, min, max, step = 1) =>
  el(
    'label',
    { class: 'setting' },
    el('span', {}, label),
    el('input', { type: 'number', name, value, min, max, step }),
  );
const settings = el(
  'fieldset',
  { class: 'settings' },
  el('legend', {}, 'Rules'),
  number('maxPlayers', 'Contestants', 3, 1, 6),
  number('responseSeconds', 'Seconds to respond after ringing in', 5, 2, 60),
  number('buzzWindowSeconds', 'Seconds the buzzers stay open', 5, 2, 60),
  number('wagerResponseSeconds', 'Seconds to respond to a wager clue', 10, 3, 120),
  number('finalSeconds', 'Final-round thinking time, seconds', 30, 10, 180),
  number('lockoutMs', 'Early-press lockout, milliseconds', 250, 0, 1000, 10),
  number('roundMinutes', 'Round time limit, minutes (0 for none)', 0, 0, 60),
  el(
    'label',
    { class: 'setting' },
    el('span', {}, 'Sudden-death tiebreaker for a tie'),
    el('input', { type: 'checkbox', name: 'tiebreak', checked: true }),
  ),
  el(
    'label',
    { class: 'setting' },
    el('span', {}, 'Theme'),
    el(
      'select',
      { name: 'theme' },
      library.themes.map((name) => el('option', { value: name }, name)),
    ),
  ),
);

const form = el(
  'form',
  { class: 'doc setup' },
  el('h1', {}, 'Host a game'),
  choice,
  el('details', {}, el('summary', {}, 'Rules and timing'), settings),
  el('button', { type: 'submit', class: 'primary big' }, 'Create the game'),
  error,
);
app.append(form);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  const data = new FormData(form);
  const value = String(data.get('source') ?? 'random');
  let source = { type: 'random', query: query.value.trim() || null };
  if (value.startsWith('episode:')) source = { type: 'episode', id: Number(value.split(':')[1]) };
  if (value.startsWith('board:')) {
    const [, id, key] = value.split(':');
    source = { type: 'board', id: Number(id), key };
  }
  if (value === 'link') {
    const match = linkInput.value.match(/\/quiz\/edit\/(\d+)#([A-Za-z0-9_-]{20,})/);
    if (!match) {
      error.textContent = 'That doesn’t look like an editor link.';
      return;
    }
    source = { type: 'board', id: Number(match[1]), key: match[2] };
  }
  const get = (name) => Number(form.elements.namedItem(name).value);
  const body = {
    source,
    theme: form.elements.namedItem('theme').value,
    settings: {
      maxPlayers: get('maxPlayers'),
      responseSeconds: get('responseSeconds'),
      buzzWindowSeconds: get('buzzWindowSeconds'),
      wagerResponseSeconds: get('wagerResponseSeconds'),
      finalSeconds: get('finalSeconds'),
      lockoutMs: get('lockoutMs'),
      roundMinutes: get('roundMinutes'),
      tiebreak: form.elements.namedItem('tiebreak').checked,
    },
  };
  try {
    const created = await api('/quiz/api/rooms', { method: 'POST', body });
    location.href = created.url;
  } catch (failure) {
    error.textContent = failure.message;
  }
});

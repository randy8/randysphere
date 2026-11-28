// Single player: choose a game; the server hosts it.

import { api, el, loadTheme, storage } from './lib.js';

const app = document.getElementById('app');
await loadTheme('classic');
let library = { episodes: [] };
try {
  library = await api('/trivia/api/library');
} catch {
  // An empty list.
}
const select = el(
  'select',
  { name: 'source' },
  el('option', { value: 'random' }, 'A random board'),
  library.episodes.map((episode) => el('option', { value: String(episode.id) }, episode.title)),
);
const name = el('input', {
  name: 'name',
  maxlength: 24,
  value: storage.get('quiz:name') ?? '',
  placeholder: 'Your name',
});
const error = el('p', { class: 'panel-error' });
const form = el(
  'form',
  { class: 'doc' },
  el('h1', {}, 'Single player'),
  el(
    'p',
    {},
    'The computer reads each clue (if your browser can speak), opens the buzzer when it’s done, and judges what you type. You can always overrule it.',
  ),
  el('label', {}, 'Game', select),
  el('label', {}, 'Name', name),
  el('button', { type: 'submit', class: 'primary big' }, 'Play'),
  error,
);
app.append(form);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const source =
      select.value === 'random'
        ? { type: 'random' }
        : { type: 'episode', id: Number(select.value) };
    const created = await api('/trivia/api/solo', {
      method: 'POST',
      body: { source, name: name.value || 'Player' },
    });
    if (name.value) storage.set('quiz:name', name.value);
    location.href = created.url;
  } catch (failure) {
    error.textContent = failure.message;
  }
});

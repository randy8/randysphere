// Join a game: a code (prefilled from the QR link) and a name. The
// credential goes into this browser's storage so the phone can reconnect.

import { api, el, loadTheme, page, storage } from './lib.js';

const app = document.getElementById('app');
await loadTheme('classic');
const preset = page().code ?? '';

const code = el('input', {
  name: 'code',
  value: preset,
  maxlength: 4,
  autocapitalize: 'characters',
  autocomplete: 'off',
  spellcheck: 'false',
  required: true,
  pattern: '[A-Za-z]{4}',
  inputmode: 'text',
  class: 'code-input',
  'aria-label': 'Game code',
});
const name = el('input', {
  name: 'name',
  maxlength: 24,
  required: true,
  autocomplete: 'nickname',
  placeholder: 'Your name',
  'aria-label': 'Your name',
  value: storage.get('quiz:name') ?? '',
});
const error = el('p', { class: 'panel-error', role: 'alert' });
const rejoin = el('div');

function checkExisting() {
  const value = code.value.trim().toUpperCase();
  rejoin.replaceChildren();
  if (/^[A-Z]{4}$/.test(value) && storage.get(`quiz:${value}:player`)) {
    rejoin.append(
      el(
        'p',
        {},
        'This phone is already in that game. ',
        el('a', { href: `/trivia/play/${value}`, class: 'button primary' }, 'Rejoin'),
      ),
    );
  }
}
code.addEventListener('input', checkExisting);
checkExisting();

const form = el(
  'form',
  { class: 'doc join' },
  el('h1', {}, 'Join a game'),
  el('label', {}, 'Game code', code),
  el('label', {}, 'Name', name),
  el('button', { type: 'submit', class: 'primary big' }, 'Join'),
  error,
  rejoin,
);
app.append(form);
if (preset) name.focus();
else code.focus();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  const room = code.value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(room)) {
    error.textContent = 'The code is four letters.';
    return;
  }
  try {
    const joined = await api(`/trivia/api/rooms/${room}/join`, {
      method: 'POST',
      body: { name: name.value },
    });
    storage.set(`quiz:${room}:player`, joined.token);
    storage.set('quiz:name', name.value.trim());
    location.href = `/trivia/play/${room}`;
  } catch (failure) {
    error.textContent = failure.message;
  }
});

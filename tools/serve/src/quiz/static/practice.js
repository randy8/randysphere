// Practice: one clue at a time from the library, typed and checked.

import { api, el, loadTheme, money, put } from './lib.js';

const app = document.getElementById('app');
await loadTheme('classic');

const filter = el('input', {
  type: 'search',
  placeholder: 'Only categories containing… (optional)',
  maxlength: 60,
});
const card = el('div', { class: 'practice-card' });
const input = el('input', {
  type: 'text',
  maxlength: 200,
  placeholder: 'Your response',
  autocomplete: 'off',
  'aria-label': 'Your response',
});
const outcome = el('div', { class: 'practice-outcome', role: 'status' });
const tally = el('div', { class: 'fine' });
let clue = null;
let right = 0;
let seen = 0;

async function next() {
  put(outcome);
  input.value = '';
  try {
    clue = await api(
      `/trivia/api/practice${filter.value.trim() ? `?q=${encodeURIComponent(filter.value.trim())}` : ''}`,
    );
  } catch (error) {
    put(card, el('p', {}, error.message));
    return;
  }
  put(
    card,
    el('div', { class: 'practice-category category-type' }, clue.category),
    clue.note ? el('div', { class: 'practice-note' }, clue.note) : null,
    clue.value ? el('div', { class: 'practice-value value-type' }, money(clue.value)) : null,
    clue.media?.kind === 'image'
      ? el('img', { src: clue.media.url, alt: '', class: 'practice-media' })
      : null,
    el('div', { class: 'practice-text clue-type' }, clue.text),
  );
  input.focus();
}

async function check(event) {
  event.preventDefault();
  if (!clue) return;
  const result = await api('/trivia/api/practice/check', {
    method: 'POST',
    body: { id: clue.id, response: input.value },
  });
  seen += 1;
  if (result.correct) right += 1;
  put(
    outcome,
    el(
      'div',
      { class: result.correct ? 'right' : 'wrong' },
      result.correct ? 'Correct' : 'Not quite',
    ),
    el('div', {}, 'Response: ', el('strong', {}, result.response)),
    result.accept.length
      ? el('div', { class: 'fine' }, `Also accepted: ${result.accept.join(' · ')}`)
      : null,
    !result.correct
      ? el(
          'button',
          {
            type: 'button',
            class: 'small',
            onclick: () => {
              right += 1;
              tally.textContent = `${right} of ${seen}`;
            },
          },
          'I was right',
        )
      : null,
    el('button', { type: 'button', class: 'primary', onclick: next }, 'Next clue'),
  );
  tally.textContent = `${right} of ${seen}`;
}

app.append(
  el(
    'div',
    { class: 'doc practice' },
    el('h1', {}, 'Practice'),
    el(
      'form',
      { class: 'row', onsubmit: (event) => (event.preventDefault(), next()) },
      filter,
      el('button', { type: 'submit' }, 'New clue'),
    ),
    card,
    el(
      'form',
      { class: 'row', onsubmit: check },
      input,
      el('button', { type: 'submit', class: 'primary' }, 'Check'),
    ),
    outcome,
    tally,
  ),
);
next();

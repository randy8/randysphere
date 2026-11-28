// Your games: the boards written in this browser (their edit links are
// kept here), a new one, or one imported from a file.

import { api, el, loadTheme, put, storage } from './lib.js';

const app = document.getElementById('app');
await loadTheme('classic');

export function readBoards() {
  try {
    return JSON.parse(storage.get('quiz:boards') ?? '[]');
  } catch {
    return [];
  }
}

function writeBoards(boards) {
  storage.set('quiz:boards', JSON.stringify(boards));
}

const error = el('p', { class: 'panel-error', role: 'alert' });
const list = el('ul', { class: 'board-list' });

function render() {
  const boards = readBoards();
  put(
    list,
    ...(boards.length === 0
      ? [el('li', { class: 'fine' }, 'No games yet in this browser.')]
      : boards.map((board) =>
          el(
            'li',
            {},
            el(
              'a',
              { href: `/quiz/edit/${board.id}#${board.key}` },
              board.title || 'Untitled game',
            ),
            ' ',
            el(
              'button',
              {
                type: 'button',
                class: 'small',
                onclick: () =>
                  confirm(
                    'Forget this game in this browser? (Its edit link still works if you saved it.)',
                  ) && (writeBoards(readBoards().filter((b) => b.id !== board.id)), render()),
              },
              'Forget',
            ),
          ),
        )),
  );
}

async function create(game) {
  error.textContent = '';
  try {
    const created = await api('/quiz/api/boards', { method: 'POST', body: game ? { game } : {} });
    writeBoards([{ id: created.id, key: created.key, title: game?.title ?? '' }, ...readBoards()]);
    location.href = created.url;
  } catch (failure) {
    error.textContent = failure.message;
  }
}

const file = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
file.addEventListener('change', async () => {
  const chosen = file.files?.[0];
  if (!chosen) return;
  try {
    const parsed = JSON.parse(await chosen.text());
    await create(parsed.games?.[0] ?? parsed);
  } catch (failure) {
    error.textContent = `Couldn’t read that file: ${failure.message}`;
  }
});

const linkInput = el('input', { type: 'url', placeholder: 'Paste an editor link to add it here' });

app.append(
  el(
    'div',
    { class: 'doc' },
    el('h1', {}, 'Your games'),
    el(
      'p',
      {},
      'A game you write belongs to its edit link — there are no accounts. Keep the link: anyone with it can edit or host the game, and without it nobody can. Games written here are private; they never appear in the public library.',
    ),
    list,
    el(
      'div',
      { class: 'row' },
      el('button', { type: 'button', class: 'primary', onclick: () => create(null) }, 'New game'),
      el('button', { type: 'button', onclick: () => file.click() }, 'Import a game file (.json)'),
      file,
    ),
    el(
      'form',
      {
        class: 'row',
        onsubmit: (event) => {
          event.preventDefault();
          const match = linkInput.value.match(/\/quiz\/edit\/(\d+)#([A-Za-z0-9_-]{20,})/);
          if (!match) {
            error.textContent = 'That doesn’t look like an editor link.';
            return;
          }
          location.href = `/quiz/edit/${match[1]}#${match[2]}`;
        },
      },
      linkInput,
      el('button', { type: 'submit' }, 'Open'),
    ),
    error,
    el(
      'p',
      { class: 'fine' },
      'The file format is documented in docs/quiz.md (“The game file”). CSV datasets are imported on the server with pnpm quiz import.',
    ),
  ),
);
render();

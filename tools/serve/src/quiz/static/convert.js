// Convert to a game: paste a text outline, a spreadsheet (copied cells or
// a CSV file) or a game file, see the game file it makes, then download it
// or open it in the editor. The server does the reading (importer.ts) and
// keeps nothing until "Open in the editor".

import { api, el, loadTheme, put, storage } from './lib.js';

const app = document.getElementById('app');
await loadTheme('classic');

const OUTLINE_EXAMPLE = `Title: Friday night
Credit: Written by me

# Round 1
## SPACE PROBES
note: Every answer is a NASA mission
Launched in 1977, this probe became the first human-made object to reach interstellar space
= Voyager 1 | Voyager
Sharing its name with a Greek god, this program put the first humans on the Moon
= Apollo | the Apollo program
[wager] This rover landed in Jezero Crater in 2021
= Perseverance
note: Accept "Percy"

## AMERICAN AUTHORS
Samuel Clemens wrote "Tom Sawyer" under this pen name
= Mark Twain
She wrote "To Kill a Mockingbird"
= Harper Lee

# Round 2
form: strict
## OCEANS
It's the only ocean named for a country
= the Indian Ocean | Indian

# Final
## WORLD LANDMARKS
Built for the 1889 World's Fair, it was meant to stand for only 20 years
= the Eiffel Tower | La Tour Eiffel

# Tiebreak
## RIVERS
It flows through Cairo
= the Nile
`;

const SHEET_EXAMPLE = `round,category,value,clue,response,accept
1,SPACE PROBES,200,"Launched in 1977, this probe reached interstellar space",Voyager 1,Voyager
1,SPACE PROBES,400,This program put the first humans on the Moon,Apollo,
2,OCEANS,400,It's the only ocean named for a country,the Indian Ocean,Indian
final,WORLD LANDMARKS,,Built for the 1889 World's Fair,the Eiffel Tower,
`;

const source = el('textarea', {
  rows: 18,
  spellcheck: 'false',
  class: 'convert-source',
  'aria-label': 'What to convert',
  placeholder: 'Paste an outline, spreadsheet cells or a game file here, or choose a file.',
});
const format = el(
  'select',
  { 'aria-label': 'Format' },
  el('option', { value: 'auto' }, 'Detect the format'),
  el('option', { value: 'outline' }, 'Text outline'),
  el('option', { value: 'csv' }, 'Spreadsheet (CSV, or cells copied from a sheet)'),
  el('option', { value: 'json' }, 'Game file (JSON)'),
);
const file = el('input', {
  type: 'file',
  accept: '.txt,.md,.csv,.tsv,.json,text/plain,text/csv,application/json',
  hidden: true,
});
const status = el('p', { class: 'convert-status', role: 'status' });
const error = el('p', { class: 'panel-error', role: 'alert' });
const results = el('div', { class: 'convert-results' });
let fileName = '';

function summary(game) {
  const boards = game.rounds.filter((round) => round.kind === 'board');
  const clues = boards
    .flatMap((round) => round.categories)
    .flatMap((category) => category.clues)
    .filter((clue) => clue && clue.text).length;
  const parts = [
    `${boards.length} ${boards.length === 1 ? 'round' : 'rounds'}`,
    `${clues} ${clues === 1 ? 'clue' : 'clues'}`,
  ];
  if (game.rounds.some((round) => round.kind === 'final')) parts.push('a final');
  const ties = game.tiebreakers?.length ?? 0;
  if (ties) parts.push(`${ties} ${ties === 1 ? 'tiebreaker' : 'tiebreakers'}`);
  return parts.join(', ');
}

function download(game) {
  const blob = new Blob([`${JSON.stringify(game, null, 2)}\n`], { type: 'application/json' });
  const link = el('a', {
    href: URL.createObjectURL(blob),
    download: `${(game.title || 'game').replace(/[^\w-]+/g, '-').toLowerCase()}.json`,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function openInEditor(game) {
  error.textContent = '';
  try {
    const created = await api('/trivia/api/boards', { method: 'POST', body: { game } });
    let boards = [];
    try {
      boards = JSON.parse(storage.get('quiz:boards') ?? '[]');
    } catch {
      boards = [];
    }
    storage.set(
      'quiz:boards',
      JSON.stringify([{ id: created.id, key: created.key, title: game.title ?? '' }, ...boards]),
    );
    location.href = created.url;
  } catch (failure) {
    error.textContent = failure.message;
  }
}

function show(result) {
  const named = { outline: 'a text outline', csv: 'a spreadsheet', json: 'a game file' };
  status.textContent = `Read as ${named[result.format] ?? result.format}.`;
  put(
    results,
    ...result.skipped.map((problem) => el('p', { class: 'panel-error' }, `Skipped ${problem}`)),
    ...result.games.map(({ file: game, playable }) =>
      el(
        'section',
        { class: 'convert-game' },
        el('h2', {}, game.title || 'Untitled game'),
        el('p', {}, summary(game)),
        el(
          'p',
          { class: playable ? 'convert-todo' : 'convert-ready' },
          playable ? `Not ready to host yet: ${playable}` : 'Ready to host.',
        ),
        el(
          'div',
          { class: 'row' },
          el(
            'button',
            { type: 'button', class: 'primary', onclick: () => openInEditor(game) },
            'Open in the editor',
          ),
          el('button', { type: 'button', onclick: () => download(game) }, 'Download .json'),
          el(
            'button',
            {
              type: 'button',
              onclick: async (event) => {
                await navigator.clipboard.writeText(JSON.stringify(game, null, 2));
                event.target.textContent = 'Copied';
              },
            },
            'Copy JSON',
          ),
        ),
        el(
          'details',
          {},
          el('summary', {}, 'The game file'),
          el('pre', { class: 'convert-json' }, JSON.stringify(game, null, 2)),
        ),
      ),
    ),
  );
}

let pending = 0;
async function convert() {
  const text = source.value;
  error.textContent = '';
  if (!text.trim()) {
    status.textContent = '';
    put(results);
    return;
  }
  const mine = ++pending;
  try {
    const result = await api('/trivia/api/convert', {
      method: 'POST',
      body: { text, name: fileName, format: format.value },
    });
    if (mine === pending) show(result);
  } catch (failure) {
    if (mine !== pending) return;
    status.textContent = '';
    put(results);
    error.textContent = failure.message;
  }
}

let timer = 0;
source.addEventListener('input', () => {
  fileName = '';
  clearTimeout(timer);
  timer = setTimeout(convert, 400);
});
format.addEventListener('change', convert);
file.addEventListener('change', async () => {
  const chosen = file.files?.[0];
  if (!chosen) return;
  fileName = chosen.name;
  source.value = await chosen.text();
  file.value = '';
  await convert();
});

const example = (label, text) =>
  el(
    'button',
    {
      type: 'button',
      onclick: () => {
        source.value = text;
        fileName = '';
        format.value = 'auto';
        void convert();
      },
    },
    label,
  );

app.append(
  el(
    'div',
    { class: 'doc convert' },
    el('p', {}, el('a', { href: '/trivia/edit/' }, '← Your games')),
    el('h1', {}, 'Convert to a game'),
    el(
      'p',
      {},
      'Write a game in a text file or a spreadsheet, then paste it here. You’ll see the game file it makes, and can open it in the editor to finish it or download it. Nothing is saved until you open it in the editor.',
    ),
    el(
      'div',
      { class: 'row' },
      el('button', { type: 'button', onclick: () => file.click() }, 'Choose a file'),
      example('Example outline', OUTLINE_EXAMPLE),
      example('Example spreadsheet', SHEET_EXAMPLE),
      format,
      file,
    ),
    source,
    status,
    error,
    results,
    el(
      'details',
      { class: 'convert-help' },
      el('summary', {}, 'How to write an outline'),
      el(
        'ul',
        {},
        el(
          'li',
          {},
          el('code', {}, '# Round 1'),
          ' starts a round. ',
          el('code', {}, '# Final'),
          ' and ',
          el('code', {}, '# Tiebreak'),
          ' start those.',
        ),
        el(
          'li',
          {},
          el('code', {}, '## CATEGORY'),
          ' starts a category. Its clues fill the rows from the top.',
        ),
        el(
          'li',
          {},
          'A clue is one or more lines of text, then a line starting ',
          el('code', {}, '='),
          ' with the response. Add alternatives after ',
          el('code', {}, '|'),
          '.',
        ),
        el('li', {}, 'Start a clue with ', el('code', {}, '[wager]'), ' to make it a wager clue.'),
        el(
          'li',
          {},
          el('code', {}, 'note:'),
          ' before a category’s first clue is a note read with the category. After a response, it’s a note only the host sees.',
        ),
        el(
          'li',
          {},
          'Under a round heading, ',
          el('code', {}, 'values: 200 400 600 800 1000'),
          ', ',
          el('code', {}, 'wagers: 2'),
          ' and ',
          el('code', {}, 'form: strict'),
          ' are optional. Without them, values run 200 to 1,000 in round 1 and double in round 2.',
        ),
        el(
          'li',
          {},
          el('code', {}, 'Title:'),
          ' and ',
          el('code', {}, 'Credit:'),
          ' go at the top. Lines starting ',
          el('code', {}, '//'),
          ' are ignored.',
        ),
      ),
    ),
    el(
      'details',
      { class: 'convert-help' },
      el('summary', {}, 'How to lay out a spreadsheet'),
      el(
        'p',
        {},
        'One clue per row, with a header row. Needed: ',
        el('code', {}, 'round'),
        ', ',
        el('code', {}, 'category'),
        ', ',
        el('code', {}, 'clue'),
        ' and ',
        el('code', {}, 'response'),
        '. Optional: ',
        el('code', {}, 'value'),
        ', ',
        el('code', {}, 'accept'),
        ' (alternatives separated by ',
        el('code', {}, '|'),
        '), ',
        el('code', {}, 'wager'),
        ' (yes), ',
        el('code', {}, 'notes'),
        ' and ',
        el('code', {}, 'category note'),
        '. Round is 1, 2, final or tiebreak. Copy the cells straight out of a sheet, or save it as CSV.',
      ),
    ),
  ),
);

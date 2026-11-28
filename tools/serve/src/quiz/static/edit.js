// The game editor. A game is the file format (docs/quiz.md): rounds of
// categories of clues, a final, tiebreakers. Edits save themselves (a
// draft may be incomplete); the bar says whether the game is ready to host
// and, if not, the first thing missing.

import { api, el, loadTheme, money, page, put, storage } from './lib.js';

const app = document.getElementById('app');
await loadTheme('classic');
const id = Number(page().board);

function rememberedKey() {
  try {
    return (
      JSON.parse(storage.get('quiz:boards') ?? '[]').find((board) => board.id === id)?.key ?? null
    );
  } catch {
    return null;
  }
}
let key = null;
const fragment = location.hash.slice(1);
if (/^[A-Za-z0-9_-]{20,}$/.test(fragment)) {
  key = fragment;
} else {
  key = rememberedKey();
}

function remember(title) {
  let boards;
  try {
    boards = JSON.parse(storage.get('quiz:boards') ?? '[]');
  } catch {
    boards = [];
  }
  const others = boards.filter((board) => board.id !== id);
  storage.set('quiz:boards', JSON.stringify([{ id, key, title }, ...others]));
}

const blankClue = () => ({
  text: '',
  response: '',
  accept: [],
  notes: '',
  media: null,
  wager: false,
});

let game = null;
let tab = 0;
let selected = { col: 0, row: 0 };
let saveTimer = null;
let saving = Promise.resolve();
const status = el('span', { class: 'edit-status' });
const ready = el('span', { class: 'edit-ready' });
const error = el('p', { class: 'panel-error', role: 'alert' });
const body = el('div', { class: 'edit-body' });

if (!key) {
  app.append(
    el(
      'div',
      { class: 'doc' },
      el('h1', {}, 'No edit key'),
      el('p', {}, 'Open this game with its full editor link (it ends in #…).'),
      el('a', { class: 'button', href: '/trivia/edit/' }, 'Your games'),
    ),
  );
} else {
  load();
}

async function load() {
  try {
    const loaded = await api(`/trivia/api/boards/${id}`, { headers: { 'x-edit-key': key } });
    game = loaded.game;
    remember(game.title);
    setReady(loaded.playable);
    build();
  } catch (failure) {
    put(
      app,
      el(
        'div',
        { class: 'doc' },
        el('h1', {}, 'Can’t open this game'),
        el('p', {}, failure.message),
      ),
    );
  }
}

function setReady(problem) {
  ready.textContent = problem ? `Not ready to host: ${problem}` : 'Ready to host';
  ready.className = `edit-ready ${problem ? 'no' : 'yes'}`;
}

function changed() {
  status.textContent = 'Unsaved changes…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 700);
}

function save() {
  clearTimeout(saveTimer);
  saving = saving.then(async () => {
    status.textContent = 'Saving…';
    try {
      const result = await api(`/trivia/api/boards/${id}`, {
        method: 'PUT',
        headers: { 'x-edit-key': key },
        body: game,
      });
      status.textContent = 'Saved';
      error.textContent = '';
      setReady(result.playable);
      remember(game.title);
    } catch (failure) {
      status.textContent = 'Not saved';
      error.textContent = failure.message;
    }
  });
  return saving;
}
window.addEventListener('beforeunload', (event) => {
  if (status.textContent === 'Unsaved changes…' || status.textContent === 'Saving…') {
    save();
    event.preventDefault();
  }
});

// ---- Shared bits --------------------------------------------------------------

const field = (label, input, hint) =>
  el(
    'label',
    { class: 'field' },
    el('span', { class: 'field-label' }, label),
    input,
    hint ? el('small', {}, hint) : null,
  );

function textInput(value, onInput, attributes = {}) {
  const input = el('input', { type: 'text', value: value ?? '', ...attributes });
  input.addEventListener('input', () => {
    onInput(input.value);
    changed();
  });
  return input;
}

function textArea(value, onInput, attributes = {}) {
  const input = el('textarea', { rows: 3, ...attributes });
  input.value = value ?? '';
  input.addEventListener('input', () => {
    onInput(input.value);
    changed();
  });
  return input;
}

/** The form for one clue (a board cell, the final, a tiebreaker). */
function clueForm(clue, { allowWager = false, onChange = () => undefined } = {}) {
  const media = clue.media ?? null;
  const mediaKind = el(
    'select',
    {},
    ['', 'image', 'audio', 'video'].map((kind) =>
      el('option', { value: kind, selected: (media?.kind ?? '') === kind }, kind || 'none'),
    ),
  );
  const mediaUrl = textInput(media?.url ?? '', () => undefined, {
    placeholder: 'https://… or /trivia/media/file.jpg',
  });
  const syncMedia = () => {
    clue.media =
      mediaKind.value && mediaUrl.value.trim()
        ? { kind: mediaKind.value, url: mediaUrl.value.trim() }
        : null;
    changed();
  };
  mediaKind.addEventListener('change', syncMedia);
  mediaUrl.addEventListener('input', syncMedia);
  const wager = el('input', { type: 'checkbox', checked: clue.wager === true });
  wager.addEventListener('change', () => {
    clue.wager = wager.checked;
    changed();
    onChange();
  });
  return el(
    'div',
    { class: 'clue-form' },
    field(
      'Clue (what the host reads)',
      textArea(clue.text, (value) => ((clue.text = value), onChange()), {
        rows: 4,
        maxlength: 1000,
        class: 'clue-input',
      }),
    ),
    field(
      'Correct response',
      textInput(clue.response, (value) => ((clue.response = value), onChange()), {
        maxlength: 300,
      }),
    ),
    field(
      'Also accept (one per line)',
      textArea(
        (clue.accept ?? []).join('\n'),
        (value) =>
          (clue.accept = value
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)),
        { rows: 2 },
      ),
    ),
    field(
      'Host notes (pronunciation, sources)',
      textArea(clue.notes, (value) => (clue.notes = value), { rows: 2, maxlength: 1000 }),
    ),
    el('div', { class: 'row' }, field('Media', mediaKind), field('Media address', mediaUrl)),
    allowWager
      ? el(
          'label',
          { class: 'check' },
          wager,
          ' Always a wager clue here (otherwise the game places them at random)',
        )
      : null,
  );
}

// ---- Layout -----------------------------------------------------------------------

function build() {
  const title = textInput(game.title, (value) => (game.title = value), {
    maxlength: 120,
    class: 'edit-title',
  });
  const credit = textInput(game.credit, (value) => (game.credit = value), {
    maxlength: 300,
    placeholder: 'Written by… (shown in the lobby)',
  });
  const actions = el(
    'div',
    { class: 'row' },
    el(
      'button',
      { type: 'button', class: 'primary', onclick: () => launch('/trivia/api/rooms') },
      'Host this game',
    ),
    el('button', { type: 'button', onclick: () => launch('/trivia/api/solo') }, 'Play it solo'),
    el('button', { type: 'button', onclick: exportFile }, 'Export'),
    el('button', { type: 'button', onclick: () => importInput.click() }, 'Import'),
    el('button', { type: 'button', onclick: copyLink }, 'Copy edit link'),
    el('button', { type: 'button', class: 'danger', onclick: remove }, 'Delete'),
  );
  const importInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
  importInput.addEventListener('change', async () => {
    const chosen = importInput.files?.[0];
    if (!chosen) return;
    try {
      const parsed = JSON.parse(await chosen.text());
      const next = parsed.games?.[0] ?? parsed;
      if (!Array.isArray(next.rounds)) throw new Error('not a game file');
      if (!confirm('Replace everything in this game with the file?')) return;
      game = {
        title: next.title ?? 'Imported game',
        credit: next.credit ?? '',
        rounds: next.rounds,
        tiebreakers: next.tiebreakers ?? [],
      };
      tab = 0;
      build();
      changed();
    } catch (failure) {
      error.textContent = `Couldn’t import: ${failure.message}`;
    }
  });
  put(
    app,
    el(
      'div',
      { class: 'editor' },
      el(
        'div',
        { class: 'edit-head' },
        el('a', { href: '/trivia/edit/' }, '← Your games'),
        status,
        ready,
      ),
      el('div', { class: 'edit-meta' }, field('Title', title), field('Credit', credit)),
      actions,
      importInput,
      error,
      tabs(),
      body,
    ),
  );
  renderTab();
}

function tabs() {
  const boards = game.rounds.filter((round) => round.kind === 'board');
  const names = [...boards.map((_, index) => `Round ${index + 1}`), 'Final', 'Tiebreakers'];
  return el(
    'div',
    { class: 'tabs', role: 'tablist' },
    names.map((name, index) =>
      el(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': String(index === tab),
          class: index === tab ? 'active' : '',
          onclick: () => ((tab = index), build()),
        },
        name,
      ),
    ),
    boards.length < 4
      ? el(
          'button',
          { type: 'button', class: 'small', onclick: addRound, title: 'Add another board round' },
          '+ round',
        )
      : null,
  );
}

function boardRounds() {
  return game.rounds.filter((round) => round.kind === 'board');
}

function finalRound() {
  let final = game.rounds.find((round) => round.kind === 'final');
  return final ?? null;
}

function addRound() {
  const count = boardRounds().length;
  const values = [200, 400, 600, 800, 1000].map((value) => value * 2 ** count);
  const round = {
    kind: 'board',
    values,
    wagers: 2,
    questionForm: 'strict',
    categories: Array.from({ length: 6 }, () => ({
      title: '',
      note: '',
      clues: values.map(() => null),
    })),
  };
  const finalIndex = game.rounds.findIndex((r) => r.kind === 'final');
  if (finalIndex === -1) game.rounds.push(round);
  else game.rounds.splice(finalIndex, 0, round);
  tab = count;
  build();
  changed();
}

function renderTab() {
  const boards = boardRounds();
  if (tab < boards.length) put(body, boardEditor(boards[tab], tab));
  else if (tab === boards.length) put(body, finalEditor());
  else put(body, tiebreakEditor());
}

// ---- A board round ---------------------------------------------------------------

function boardEditor(round, index) {
  const valuesInput = textInput(round.values.join(', '), (value) => {
    const values = value
      .split(/[,\s]+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    if (values.length === 0 || values.length > 10) return;
    for (const category of round.categories) {
      category.clues = values.map((_, row) => category.clues[row] ?? null);
    }
    round.values = values;
    drawGrid();
  });
  const wagers = el('input', { type: 'number', min: 0, max: 4, value: round.wagers ?? 1 });
  wagers.addEventListener('input', () => {
    round.wagers = Math.max(0, Math.min(4, Number(wagers.value) || 0));
    changed();
  });
  const form = el(
    'select',
    {},
    el(
      'option',
      { value: 'lenient', selected: round.questionForm === 'lenient' },
      'Lenient (a reminder, no penalty)',
    ),
    el(
      'option',
      { value: 'strict', selected: round.questionForm !== 'lenient' },
      'Strict (ruled incorrect)',
    ),
  );
  form.addEventListener('change', () => {
    round.questionForm = form.value;
    changed();
  });
  const grid = el('div', { class: 'edit-grid' });
  const side = el('div', { class: 'edit-side' });

  function drawGrid() {
    grid.style.gridTemplateColumns = `repeat(${round.categories.length}, minmax(9rem, 1fr))`;
    put(grid);
    round.categories.forEach((category, col) => {
      grid.append(
        el(
          'div',
          { class: 'edit-head-cell' },
          textInput(category.title, (value) => (category.title = value), {
            maxlength: 100,
            placeholder: `Category ${col + 1}`,
            class: 'edit-category category-type',
            'aria-label': `Category ${col + 1} title`,
          }),
          textInput(category.note ?? '', (value) => (category.note = value), {
            maxlength: 300,
            placeholder: 'Instructions (optional)',
            class: 'edit-note',
            'aria-label': `Category ${col + 1} instructions`,
          }),
        ),
      );
    });
    round.values.forEach((value, row) =>
      round.categories.forEach((category, col) => {
        const clue = category.clues[row];
        const filled = clue && (clue.text || clue.response);
        const incomplete = clue && (!clue.text || !clue.response);
        const isSelected = selected.col === col && selected.row === row;
        grid.append(
          el(
            'button',
            {
              type: 'button',
              class: `edit-cell${filled ? ' filled' : ''}${incomplete && filled ? ' incomplete' : ''}${isSelected ? ' selected' : ''}`,
              dataset: { col, row },
              onclick: () => select(col, row),
            },
            el('span', { class: 'edit-cell-value' }, money(value), clue?.wager ? ' ◆' : ''),
            el(
              'span',
              { class: 'edit-cell-text' },
              filled ? clue.text.slice(0, 80) || '(no clue text)' : 'empty',
            ),
          ),
        );
      }),
    );
  }

  function select(col, row) {
    selected = { col, row };
    drawGrid();
    drawSide();
    side.querySelector('textarea')?.focus();
  }

  function drawSide() {
    const category = round.categories[selected.col];
    if (!category || selected.row >= round.values.length) {
      put(side);
      return;
    }
    const existing = category.clues[selected.row];
    const clue = existing ?? blankClue();
    if (!existing) category.clues[selected.row] = clue;
    put(
      side,
      el(
        'h3',
        {},
        `${category.title || `Category ${selected.col + 1}`}, ${money(round.values[selected.row])}`,
      ),
      clueForm(clue, { allowWager: true, onChange: () => updateCell() }),
      el(
        'button',
        {
          type: 'button',
          class: 'small',
          onclick: () => {
            category.clues[selected.row] = null;
            changed();
            drawGrid();
            drawSide();
          },
        },
        'Clear this cell',
      ),
      el('p', { class: 'fine' }, 'Ctrl/⌘ + arrows move between cells.'),
    );
  }

  function updateCell() {
    const cell = grid.querySelector(
      `.edit-cell[data-col="${selected.col}"][data-row="${selected.row}"]`,
    );
    const clue = round.categories[selected.col]?.clues[selected.row];
    if (!cell || !clue) return;
    const filled = clue.text || clue.response;
    cell.classList.toggle('filled', Boolean(filled));
    cell.classList.toggle('incomplete', Boolean(filled) && (!clue.text || !clue.response));
    cell.querySelector('.edit-cell-text').textContent = filled
      ? clue.text.slice(0, 80) || '(no clue text)'
      : 'empty';
    cell.querySelector('.edit-cell-value').textContent =
      `${money(round.values[selected.row])}${clue.wager ? ' ◆' : ''}`;
  }

  const columns = el(
    'div',
    { class: 'row small' },
    el(
      'button',
      {
        type: 'button',
        disabled: round.categories.length >= 8,
        onclick: () => {
          round.categories.push({ title: '', note: '', clues: round.values.map(() => null) });
          changed();
          drawGrid();
        },
      },
      '+ category',
    ),
    el(
      'button',
      {
        type: 'button',
        disabled: round.categories.length <= 1,
        onclick: () => {
          if (confirm('Remove the last category and its clues?')) {
            round.categories.pop();
            selected.col = Math.min(selected.col, round.categories.length - 1);
            changed();
            drawGrid();
            drawSide();
          }
        },
      },
      '− category',
    ),
    boardRounds().length > 1
      ? el(
          'button',
          {
            type: 'button',
            class: 'danger',
            onclick: () => {
              if (confirm('Delete this whole round?')) {
                game.rounds.splice(game.rounds.indexOf(round), 1);
                tab = 0;
                changed();
                build();
              }
            },
          },
          'Delete round',
        )
      : null,
  );

  // Ctrl/Cmd + arrows: move between cells from anywhere in the editor.
  const onKey = (event) => {
    if (
      !(event.ctrlKey || event.metaKey) ||
      !event.key.startsWith('Arrow') ||
      !document.body.contains(grid)
    )
      return;
    event.preventDefault();
    const cols = round.categories.length;
    const rows = round.values.length;
    let { col, row } = selected;
    if (event.key === 'ArrowLeft') col = (col + cols - 1) % cols;
    if (event.key === 'ArrowRight') col = (col + 1) % cols;
    if (event.key === 'ArrowUp') row = (row + rows - 1) % rows;
    if (event.key === 'ArrowDown') row = (row + 1) % rows;
    select(col, row);
  };
  document.onkeydown = onKey;

  drawGrid();
  drawSide();
  return el(
    'div',
    {},
    el(
      'div',
      { class: 'edit-settings row' },
      field('Values, top to bottom', valuesInput),
      field(`Wager clues to place (if none is pinned)`, wagers),
      field('Question form', form),
    ),
    columns,
    el('div', { class: 'edit-split' }, el('div', { class: 'edit-grid-wrap' }, grid), side),
    el(
      'p',
      { class: 'fine' },
      `Round ${index + 1}. Leave a cell empty to leave it off the board. ◆ marks a pinned wager clue.`,
    ),
  );
}

// ---- Final and tiebreakers ------------------------------------------------------------

function finalEditor() {
  let final = finalRound();
  if (!final) {
    return el(
      'div',
      {},
      el('p', {}, 'This game has no final round.'),
      el(
        'button',
        {
          type: 'button',
          onclick: () => {
            game.rounds.push({ kind: 'final', category: '', note: '', clue: blankClue() });
            changed();
            build();
          },
        },
        'Add a final round',
      ),
    );
  }
  final.clue ??= blankClue();
  return el(
    'div',
    { class: 'edit-final' },
    field(
      'Category',
      textInput(final.category, (value) => (final.category = value), {
        maxlength: 100,
        class: 'category-type',
      }),
    ),
    field(
      'Instructions (optional)',
      textInput(final.note ?? '', (value) => (final.note = value), { maxlength: 300 }),
    ),
    clueForm(final.clue),
    el(
      'button',
      {
        type: 'button',
        class: 'danger small',
        onclick: () => {
          if (confirm('Remove the final round?')) {
            game.rounds = game.rounds.filter((round) => round.kind !== 'final');
            changed();
            build();
          }
        },
      },
      'Remove the final round',
    ),
  );
}

function tiebreakEditor() {
  game.tiebreakers ??= [];
  return el(
    'div',
    { class: 'edit-tiebreakers' },
    el(
      'p',
      { class: 'fine' },
      'Used only if the game ends in a tie for first: the tied contestants buzz in on one clue; the first right wins. Another follows if nobody gets it.',
    ),
    game.tiebreakers.map((tiebreaker, index) =>
      el(
        'fieldset',
        {},
        el('legend', {}, `Tiebreaker ${index + 1}`),
        field(
          'Category',
          textInput(tiebreaker.category, (value) => (tiebreaker.category = value), {
            maxlength: 100,
          }),
        ),
        clueForm((tiebreaker.clue ??= blankClue())),
        el(
          'button',
          {
            type: 'button',
            class: 'small',
            onclick: () => {
              game.tiebreakers.splice(index, 1);
              changed();
              renderTab();
            },
          },
          'Remove',
        ),
      ),
    ),
    game.tiebreakers.length < 5
      ? el(
          'button',
          {
            type: 'button',
            onclick: () => {
              game.tiebreakers.push({ category: '', clue: blankClue() });
              changed();
              renderTab();
            },
          },
          '+ tiebreaker',
        )
      : null,
  );
}

// ---- Actions ---------------------------------------------------------------------------

async function launch(endpoint) {
  await save();
  try {
    const created = await api(endpoint, {
      method: 'POST',
      body: { source: { type: 'board', id, key } },
    });
    location.href = created.url;
  } catch (failure) {
    error.textContent = failure.message;
  }
}

function exportFile() {
  const blob = new Blob([JSON.stringify({ format: 'quiz-game/1', ...game }, null, 2)], {
    type: 'application/json',
  });
  const link = el('a', {
    href: URL.createObjectURL(blob),
    download: `${(game.title || 'game').replace(/[^\w-]+/g, '-').toLowerCase()}.json`,
  });
  document.body.append(link);
  link.click();
  link.remove();
}

function copyLink() {
  const url = `${location.origin}/trivia/edit/${id}#${key}`;
  navigator.clipboard?.writeText(url).then(
    () => (status.textContent = 'Edit link copied'),
    () => prompt('Your edit link:', url),
  );
}

async function remove() {
  if (!confirm('Delete this game for good? This cannot be undone.')) return;
  await api(`/trivia/api/boards/${id}`, { method: 'DELETE', headers: { 'x-edit-key': key } });
  try {
    const boards = JSON.parse(storage.get('quiz:boards') ?? '[]').filter(
      (board) => board.id !== id,
    );
    storage.set('quiz:boards', JSON.stringify(boards));
  } catch {
    // Nothing kept.
  }
  location.href = '/trivia/edit/';
}

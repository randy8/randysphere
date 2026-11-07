// The importer's page: link → caption → review → saved. Plain browser
// JavaScript, no build step. Text from Instagram or the model only ever
// reaches the page through textContent and input values — never innerHTML.

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const STEPS = ['link', 'source', 'review', 'saved'];
const MAX_SHOTS = 4;
/** Claude's recommended long edge; larger images cost more and read no better. */
const SHOT_EDGE = 1568;

const state = {
  ytDlp: false,
  claude: false,
  url: '',
  /** The caption as Instagram gave it, to tell later whether the text is still that caption. */
  autoCaption: null,
  creatorName: '',
  shots: [],
  dirty: false,
};

// ---------------------------------------------------------------------------
// Plumbing

async function api(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      ok: false,
      message: 'The importer isn’t answering. Is `pnpm recipes:import` still running?',
    };
  }
  try {
    return await response.json();
  } catch {
    return { ok: false, message: `The importer answered with an error (${response.status}).` };
  }
}

function showStep(name) {
  const index = STEPS.indexOf(name);
  for (const section of $$('[data-step]')) section.hidden = section.dataset.step !== name;
  for (const marker of $$('[data-step-marker]')) {
    const at = STEPS.indexOf(marker.dataset.stepMarker);
    if (at === index) marker.setAttribute('aria-current', 'step');
    else marker.removeAttribute('aria-current');
    marker.toggleAttribute('data-done', at < index);
  }
  // What's installed matters while getting the caption, not while reviewing.
  const note = $('[data-status-note]');
  note.hidden = index > 1 || note.textContent.length === 0;
  window.scrollTo({ top: 0 });
}

function say(element, message) {
  element.textContent = message ?? '';
  element.hidden = !message;
}

function busy(button, progress, on) {
  button.disabled = on;
  if (progress) progress.hidden = !on;
}

// ---------------------------------------------------------------------------
// 1. Link

const linkForm = $('[data-link-form]');
const urlInput = $('[data-url]');
const linkError = $('[data-link-error]');

if (navigator.clipboard?.readText) {
  const paste = $('[data-paste]');
  paste.hidden = false;
  paste.addEventListener('click', async () => {
    try {
      urlInput.value = (await navigator.clipboard.readText()).trim();
      urlInput.focus();
    } catch {
      urlInput.focus();
    }
  });
}

linkForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  say(linkError, '');
  const submit = $('[data-link-submit]');
  busy(submit, null, true);
  const result = await api('/api/check', { url: urlInput.value });
  busy(submit, null, false);
  if (!result.ok) {
    say(linkError, result.message);
    return;
  }
  state.url = result.url;
  const link = $('[data-reel-link]');
  link.href = result.url;
  link.textContent = result.url.replace('https://www.', '');
  showStep('source');
  if (state.ytDlp) await readCaption();
  else captionFocus();
});

// ---------------------------------------------------------------------------
// 2. Caption

const captionInput = $('[data-caption]');
const creatorInput = $('[data-creator]');
const sourceError = $('[data-source-error]');
const captionNote = $('[data-caption-note]');

function captionFocus() {
  captionInput.focus({ preventScroll: true });
}

async function readCaption() {
  const progress = $('[data-caption-progress]');
  const submit = $('[data-draft-submit]');
  busy(submit, progress, true);
  const result = await api('/api/caption', { url: state.url });
  busy(submit, progress, false);
  submit.disabled = !state.claude;
  if (!result.ok) {
    say(captionNote, `${result.message} Paste the caption below, or add screenshots of it.`);
    captionFocus();
    return;
  }
  say(captionNote, '');
  captionInput.value = result.value.caption;
  state.autoCaption = result.value.caption;
  state.creatorName = result.value.creatorName;
  if (result.value.creator) creatorInput.value = result.value.creator;
  $('[data-caption-origin]').textContent = '— read from Instagram; trim or correct it if you like';
}

$('[data-shot-input]').addEventListener('change', async (event) => {
  const input = event.target;
  const files = [...input.files];
  input.value = '';
  say(sourceError, '');
  const room = MAX_SHOTS - state.shots.length;
  if (files.length > room)
    say(sourceError, `Up to ${MAX_SHOTS} screenshots — the rest were left out.`);
  for (const file of files.slice(0, Math.max(0, room))) {
    try {
      state.shots.push(await downscale(file));
    } catch {
      say(sourceError, `“${file.name}” couldn’t be read as an image.`);
    }
  }
  renderShots();
});

/** Re-encodes a screenshot as a JPEG no larger than SHOT_EDGE on its long side. */
async function downscale(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, SHOT_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), name: file.name };
}

function renderShots() {
  const list = $('[data-shots]');
  list.replaceChildren(
    ...state.shots.map((shot, index) => {
      const item = document.createElement('li');
      const image = document.createElement('img');
      image.src = shot.dataUrl;
      image.alt = `Screenshot ${index + 1}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove screenshot ${index + 1}`);
      remove.addEventListener('click', () => {
        state.shots.splice(index, 1);
        renderShots();
      });
      item.append(image, remove);
      return item;
    }),
  );
}

$('[data-source-form]').addEventListener('submit', async (event) => {
  event.preventDefault();
  say(sourceError, '');
  const text = captionInput.value.trim();
  if (!text && state.shots.length === 0) {
    say(sourceError, 'Paste the caption or add a screenshot first.');
    captionFocus();
    return;
  }
  const submit = $('[data-draft-submit]');
  const progress = $('[data-draft-progress]');
  busy(submit, progress, true);
  const result = await api('/api/draft', {
    url: state.url,
    text,
    textFromCaption: state.autoCaption !== null && text === state.autoCaption.trim(),
    creator: creatorInput.value.trim(),
    creatorName: state.creatorName,
    screenshots: state.shots.map((shot) => shot.dataUrl),
  });
  busy(submit, progress, false);
  if (!result.ok) {
    say(sourceError, result.message);
    return;
  }
  fillReview(result.value);
  showStep('review');
});

$('[data-by-hand]').addEventListener('click', () => {
  const hasText = captionInput.value.trim().length > 0;
  fillReview({
    title: '',
    description: '',
    prepTime: '',
    cookTime: '',
    totalTime: '',
    servings: '',
    ingredients: [{ amount: '', text: '', flag: '' }],
    optionalIngredients: [],
    instructions: [{ text: '', flag: '' }],
    notes: [],
    tags: [],
    warnings: [],
    source: {
      url: state.url,
      creator: creatorInput.value.trim().replace(/^@/, ''),
      creatorName: state.creatorName,
      via:
        hasText && captionInput.value.trim() === state.autoCaption?.trim() ? 'caption' : 'pasted',
    },
  });
  showStep('review');
});

$('[data-restart]').addEventListener('click', () => reset());

// ---------------------------------------------------------------------------
// 3. Review

const reviewForm = $('[data-review-form]');
const reviewError = $('[data-review-error]');
let reviewSource = null;

function lineFor(list, line) {
  const template = list === 'instructions' ? '#step-line' : '#ingredient-line';
  const item = $(template).content.firstElementChild.cloneNode(true);
  if (list !== 'instructions') $('.amount', item).value = line.amount ?? '';
  $('.text', item).value = line.text ?? '';
  setFlag(item, line.flag ?? '');
  $('[data-dismiss]', item).addEventListener('click', () => setFlag(item, ''));
  $('.remove', item).addEventListener('click', () => {
    item.remove();
    state.dirty = true;
  });
  return item;
}

function setFlag(item, flag) {
  item.dataset.flag = flag;
  item.toggleAttribute('data-flagged', flag.length > 0);
  $('.flag-text', item).textContent = flag;
  $('.flag', item).hidden = flag.length === 0;
}

function fillReview(draft) {
  reviewSource = draft.source;
  for (const name of ['title', 'description', 'prepTime', 'cookTime', 'totalTime', 'servings']) {
    reviewForm.elements[name].value = draft[name] ?? '';
  }
  reviewForm.elements.notes.value = (draft.notes ?? []).join('\n');
  reviewForm.elements.tags.value = (draft.tags ?? []).join(', ');
  for (const list of ['ingredients', 'optionalIngredients', 'instructions']) {
    $(`[data-lines="${list}"]`).replaceChildren(
      ...(draft[list] ?? []).map((line) => lineFor(list, line)),
    );
  }
  const warnings = $('[data-warnings]');
  warnings.replaceChildren(
    ...(draft.warnings ?? []).map((warning) => {
      const item = document.createElement('li');
      item.textContent = warning;
      return item;
    }),
  );
  warnings.hidden = (draft.warnings ?? []).length === 0;
  const credit = $('[data-credit]');
  credit.textContent = draft.source.creator
    ? `Credited to @${draft.source.creator}, with a link to the Reel.`
    : 'No creator handle — the recipe will link to the Reel without a name.';
  say(reviewError, '');
  state.dirty = true;
}

for (const button of $$('[data-add]')) {
  button.addEventListener('click', () => {
    const list = button.dataset.add;
    const item = lineFor(list, { amount: '', text: '', flag: '' });
    $(`[data-lines="${list}"]`).append(item);
    $(list === 'instructions' ? '.text' : '.amount', item).focus();
  });
}

function collectLines(list) {
  return $$(`[data-lines="${list}"] > li`)
    .map((item) => ({
      amount: list === 'instructions' ? undefined : $('.amount', item).value.trim(),
      text: $('.text', item).value.trim(),
      flag: item.dataset.flag ?? '',
    }))
    .filter((line) => line.text.length > 0);
}

function collectDraft() {
  const value = (name) => reviewForm.elements[name].value.trim();
  return {
    title: value('title'),
    description: value('description'),
    prepTime: value('prepTime'),
    cookTime: value('cookTime'),
    totalTime: value('totalTime'),
    servings: value('servings'),
    ingredients: collectLines('ingredients'),
    optionalIngredients: collectLines('optionalIngredients'),
    instructions: collectLines('instructions'),
    notes: value('notes')
      .split('\n')
      .map((note) => note.trim())
      .filter(Boolean),
    tags: value('tags')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
    source: reviewSource,
  };
}

reviewForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  say(reviewError, '');
  const draft = collectDraft();
  const missing = [
    !draft.title && 'a title',
    draft.ingredients.length === 0 && 'an ingredient',
    draft.instructions.length === 0 && 'a step',
  ].filter(Boolean);
  if (missing.length > 0) {
    say(reviewError, `Add ${missing.join(', ')} before saving.`);
    return;
  }
  const flagged = [
    ...draft.ingredients,
    ...draft.optionalIngredients,
    ...draft.instructions,
  ].filter((line) => line.flag).length;
  if (
    flagged > 0 &&
    !window.confirm(
      `${flagged} line${flagged === 1 ? ' is' : 's are'} still marked for checking. ` +
        'They’ll be saved with an “Unconfirmed” note on the recipe. Save anyway?',
    )
  ) {
    return;
  }
  const submit = $('[data-save]');
  busy(submit, null, true);
  const result = await api('/api/save', draft);
  busy(submit, null, false);
  if (!result.ok) {
    if (result.reason === 'duplicate')
      say(reviewError, `This Reel is already saved as “${result.existing.title}”.`);
    else if (result.reason === 'invalid') say(reviewError, result.problems.join(' '));
    else say(reviewError, result.message);
    return;
  }
  state.dirty = false;
  $('[data-saved-path]').textContent = `recipes/${result.slug}.yaml`;
  const dev = $('[data-saved-dev]');
  dev.href = `http://localhost:4321/dishes/${result.slug}/`;
  dev.textContent = `/dishes/${result.slug}/`;
  showStep('saved');
  $('.saved-title').focus();
});

$('[data-back]').addEventListener('click', () => showStep('source'));

// ---------------------------------------------------------------------------
// 4. Saved, and starting again

function reset() {
  if (state.dirty && !window.confirm('Discard this draft?')) return;
  Object.assign(state, { url: '', autoCaption: null, creatorName: '', shots: [], dirty: false });
  linkForm.reset();
  $('[data-source-form]').reset();
  reviewForm.reset();
  renderShots();
  for (const element of [linkError, sourceError, reviewError, captionNote]) say(element, '');
  $('[data-caption-origin]').textContent = '— copy it from the Reel and paste it here';
  showStep('link');
  urlInput.focus();
}

$('[data-another]').addEventListener('click', () => reset());

window.addEventListener('beforeunload', (event) => {
  if (state.dirty) event.preventDefault();
});

// ---------------------------------------------------------------------------
// Start

(async () => {
  let available = { ytDlp: false, claude: false };
  try {
    available = await (await fetch('/api/status')).json();
  } catch {
    // The status note below covers it.
  }
  state.ytDlp = available.ytDlp;
  state.claude = available.claude;
  const notes = [];
  if (!available.claude) {
    notes.push(
      'ANTHROPIC_API_KEY isn’t set, so recipes can’t be drafted — you can still write one by hand.',
    );
    $('[data-draft-submit]').disabled = true;
  }
  if (!available.ytDlp) {
    notes.push('yt-dlp isn’t installed, so you’ll paste the caption yourself.');
  }
  say($('[data-status-note]'), notes.join(' '));
})();

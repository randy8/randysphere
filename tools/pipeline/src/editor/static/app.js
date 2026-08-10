// Plain, unbundled JS — no framework, no build step, matching this repo's
// pipeline half. Kept in one file on purpose (see docs/decisions.md): there's
// no bundler to split it sensibly, and splitting via bare <script> tags would
// just move the coupling into load order.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  photos: [], // API photo views + a synthetic `key`
  albumVersions: {},
  tagVocabulary: [], // [{tag, count}], kept in sync locally after edits
  filterText: '',
  selection: new Set(), // of photoKey
  anchorKey: null,
  focusKey: null,
  undoStack: [], // [{description, undo: () => Promise<void>}]
  saving: false,
  selectedWorkMode: false, // reorder view: shows only featured photos, sorted by featuredOrder, draggable
  reviewKey: null, // set while the full-size review overlay is open
};

const KEY_SEP = ' ';
function photoKey(albumOrPhoto, file) {
  if (typeof albumOrPhoto === 'object') return albumOrPhoto.album + KEY_SEP + albumOrPhoto.file;
  return albumOrPhoto + KEY_SEP + file;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function loadAll() {
  const [photosResponse, tagsResponse] = await Promise.all([
    fetch('/api/photos'),
    fetch('/api/tags'),
  ]);
  const photosBody = await photosResponse.json();
  const tagsBody = await tagsResponse.json();
  state.photos = photosBody.photos.map((p) => ({ ...p, key: photoKey(p, p.file) }));
  state.albumVersions = photosBody.albumVersions;
  state.tagVocabulary = tagsBody.tags;
  renderAll();
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function filteredPhotos() {
  const needle = state.filterText.trim().toLowerCase();
  if (needle === '') return state.photos;
  return state.photos.filter((p) => {
    if (p.file.toLowerCase().includes(needle)) return true;
    if (p.album.toLowerCase().includes(needle)) return true;
    return p.tags.some((tag) => tag.toLowerCase().includes(needle));
  });
}

/**
 * Selected Work, in its actual display order — featuredOrder ascending,
 * with any photo marked featured but not yet given an order sorted after
 * every ordered one (mirrors archive.ts's selectedWork() on the site).
 * Spans every album; only the featured flag decides membership.
 */
function selectedWorkPhotos() {
  return state.photos
    .filter((p) => p.featured)
    .slice()
    .sort((a, b) => {
      if (a.featuredOrder !== null && b.featuredOrder !== null)
        return a.featuredOrder - b.featuredOrder;
      if (a.featuredOrder !== null) return -1;
      if (b.featuredOrder !== null) return 1;
      return 0;
    });
}

/** Which list the grid is currently showing — the text filter, or the Selected Work reorder view. */
function visiblePhotos() {
  return state.selectedWorkMode ? selectedWorkPhotos() : filteredPhotos();
}

// ---------------------------------------------------------------------------
// Local tag merge (mirrors applyPhotoEdits' server-side logic exactly, so the
// UI can update instantly without a round-trip refetch after every edit).
// ---------------------------------------------------------------------------

function mergeTags(existing, addTags, removeTags) {
  const remove = new Set(removeTags ?? []);
  const kept = existing.filter((tag) => !remove.has(tag));
  for (const tag of addTags ?? []) {
    if (!kept.includes(tag)) kept.push(tag);
  }
  return kept;
}

function bumpTagCount(tag, delta) {
  const existing = state.tagVocabulary.find((t) => t.tag === tag);
  if (existing) {
    existing.count += delta;
    if (existing.count <= 0) state.tagVocabulary = state.tagVocabulary.filter((t) => t.tag !== tag);
  } else if (delta > 0) {
    state.tagVocabulary.push({ tag, count: delta });
  }
  state.tagVocabulary.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

function applyLocally(edits) {
  for (const edit of edits) {
    const photo = state.photos.find((p) => p.album === edit.album && p.file === edit.file);
    if (!photo) continue;
    if (edit.addTags || edit.removeTags) {
      const before = photo.tags;
      const after = mergeTags(before, edit.addTags, edit.removeTags);
      for (const tag of after) if (!before.includes(tag)) bumpTagCount(tag, 1);
      for (const tag of before) if (!after.includes(tag)) bumpTagCount(tag, -1);
      photo.tags = after;
    }
    if (edit.alt !== undefined) photo.alt = edit.alt;
    if (edit.caption !== undefined) photo.caption = edit.caption;
    if (edit.featured !== undefined) photo.featured = edit.featured;
    if (edit.featuredOrder !== undefined) photo.featuredOrder = edit.featuredOrder;
  }
}

/** Selected Work — toggling off clears featuredOrder too, since an unfeatured photo has no place in an order. */
async function setFeatured(photo, featured) {
  const edit = { album: photo.album, file: photo.file, featured };
  if (!featured) edit.featuredOrder = null;
  const ok = await sendEdits([edit]);
  if (ok) renderAll();
}

async function setFeaturedOrder(photo, order) {
  const ok = await sendEdits([{ album: photo.album, file: photo.file, featuredOrder: order }]);
  if (ok) renderAll();
}

/** The one cover per album — success flips it locally for every photo in that album, not just this one. */
async function setCoverPhoto(photo) {
  setStatus('Setting cover…');
  const response = await fetch('/api/cover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ album: photo.album, file: photo.file }),
  });
  if (!response.ok) {
    setStatus('Failed to set cover.', true);
    return;
  }
  for (const p of state.photos) {
    if (p.album === photo.album) p.cover = p.file === photo.file;
  }
  setStatus('Cover set.');
  renderAll();
}

// ---------------------------------------------------------------------------
// Applying edits over the network
// ---------------------------------------------------------------------------

function setStatus(text, isError) {
  const el = document.getElementById('status');
  el.textContent = text;
  el.classList.toggle('error', Boolean(isError));
}

/**
 * Sends a batch of edits, updates local state on success, and surfaces a
 * conflict (a concurrent `pnpm ingest` or hand-edit) by asking the user to
 * reload rather than silently retrying or overwriting anything.
 */
async function sendEdits(edits) {
  if (edits.length === 0) return true;
  state.saving = true;
  setStatus('Saving…');
  const albums = [...new Set(edits.map((e) => e.album))];
  const expectedVersions = Object.fromEntries(albums.map((a) => [a, state.albumVersions[a]]));

  const response = await fetch('/api/edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ edits, expectedVersions }),
  });
  const body = await response.json();
  state.saving = false;

  if (!body.ok) {
    const staleAlbums = body.conflicts.map((c) => c.album).join(', ');
    setStatus(`${staleAlbums} changed on disk — reload to continue.`, true);
    return false;
  }

  Object.assign(state.albumVersions, body.albumVersions);
  applyLocally(edits);
  setStatus('Saved');
  return true;
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

function pushUndo(description, undo) {
  state.undoStack.push({ description, undo });
  if (state.undoStack.length > 20) state.undoStack.shift();
}

async function undoLast() {
  const entry = state.undoStack.pop();
  if (!entry) {
    setStatus('Nothing to undo.');
    return;
  }
  setStatus(`Undoing: ${entry.description}…`);
  await entry.undo();
  setStatus(`Undid: ${entry.description}`);
  renderAll();
}

/** Builds forward+inverse edits for adding one tag to a set of photos, skipping photos that already have it (nothing to add, nothing to undo). */
function addTagEdits(photos, tag) {
  const targets = photos.filter((p) => !p.tags.includes(tag));
  return {
    forward: targets.map((p) => ({ album: p.album, file: p.file, addTags: [tag] })),
    inverse: targets.map((p) => ({ album: p.album, file: p.file, removeTags: [tag] })),
  };
}

/** Builds forward+inverse edits for removing one tag from every photo that has it. */
function removeTagEdits(photos, tag) {
  const targets = photos.filter((p) => p.tags.includes(tag));
  return {
    forward: targets.map((p) => ({ album: p.album, file: p.file, removeTags: [tag] })),
    inverse: targets.map((p) => ({ album: p.album, file: p.file, addTags: [tag] })),
  };
}

async function addTagToSelection(tag) {
  const photos = selectedPhotos();
  const { forward, inverse } = addTagEdits(photos, tag);
  if (forward.length === 0) return;
  const ok = await sendEdits(forward);
  if (ok) pushUndo(`add "${tag}" to ${String(forward.length)} photo(s)`, () => sendEdits(inverse));
  renderAll();
}

async function removeTagFromSelection(tag) {
  const photos = selectedPhotos();
  const { forward, inverse } = removeTagEdits(photos, tag);
  if (forward.length === 0) return;
  const ok = await sendEdits(forward);
  if (ok)
    pushUndo(`remove "${tag}" from ${String(forward.length)} photo(s)`, () => sendEdits(inverse));
  renderAll();
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function selectedPhotos() {
  return state.photos.filter((p) => state.selection.has(p.key));
}

function selectOnly(key) {
  state.selection = new Set([key]);
  state.anchorKey = key;
  state.focusKey = key;
}

function toggleKey(key) {
  if (state.selection.has(key)) state.selection.delete(key);
  else state.selection.add(key);
  state.anchorKey = key;
  state.focusKey = key;
}

function selectRangeTo(key) {
  const visible = visiblePhotos();
  const anchorIndex = visible.findIndex((p) => p.key === (state.anchorKey ?? key));
  const targetIndex = visible.findIndex((p) => p.key === key);
  if (anchorIndex === -1 || targetIndex === -1) {
    selectOnly(key);
    return;
  }
  const [start, end] =
    anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  state.selection = new Set(visible.slice(start, end + 1).map((p) => p.key));
  state.focusKey = key;
}

function selectAllFiltered() {
  const visible = visiblePhotos();
  state.selection = new Set(visible.map((p) => p.key));
  if (visible.length > 0) state.focusKey = visible[visible.length - 1].key;
}

function clearSelection() {
  state.selection = new Set();
}

// ---------------------------------------------------------------------------
// Rendering: grid
// ---------------------------------------------------------------------------

/** Reassigns sequential featuredOrder (0..n-1) after a drag reorder, one batch edit spanning however many albums Selected Work touches. */
async function reorderSelectedWork(fromKey, toKey) {
  const ordered = selectedWorkPhotos();
  const fromIndex = ordered.findIndex((p) => p.key === fromKey);
  const toIndex = ordered.findIndex((p) => p.key === toKey);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;
  const [moved] = ordered.splice(fromIndex, 1);
  ordered.splice(toIndex, 0, moved);
  const edits = ordered.map((p, index) => ({ album: p.album, file: p.file, featuredOrder: index }));
  setStatus('Reordering…');
  const ok = await sendEdits(edits);
  if (ok) setStatus('Reordered');
  renderAll();
}

let dragKey = null;

function renderGrid() {
  const grid = document.getElementById('grid');
  const visible = visiblePhotos();
  grid.innerHTML = '';
  const fragment = document.createDocumentFragment();

  for (const photo of visible) {
    const cell = document.createElement('figure');
    cell.className = 'cell';
    cell.dataset.key = photo.key;
    if (state.selection.has(photo.key)) cell.classList.add('selected');
    if (state.focusKey === photo.key) cell.classList.add('focused');

    const img = document.createElement('img');
    img.src = photo.thumbnailUrl;
    img.loading = 'lazy';
    img.alt = '';
    cell.appendChild(img);

    if (photo.alt.trim() === '') {
      const dot = document.createElement('span');
      dot.className = 'no-alt-dot';
      dot.title = 'No alt text yet';
      cell.appendChild(dot);
    }

    if (!state.selectedWorkMode) {
      const star = document.createElement('button');
      star.type = 'button';
      star.className = photo.featured ? 'featured-star is-featured' : 'featured-star';
      star.title = photo.featured ? 'Remove from Selected Work' : 'Add to Selected Work';
      star.setAttribute('aria-pressed', String(photo.featured));
      star.textContent = photo.featured ? '★' : '☆';
      // Toggles directly from the grid — the fast path for picking Selected
      // Work without opening the inspector. Stops propagation so it never
      // also fires the cell's own click-to-select handler below.
      star.addEventListener('click', (event) => {
        event.stopPropagation();
        void setFeatured(photo, !photo.featured);
      });
      cell.appendChild(star);
    }
    if (photo.cover) {
      const coverMark = document.createElement('span');
      coverMark.className = 'cover-mark';
      coverMark.title = 'Album cover';
      coverMark.textContent = 'Cover';
      cell.appendChild(coverMark);
    }

    const badge = document.createElement('figcaption');
    badge.className = 'badge';
    badge.textContent = state.selectedWorkMode
      ? `${String(visible.indexOf(photo) + 1)} · ${photo.album}`
      : photo.tags.length > 0
        ? photo.tags.join(', ')
        : photo.file;
    cell.appendChild(badge);

    cell.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey) toggleKey(photo.key);
      else if (event.shiftKey) selectRangeTo(photo.key);
      else selectOnly(photo.key);
      renderAll();
    });
    // A mouse-friendly way into Review — the tiny thumbnail is for
    // orientation, not for actually looking at the photo.
    cell.addEventListener('dblclick', (event) => {
      event.preventDefault();
      openReview(photo.key);
    });

    if (state.selectedWorkMode) {
      cell.draggable = true;
      cell.addEventListener('dragstart', (event) => {
        dragKey = photo.key;
        event.dataTransfer.effectAllowed = 'move';
        cell.classList.add('dragging');
      });
      cell.addEventListener('dragend', () => {
        dragKey = null;
        cell.classList.remove('dragging');
      });
      cell.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        cell.classList.add('drop-target');
      });
      cell.addEventListener('dragleave', () => {
        cell.classList.remove('drop-target');
      });
      cell.addEventListener('drop', (event) => {
        event.preventDefault();
        cell.classList.remove('drop-target');
        if (dragKey === null) return;
        void reorderSelectedWork(dragKey, photo.key);
      });
    }

    fragment.appendChild(cell);
  }

  grid.appendChild(fragment);
  document.getElementById('count').textContent =
    state.selection.size > 0
      ? `${String(state.selection.size)} / ${String(visible.length)} selected`
      : state.selectedWorkMode
        ? `${String(visible.length)} in Selected Work — drag to reorder`
        : `${String(visible.length)} photo(s)`;
}

function getColumnCount() {
  const grid = document.getElementById('grid');
  const template = getComputedStyle(grid).gridTemplateColumns;
  return template.split(' ').filter(Boolean).length || 1;
}

// ---------------------------------------------------------------------------
// Rendering: side panel (inspector for one photo, batch bar for many)
// ---------------------------------------------------------------------------

function tagAutocompleteList(input, onCommit) {
  let box = input.parentElement.querySelector('.autocomplete');
  const query = input.value.trim().toLowerCase();
  if (query === '') {
    if (box) box.remove();
    return;
  }
  const matches = state.tagVocabulary
    .filter((t) => t.tag.toLowerCase().includes(query))
    .slice(0, 8);
  if (!box) {
    box = document.createElement('div');
    box.className = 'autocomplete';
    input.parentElement.appendChild(box);
  }
  box.innerHTML = '';
  const exactExists = state.tagVocabulary.some((t) => t.tag === query);
  const options = exactExists
    ? matches
    : [...matches, { tag: input.value.trim(), count: 0, isNew: true }];
  options.forEach((option, index) => {
    const row = document.createElement('div');
    row.textContent = option.tag;
    if (option.isNew) row.textContent += ' (new)';
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = option.count > 0 ? String(option.count) : '';
    row.appendChild(n);
    if (index === 0) row.classList.add('active');
    row.addEventListener('mousedown', (event) => {
      event.preventDefault();
      onCommit(option.tag);
      box.remove();
    });
    box.appendChild(row);
  });
  if (options.length === 0) box.remove();
}

function wireTagInput(input, onCommit) {
  input.addEventListener('input', () => tagAutocompleteList(input, onCommit));
  input.addEventListener('keydown', (event) => {
    const box = input.parentElement.querySelector('.autocomplete');
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!box) return;
      event.preventDefault();
      const rows = [...box.children];
      const activeIndex = rows.findIndex((r) => r.classList.contains('active'));
      const nextIndex =
        event.key === 'ArrowDown'
          ? Math.min(activeIndex + 1, rows.length - 1)
          : Math.max(activeIndex - 1, 0);
      rows.forEach((r, i) => r.classList.toggle('active', i === nextIndex));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const active = box?.querySelector('.active');
      const tag = active ? active.firstChild.textContent.replace(' (new)', '') : input.value.trim();
      if (tag !== '') onCommit(tag);
      input.value = '';
      box?.remove();
      return;
    }
    if (event.key === 'Escape') {
      box?.remove();
      input.blur();
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => input.parentElement.querySelector('.autocomplete')?.remove(), 150);
  });
}

function renderInspector(photo) {
  const panel = document.getElementById('inspector');
  panel.hidden = false;
  document.getElementById('batch-bar').hidden = true;
  panel.innerHTML = '';

  const img = document.createElement('img');
  img.className = 'preview';
  img.src = photo.previewUrl;
  img.alt = photo.alt;
  panel.appendChild(img);

  const meta = document.createElement('div');
  meta.className = 'section-label';
  meta.textContent = `${photo.album} · ${photo.roll} · ${photo.file}`;
  panel.appendChild(meta);

  const coverButton = document.createElement('button');
  coverButton.type = 'button';
  coverButton.className = 'cover-button';
  coverButton.textContent = photo.cover ? 'Album cover ✓' : 'Set as album cover';
  coverButton.disabled = photo.cover;
  coverButton.addEventListener('click', () => void setCoverPhoto(photo));
  panel.appendChild(coverButton);

  const selectedField = document.createElement('div');
  selectedField.className = 'field selected-work-field';
  const selectedLabel = document.createElement('label');
  const selectedCheckbox = document.createElement('input');
  selectedCheckbox.type = 'checkbox';
  selectedCheckbox.id = 'featured-input';
  selectedCheckbox.checked = photo.featured;
  selectedCheckbox.addEventListener(
    'change',
    () => void setFeatured(photo, selectedCheckbox.checked),
  );
  selectedLabel.appendChild(selectedCheckbox);
  selectedLabel.append(' Selected Work');
  selectedField.appendChild(selectedLabel);
  if (photo.featured) {
    const orderInput = document.createElement('input');
    orderInput.type = 'number';
    orderInput.min = '0';
    orderInput.className = 'featured-order-input';
    orderInput.placeholder = 'order (optional)';
    orderInput.value = photo.featuredOrder ?? '';
    orderInput.title =
      'Position within Selected Work — lower sorts first. Leave blank to sort after every ordered photo.';
    orderInput.addEventListener('blur', () => {
      const raw = orderInput.value.trim();
      const order = raw === '' ? null : Number(raw);
      if (order !== photo.featuredOrder) void setFeaturedOrder(photo, order);
    });
    selectedField.appendChild(orderInput);
  }
  panel.appendChild(selectedField);

  const altField = document.createElement('div');
  altField.className = 'field';
  altField.innerHTML = '<label for="alt-input">Alt text</label>';
  const altInput = document.createElement('textarea');
  altInput.id = 'alt-input';
  altInput.value = photo.alt;
  altField.appendChild(altInput);
  panel.appendChild(altField);

  const captionField = document.createElement('div');
  captionField.className = 'field';
  captionField.innerHTML = '<label for="caption-input">Caption</label>';
  const captionInput = document.createElement('textarea');
  captionInput.id = 'caption-input';
  captionInput.value = photo.caption ?? '';
  captionField.appendChild(captionInput);
  panel.appendChild(captionField);

  function saveText() {
    const edits = [];
    if (altInput.value !== photo.alt)
      edits.push({ album: photo.album, file: photo.file, alt: altInput.value });
    const newCaption = captionInput.value.trim() === '' ? null : captionInput.value;
    if (newCaption !== photo.caption)
      edits.push({ album: photo.album, file: photo.file, caption: newCaption });
    if (edits.length > 0) void sendEdits(edits).then(renderAll);
  }
  altInput.addEventListener('blur', saveText);
  captionInput.addEventListener('blur', saveText);
  for (const field of [altInput, captionInput]) {
    field.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        field.blur();
      }
    });
  }

  const tagsLabel = document.createElement('div');
  tagsLabel.className = 'section-label';
  tagsLabel.textContent = 'Tags';
  panel.appendChild(tagsLabel);

  const chips = document.createElement('div');
  chips.className = 'tag-chips';
  for (const tag of photo.tags) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.append(tag);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      void sendEdits([{ album: photo.album, file: photo.file, removeTags: [tag] }]).then(renderAll);
    });
    chip.appendChild(remove);
    chips.appendChild(chip);
  }
  panel.appendChild(chips);

  const inputWrap = document.createElement('div');
  inputWrap.className = 'tag-input-wrap';
  const tagInput = document.createElement('input');
  tagInput.type = 'text';
  tagInput.placeholder = 'Add a tag ( T )';
  tagInput.id = 'tag-input';
  inputWrap.appendChild(tagInput);
  panel.appendChild(inputWrap);
  wireTagInput(tagInput, (tag) => {
    void sendEdits([{ album: photo.album, file: photo.file, addTags: [tag] }]).then(renderAll);
  });
}

function renderBatchBar(photos) {
  const panel = document.getElementById('batch-bar');
  panel.hidden = false;
  document.getElementById('inspector').hidden = true;
  panel.innerHTML = '';

  const heading = document.createElement('h3');
  heading.textContent = `${String(photos.length)} photos selected`;
  panel.appendChild(heading);

  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = 'Tags (solid = every photo, dashed = some)';
  panel.appendChild(label);

  const counts = new Map();
  for (const photo of photos)
    for (const tag of photo.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);

  const chips = document.createElement('div');
  chips.className = 'tag-chips';
  for (const [tag, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const chip = document.createElement('span');
    const isAll = count === photos.length;
    chip.className = isAll ? 'chip' : 'chip mixed';
    chip.title = isAll
      ? 'On every selected photo — click to remove from all'
      : 'On some selected photos — click to add to all';
    chip.append(tag);
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', () => {
      if (isAll) void removeTagFromSelection(tag);
      else void addTagToSelection(tag);
    });
    chips.appendChild(chip);
  }
  panel.appendChild(chips);

  const inputWrap = document.createElement('div');
  inputWrap.className = 'tag-input-wrap';
  const tagInput = document.createElement('input');
  tagInput.type = 'text';
  tagInput.placeholder = 'Add a tag to all selected ( T )';
  tagInput.id = 'tag-input';
  inputWrap.appendChild(tagInput);
  panel.appendChild(inputWrap);
  wireTagInput(tagInput, (tag) => void addTagToSelection(tag));
}

function renderSidePanel() {
  const photos = selectedPhotos();
  const sidePanel = document.getElementById('side-panel');
  if (photos.length === 0) {
    sidePanel.hidden = true;
    return;
  }
  sidePanel.hidden = false;
  if (photos.length === 1) renderInspector(photos[0]);
  else renderBatchBar(photos);
}

function renderAll() {
  renderGrid();
  renderSidePanel();
}

// ---------------------------------------------------------------------------
// Review overlay — thumbnails in the grid are small by design (fitting many
// on screen at once), which makes them a poor way to actually look at a
// photo or reliably click its tiny star. Review shows one photo large,
// moved through with the keyboard alone: R opens it at the focused photo,
// arrows/h j k l move to the next/previous, F stars it, Esc closes.
// ---------------------------------------------------------------------------

function isReviewOpen() {
  return !document.getElementById('review').hidden;
}

function openReview(key) {
  state.reviewKey = key;
  state.focusKey = key;
  document.getElementById('review').hidden = false;
  renderReview();
}

function closeReview() {
  state.reviewKey = null;
  document.getElementById('review').hidden = true;
}

function reviewMove(delta) {
  const visible = visiblePhotos();
  const index = visible.findIndex((p) => p.key === state.reviewKey);
  if (index === -1) return;
  const next = Math.min(Math.max(index + delta, 0), visible.length - 1);
  state.reviewKey = visible[next].key;
  renderReview();
}

function renderReview() {
  const photo = state.photos.find((p) => p.key === state.reviewKey);
  if (!photo) {
    closeReview();
    return;
  }
  state.focusKey = photo.key;

  const image = document.getElementById('review-image');
  image.src = photo.previewUrl;
  image.alt = photo.alt || '';

  const caption =
    (photo.tags.length > 0 ? photo.tags.join(', ') : photo.file) +
    (photo.alt.trim() === '' ? ' · no alt text yet' : '');
  document.getElementById('review-caption').textContent = caption;

  const star = document.getElementById('review-star');
  star.textContent = photo.featured ? '★ Selected Work ( F )' : '☆ Selected Work ( F )';
  star.classList.toggle('is-featured', photo.featured);

  const visible = visiblePhotos();
  const index = visible.findIndex((p) => p.key === photo.key);
  document.getElementById('review-prev').disabled = index <= 0;
  document.getElementById('review-next').disabled = index === -1 || index >= visible.length - 1;

  // Keep the grid's focus ring in sync underneath, so closing review lands
  // exactly where review left off.
  renderGrid();
}

async function toggleReviewFeatured() {
  const photo = state.photos.find((p) => p.key === state.reviewKey);
  if (!photo) return;
  await setFeatured(photo, !photo.featured);
  renderReview();
}

// ---------------------------------------------------------------------------
// Tag manager modal
// ---------------------------------------------------------------------------

function renderTagManager() {
  const list = document.getElementById('tag-manager-list');
  list.innerHTML = '';
  for (const { tag, count } of state.tagVocabulary) {
    const row = document.createElement('div');
    row.className = 'tag-row';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = tag;
    row.appendChild(name);

    const countEl = document.createElement('span');
    countEl.className = 'count';
    countEl.textContent = `${String(count)} photo(s)`;
    row.appendChild(countEl);

    const renameInput = document.createElement('input');
    renameInput.type = 'text';
    renameInput.placeholder = 'rename to…';
    row.appendChild(renameInput);

    const renameButton = document.createElement('button');
    renameButton.type = 'button';
    renameButton.className = 'rename';
    renameButton.textContent = 'Rename';
    renameButton.addEventListener('click', async () => {
      const to = renameInput.value.trim();
      if (to === '' || to === tag) return;
      setStatus(`Renaming "${tag}" to "${to}"…`);
      const response = await fetch('/api/tags/rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: tag, to }),
      });
      const body = await response.json();
      Object.assign(state.albumVersions, body.albumVersions);
      await loadAll();
      pushUndo(`rename "${tag}" back from "${to}"`, async () => {
        const undoResponse = await fetch('/api/tags/rename', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from: to, to: tag }),
        });
        const undoBody = await undoResponse.json();
        Object.assign(state.albumVersions, undoBody.albumVersions);
        await loadAll();
      });
      setStatus(`Renamed "${tag}" to "${to}" on ${String(body.affected)} photo(s).`);
      renderTagManager();
    });
    row.appendChild(renameButton);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'delete';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', async () => {
      if (
        !confirm(
          `Remove "${tag}" from all ${String(count)} photo(s) that carry it? This has no in-app undo.`,
        )
      )
        return;
      setStatus(`Deleting "${tag}"…`);
      const response = await fetch('/api/tags/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag }),
      });
      const body = await response.json();
      Object.assign(state.albumVersions, body.albumVersions);
      await loadAll();
      setStatus(`Deleted "${tag}" from ${String(body.affected)} photo(s).`);
      renderTagManager();
    });
    row.appendChild(deleteButton);

    list.appendChild(row);
  }
}

function openTagManager() {
  renderTagManager();
  document.getElementById('tag-manager').hidden = false;
}
function closeTagManager() {
  document.getElementById('tag-manager').hidden = true;
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

function isTypingTarget(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

function moveFocus(delta) {
  const visible = visiblePhotos();
  if (visible.length === 0) return;
  const currentIndex = visible.findIndex((p) => p.key === state.focusKey);
  const nextIndex = Math.min(
    Math.max((currentIndex === -1 ? 0 : currentIndex) + delta, 0),
    visible.length - 1,
  );
  const nextKey = visible[nextIndex].key;
  state.focusKey = nextKey;
  document
    .querySelector(`.cell[data-key="${CSS.escape(nextKey)}"]`)
    ?.scrollIntoView({ block: 'nearest' });
  return nextKey;
}

function attachKeyboard() {
  document.addEventListener('keydown', (event) => {
    const typing = isTypingTarget(document.activeElement);

    // Review swallows its own keys entirely while open, ahead of every
    // other shortcut below — including Escape, which closes review
    // rather than falling through to "clear selection."
    if (isReviewOpen()) {
      if (event.key === 'Escape') {
        closeReview();
        renderAll();
        return;
      }
      if (['ArrowLeft', 'ArrowUp', 'h', 'k'].includes(event.key)) {
        event.preventDefault();
        reviewMove(-1);
        return;
      }
      if (['ArrowRight', 'ArrowDown', 'l', 'j'].includes(event.key)) {
        event.preventDefault();
        reviewMove(1);
        return;
      }
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        void toggleReviewFeatured();
        return;
      }
      return;
    }

    if (event.key === 'Escape') {
      if (!document.getElementById('tag-manager').hidden) closeTagManager();
      else if (!document.getElementById('help').hidden)
        document.getElementById('help').hidden = true;
      else if (typing) document.activeElement.blur();
      else {
        clearSelection();
        renderAll();
      }
      return;
    }

    if (typing) return;

    if (event.key === '/') {
      event.preventDefault();
      document.getElementById('filter').focus();
      return;
    }
    if (event.key === '?') {
      event.preventDefault();
      document.getElementById('help').hidden = !document.getElementById('help').hidden;
      return;
    }
    if (event.key.toLowerCase() === 't') {
      event.preventDefault();
      document.getElementById('tag-input')?.focus();
      return;
    }
    if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      const visible = visiblePhotos();
      const key = state.focusKey ?? visible[0]?.key;
      if (key) openReview(key);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selectAllFiltered();
      renderAll();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      void undoLast();
      return;
    }

    const columnCount = getColumnCount();
    const moves = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -columnCount,
      ArrowDown: columnCount,
      h: -1,
      l: 1,
      k: -columnCount,
      j: columnCount,
    };
    const delta = moves[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      const nextKey = moveFocus(delta);
      if (nextKey && event.shiftKey) selectRangeTo(nextKey);
      renderAll();
      return;
    }

    if ((event.key === ' ' || event.key === 'Enter') && state.focusKey) {
      event.preventDefault();
      toggleKey(state.focusKey);
      renderAll();
    }
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  const filter = document.getElementById('filter');
  filter.addEventListener('input', () => {
    state.filterText = filter.value;
    renderAll();
  });

  document.getElementById('selected-work-toggle').addEventListener('click', () => {
    state.selectedWorkMode = !state.selectedWorkMode;
    document
      .getElementById('selected-work-toggle')
      .setAttribute('aria-pressed', String(state.selectedWorkMode));
    clearSelection();
    renderAll();
  });

  document.getElementById('manage-tags').addEventListener('click', openTagManager);
  document.getElementById('tag-manager-close').addEventListener('click', closeTagManager);
  document.getElementById('tag-manager-backdrop').addEventListener('click', closeTagManager);
  document.getElementById('help-close').addEventListener('click', () => {
    document.getElementById('help').hidden = true;
  });
  document.getElementById('help-backdrop').addEventListener('click', () => {
    document.getElementById('help').hidden = true;
  });

  document.getElementById('review-close').addEventListener('click', () => {
    closeReview();
    renderAll();
  });
  document.getElementById('review-backdrop').addEventListener('click', () => {
    closeReview();
    renderAll();
  });
  document.getElementById('review-prev').addEventListener('click', () => reviewMove(-1));
  document.getElementById('review-next').addEventListener('click', () => reviewMove(1));
  document
    .getElementById('review-star')
    .addEventListener('click', () => void toggleReviewFeatured());

  attachKeyboard();
  loadAll().catch((error) => {
    console.error(error);
    setStatus('Failed to load — check the server log.', true);
  });
}

init();

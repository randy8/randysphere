/**
 * Page-specific glue for /exposures/saved/ alone — never imported
 * anywhere else. The page server-renders every public photograph's grid
 * tile (and the lightbox's data for each) because it has no way to know
 * what's saved at build time; this module prunes the grid down to the
 * saved subset and hands that order to the lightbox (setLightboxOrder),
 * then runs the page's three modes:
 *
 * - browse: tiles open the lightbox; × unsaves one; Share all; Select; Clear.
 * - select: tiles toggle a tick instead of opening (click, Enter or Space),
 *   with a live "N of M selected" and Share selected (disabled at 0).
 * - confirm-clear: Clear asks once before wiping the list.
 *
 * Sharing never touches the Saved list: it only encodes ids into a link
 * (share-code.ts) and shows it in the share panel — copyable by hand if the
 * clipboard is unavailable, with Copy, the system share sheet where there
 * is one, and Open.
 */

import { openPhoto, setLightboxOrder } from './lightbox.ts';
import { encodeIds } from './share-code.ts';
import { clearSaved, pruneStale, removeSaved, savedIds } from './saved.ts';

type Mode = 'browse' | 'select' | 'confirm-clear';

const COPIED_RESET_MS = 2000;
const SHARE_NOTE =
  "Anyone with this link sees exactly these photographs. Your Saved list isn't changed.";

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);

const grid = $('[data-saved-grid]');
const emptyMessage = $('[data-saved-empty]');
const summary = $('[data-saved-summary]');
const actions = $('[data-saved-actions]');
const panel = $('[data-share-panel]');
const panelTitle = $('[data-share-title]');
const panelUrl = $<HTMLInputElement>('[data-share-url]');
const panelStatus = $('[data-share-status]');
const copyButton = $<HTMLButtonElement>('[data-share-copy]');
const nativeButton = $<HTMLButtonElement>('[data-share-native]');
const openLink = $<HTMLAnchorElement>('[data-share-open]');
const shareSelectedButton = $<HTMLButtonElement>('[data-share-selected]');

const plural = (count: number): string => `${String(count)} photograph${count === 1 ? '' : 's'}`;

function init(gridElement: HTMLElement): void {
  const validIds = new Set(
    Array.from(
      gridElement.querySelectorAll<HTMLElement>('[data-photo-id]'),
      (el) => el.dataset['photoId'] ?? '',
    ),
  );
  pruneStale(validIds);
  const saved = new Set(savedIds());
  if (saved.size === 0) return;

  emptyMessage?.setAttribute('hidden', '');
  const kept: string[] = [];
  gridElement.querySelectorAll<HTMLElement>('[data-photo-id]').forEach((tile) => {
    const id = tile.dataset['photoId'] ?? '';
    if (saved.has(id)) kept.push(id);
    else tile.remove();
  });
  setLightboxOrder(kept);

  let mode: Mode = 'browse';
  const selected = new Set<string>();

  const tiles = (): HTMLElement[] =>
    Array.from(gridElement.querySelectorAll<HTMLElement>(':scope > [data-photo-id]'));
  const tileLink = (tile: HTMLElement): HTMLElement | null => tile.querySelector('a');

  const render = (): void => {
    const total = tiles().length;
    if (total === 0) {
      summary?.setAttribute('hidden', '');
      actions?.setAttribute('hidden', '');
      panel?.setAttribute('hidden', '');
      emptyMessage?.removeAttribute('hidden');
      return;
    }
    actions?.removeAttribute('hidden');
    for (const group of document.querySelectorAll<HTMLElement>('[data-mode]')) {
      group.hidden = group.dataset['mode'] !== mode;
    }
    const question = $('[data-clear-question]');
    if (question !== null) question.textContent = `Clear all ${plural(total)}?`;

    if (summary !== null) {
      summary.hidden = false;
      summary.textContent =
        mode === 'select' ? `${String(selected.size)} of ${String(total)} selected` : plural(total);
    }
    if (shareSelectedButton !== null) {
      shareSelectedButton.disabled = selected.size === 0;
      shareSelectedButton.textContent =
        selected.size === 0 ? 'Share selected' : `Share ${String(selected.size)}`;
      shareSelectedButton.title = selected.size === 0 ? 'Select photographs to share' : '';
    }

    gridElement.classList.toggle('is-selecting', mode === 'select');
    for (const tile of tiles()) {
      const id = tile.dataset['photoId'] ?? '';
      const isSelected = mode === 'select' && selected.has(id);
      tile.classList.toggle('is-selected', isSelected);
      const link = tileLink(tile);
      if (link === null) continue;
      // While selecting, each tile *is* a checkbox — announced and operated
      // as one; back in browse mode it's the plain link it always was.
      if (mode === 'select') {
        link.setAttribute('role', 'checkbox');
        link.setAttribute('aria-checked', String(isSelected));
      } else {
        link.removeAttribute('role');
        link.removeAttribute('aria-checked');
      }
    }
  };

  const setMode = (next: Mode): void => {
    mode = next;
    if (next !== 'select') selected.clear();
    render();
  };

  const toggle = (tile: HTMLElement): void => {
    const id = tile.dataset['photoId'] ?? '';
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    render();
  };

  const showShare = (ids: readonly string[]): void => {
    if (panel === null || panelUrl === null || ids.length === 0) return;
    const url = `${location.origin}/exposures/share/?p=${encodeIds(ids)}`;
    if (panelTitle !== null) panelTitle.textContent = `A link to ${plural(ids.length)}`;
    panelUrl.value = url;
    if (openLink !== null) openLink.href = url;
    if (panelStatus !== null) panelStatus.textContent = SHARE_NOTE;
    if (copyButton !== null) copyButton.textContent = 'Copy';
    if (nativeButton !== null) nativeButton.hidden = typeof navigator.share !== 'function';
    panel.hidden = false;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    panelUrl.focus();
    panelUrl.select();
  };

  // Share all: in the order the grid currently shows.
  $('[data-share-all]')?.addEventListener('click', () => {
    showShare(tiles().map((tile) => tile.dataset['photoId'] ?? ''));
  });
  shareSelectedButton?.addEventListener('click', () => {
    showShare(
      tiles()
        .map((tile) => tile.dataset['photoId'] ?? '')
        .filter((id) => selected.has(id)),
    );
  });

  $('[data-select-start]')?.addEventListener('click', () => {
    setMode('select');
    tileLink(tiles()[0] ?? document.body)?.focus();
  });
  $('[data-select-all]')?.addEventListener('click', () => {
    const all = tiles().map((tile) => tile.dataset['photoId'] ?? '');
    if (selected.size === all.length) selected.clear();
    else for (const id of all) selected.add(id);
    render();
  });
  $('[data-select-done]')?.addEventListener('click', () => {
    setMode('browse');
  });

  $('[data-clear-saved]')?.addEventListener('click', () => {
    setMode('confirm-clear');
    $('[data-clear-no]')?.focus();
  });
  $('[data-clear-no]')?.addEventListener('click', () => {
    setMode('browse');
  });
  $('[data-clear-yes]')?.addEventListener('click', () => {
    clearSaved();
    location.reload();
  });

  copyButton?.addEventListener('click', () => {
    const url = panelUrl?.value ?? '';
    navigator.clipboard.writeText(url).then(
      () => {
        copyButton.textContent = 'Copied ✓';
        if (panelStatus !== null) panelStatus.textContent = 'Link copied to the clipboard.';
        window.setTimeout(() => {
          copyButton.textContent = 'Copy';
        }, COPIED_RESET_MS);
      },
      () => {
        // No clipboard (an insecure context, a denied permission): the link
        // is right there, selected, to copy by hand.
        panelUrl?.focus();
        panelUrl?.select();
        if (panelStatus !== null)
          panelStatus.textContent =
            "Couldn't copy automatically — the link is selected, copy it from the box.";
      },
    );
  });
  nativeButton?.addEventListener('click', () => {
    const url = panelUrl?.value ?? '';
    navigator.share({ title: 'Photographs — Randy Liang', url }).catch(() => {
      // Dismissed the share sheet — nothing to do.
    });
  });
  $('[data-share-close]')?.addEventListener('click', () => {
    panel?.setAttribute('hidden', '');
  });

  gridElement.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const tile = event.target.closest<HTMLElement>('[data-photo-id]');
    const id = tile?.dataset['photoId'];
    if (tile === null || id === undefined) return;

    const removeButton = event.target.closest<HTMLElement>('[data-remove-saved]');
    if (removeButton !== null && mode !== 'select') {
      // Only the grid tile: the lightbox keeps it in its order until the
      // next load, as it always has.
      removeSaved(id);
      selected.delete(id);
      tile.remove();
      render();
      return;
    }

    if (event.target.closest('a') === null) return;
    event.preventDefault();
    if (mode === 'select') toggle(tile);
    else openPhoto(id);
  });

  // Space toggles a checkbox; a link only answers Enter on its own.
  gridElement.addEventListener('keydown', (event) => {
    if (mode !== 'select' || event.key !== ' ') return;
    const tile = (event.target as Element | null)?.closest<HTMLElement>('[data-photo-id]');
    if (tile === null || tile === undefined) return;
    event.preventDefault();
    toggle(tile);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!document.querySelector<HTMLElement>('[data-lightbox]')?.hidden) return;
    if (mode !== 'browse') setMode('browse');
    else if (panel !== null && !panel.hidden) panel.hidden = true;
  });

  render();
}

if (grid !== null) init(grid);

/**
 * Saved photographs — entirely client-side, entirely local. A single
 * localStorage key holding an ordered array of `sourceId` strings; never
 * image data, never anything else. Same house style as
 * recipes/checklist.ts: a namespaced key, try/catch around every read and
 * write so private browsing / a full quota / storage disabled degrades to
 * "nothing saves" rather than throwing.
 */

const SAVED_KEY = 'photography:saved';
const HINT_SEEN_KEY = 'photography:saved-hint-seen';

function readIds(): string[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeIds(ids: readonly string[]): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(ids));
  } catch {
    // Ignore — saving is a nicety, not core function.
  }
}

export function savedIds(): readonly string[] {
  return readIds();
}

export function savedCount(): number {
  return readIds().length;
}

export function isSaved(id: string): boolean {
  return readIds().includes(id);
}

/** Toggles membership, persists, and syncs every on-page indicator. Returns the new state. */
export function toggleSaved(id: string): boolean {
  const ids = readIds();
  const index = ids.indexOf(id);
  if (index === -1) {
    ids.push(id);
    writeIds(ids);
    syncSavedUI();
    return true;
  }
  ids.splice(index, 1);
  writeIds(ids);
  syncSavedUI();
  return false;
}

export function clearSaved(): void {
  writeIds([]);
  syncSavedUI();
}

/** Unconditional removal (unlike toggleSaved, safe to call without knowing the current state first). */
export function removeSaved(id: string): void {
  const ids = readIds();
  const kept = ids.filter((existing) => existing !== id);
  if (kept.length !== ids.length) {
    writeIds(kept);
    syncSavedUI();
  }
}

/**
 * Drops any saved id that no longer matches a photograph in the current
 * archive — a photo removed from originals/ shouldn't quietly inflate the
 * "Saved N" count forever. Only the Saved page has the full archive's id
 * list on hand to check against, so this is called from there alone.
 */
export function pruneStale(validIds: ReadonlySet<string>): void {
  const ids = readIds();
  const kept = ids.filter((id) => validIds.has(id));
  if (kept.length !== ids.length) {
    writeIds(kept);
    syncSavedUI();
  }
}

export function hasSeenHint(): boolean {
  try {
    return localStorage.getItem(HINT_SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

export function markHintSeen(): void {
  try {
    localStorage.setItem(HINT_SEEN_KEY, '1');
  } catch {
    // Ignore — worst case the hint reappears once more.
  }
}

/**
 * Every element that surfaces the saved count — the Photography nav's own
 * item and the corner mark shown during Browse — reads off the same
 * storage, so any change from any one of them is reflected everywhere else
 * on the page immediately.
 */
export function syncSavedUI(): void {
  const count = savedCount();
  document.querySelectorAll<HTMLElement>('[data-saved-count]').forEach((el) => {
    el.textContent = String(count);
  });
  document.querySelectorAll<HTMLElement>('[data-saved-link]').forEach((el) => {
    el.classList.toggle('is-shown', count > 0);
  });
}

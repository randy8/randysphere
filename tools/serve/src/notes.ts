import { readFileSync } from 'node:fs';

import { parse } from 'yaml';

export interface Note {
  readonly date: string;
  readonly text: string;
  readonly joy: boolean;
  readonly photo: string | null;
}

interface RawEntry {
  readonly date?: unknown;
  readonly text?: unknown;
  readonly joy?: unknown;
  readonly photo?: unknown;
}

interface NotesFile {
  readonly entries?: readonly RawEntry[];
}

/**
 * Reads `private/notes.yaml` — a hand-appended personal notebook, never
 * imported by the public site build. Missing file reads as no entries
 * rather than an error, the same tolerance `recipes.ts` and `films.ts`
 * already give their own content files.
 */
export function loadNotes(notesPath: string): Note[] {
  let raw: string;
  try {
    raw = readFileSync(notesPath, 'utf8');
  } catch {
    return [];
  }
  const data = (parse(raw) ?? {}) as NotesFile;
  const notes = (data.entries ?? [])
    .filter((entry): entry is RawEntry & { date: string; text: string } =>
      Boolean(typeof entry.date === 'string' && typeof entry.text === 'string'),
    )
    .map((entry) => ({
      date: entry.date,
      text: entry.text,
      joy: entry.joy === true,
      photo: typeof entry.photo === 'string' ? entry.photo : null,
    }));

  // Newest first. A plain string sort is correct as long as every date is
  // written in a sortable form (ISO-ish: "2026-08-08" or
  // "2026-08-08T09:15") — the same convention the entries doc-comment asks
  // for, not something this function enforces.
  return notes.slice().sort((a, b) => b.date.localeCompare(a.date));
}

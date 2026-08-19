import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  excerpt,
  filmsByYearRated,
  formatRuntime,
  loadFilms,
  parseCsv,
  type Film,
} from './films.ts';

test('parseCsv splits ordinary rows on commas', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3\n'), [
    ['a', 'b', 'c'],
    ['1', '2', '3'],
  ]);
});

test('parseCsv keeps a comma inside a quoted field as literal text, not a column break', () => {
  assert.deepEqual(parseCsv('Date,Name,Year\n2022-02-13,"Paris, Texas",1984\n'), [
    ['Date', 'Name', 'Year'],
    ['2022-02-13', 'Paris, Texas', '1984'],
  ]);
});

test('parseCsv unescapes a doubled quote inside a quoted field to one literal quote', () => {
  assert.deepEqual(parseCsv('Name\n"She said ""hello""."\n'), [['Name'], ['She said "hello".']]);
});

test('parseCsv handles the last row with no trailing newline', () => {
  assert.deepEqual(parseCsv('a,b\n1,2'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('loadFilms reads the real committed export and every entry has a title, a year, and a Letterboxd link', () => {
  const films = loadFilms();
  assert.ok(
    films.length > 0,
    'expected at least one five-star film in films/five-star-ratings.csv',
  );
  for (const film of films) {
    assert.ok(film.title.length > 0);
    assert.ok(film.year > 0);
    assert.ok(film.letterboxdUrl.startsWith('https://'));
  }
});

test('loadFilms merges films/tmdb.json onto matching rows by title and year', () => {
  const films = loadFilms();
  const withPoster = films.filter((film) => film.posterPath !== null);
  // Not asserting an exact count — tmdb.json is refreshed independently by
  // `pnpm films:posters` and will drift as new films are rated — only that
  // the merge is actually wired up end to end.
  assert.ok(
    withPoster.length > 0,
    'expected at least one film to have a poster from films/tmdb.json',
  );
  for (const film of withPoster) {
    assert.ok(film.posterPath?.startsWith('/'));
  }
});

test('loadFilms sorts newest-rated first', () => {
  const films = loadFilms();
  for (let i = 1; i < films.length; i += 1) {
    assert.ok((films[i - 1]?.ratedOn ?? '') >= (films[i]?.ratedOn ?? ''));
  }
});

test('loadFilms merges films/tmdb.json runtime and director onto matching rows', () => {
  const films = loadFilms();
  const withCredits = films.filter((film) => film.director !== null);
  assert.ok(
    withCredits.length > 0,
    'expected at least one film to have a director from films/tmdb.json',
  );
  for (const film of withCredits) {
    // TMDB itself sometimes has no runtime for an obscure or region-specific
    // match — it comes back as 0, not omitted, so 0 is a legitimate "TMDB
    // doesn't know" value here, not a bug in the merge.
    assert.ok(film.runtimeMinutes === null || film.runtimeMinutes >= 0);
  }
});

test('loadFilms applies films/poster-overrides.yaml to the matching film only', () => {
  const films = loadFilms();
  const bodyHeat = films.find((film) => film.title === 'Body Heat' && film.year === 1981);
  assert.deepEqual(bodyHeat?.posterFocal, { x: 48, y: 42, zoom: 1.05 });
  const withoutOverride = films.find((film) => film.title !== 'Body Heat');
  assert.equal(withoutOverride?.posterFocal, null);
});

function film(overrides: Partial<Film>): Film {
  return {
    title: 'Untitled',
    year: 2000,
    ratedOn: '2024-01-01',
    letterboxdUrl: 'https://boxd.it/x',
    posterPath: null,
    overview: null,
    runtimeMinutes: null,
    director: null,
    genres: [],
    posterFocal: null,
    ...overrides,
  };
}

test('filmsByYearRated groups by the year rated, newest year first', () => {
  const groups = filmsByYearRated([
    film({ title: 'A', ratedOn: '2023-05-01' }),
    film({ title: 'B', ratedOn: '2025-01-01' }),
    film({ title: 'C', ratedOn: '2023-11-01' }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.year),
    ['2025', '2023'],
  );
  assert.deepEqual(
    groups.find((g) => g.year === '2023')?.films.map((f) => f.title),
    ['A', 'C'],
  );
});

test('formatRuntime shows hours and minutes', () => {
  assert.equal(formatRuntime(142), '2h 22m');
});

test('formatRuntime under an hour omits the hours part entirely', () => {
  assert.equal(formatRuntime(45), '45m');
});

test('excerpt returns short text unchanged', () => {
  assert.equal(excerpt('A short plot.', 140), 'A short plot.');
});

test('excerpt cuts at the nearest word boundary and adds an ellipsis, not mid-word', () => {
  assert.equal(excerpt('The quick brown fox jumps over the lazy dog', 12), 'The quick…');
});

test('excerpt falls back to a hard cut when the first word alone exceeds maxLength', () => {
  assert.equal(excerpt('Supercalifragilisticexpialidocious is a word', 10), 'Supercalif…');
});

test('filmsByYearRated preserves each film exactly once', () => {
  const groups = filmsByYearRated([
    film({ ratedOn: '2024-01-01' }),
    film({ ratedOn: '2024-06-01' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.films.length, 2);
});

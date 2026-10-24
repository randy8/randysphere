import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { fiveStarCsv } from './import-ratings.ts';

const EXPORT = [
  'Date,Name,Year,Letterboxd URI,Rating',
  '2020-01-28,American Psycho,2000,https://boxd.it/28Vs,5',
  '2020-02-01,Cats,2019,https://boxd.it/aaaa,0.5',
  '2020-09-07,"Synecdoche, New York",2008,https://boxd.it/23zw,5',
  '2021-03-03,"The ""Quoted"" Film",2001,https://boxd.it/bbbb,4.5',
  '',
].join('\r\n');

test('keeps only five-star rows, in export order, quoted only where needed, LF endings', () => {
  const { csv, count } = fiveStarCsv(EXPORT);
  assert.equal(count, 2);
  assert.equal(
    csv,
    'Date,Name,Year,Letterboxd URI,Rating\n' +
      '2020-01-28,American Psycho,2000,https://boxd.it/28Vs,5\n' +
      '2020-09-07,"Synecdoche, New York",2008,https://boxd.it/23zw,5\n',
  );
});

test('the committed five-star CSV round-trips byte for byte', () => {
  const committed = readFileSync(
    join(import.meta.dirname, '..', '..', 'films', 'five-star-ratings.csv'),
    'utf8',
  );
  assert.equal(fiveStarCsv(committed).csv, committed);
});

test('a file that is not a ratings export is refused, not half-imported', () => {
  assert.throws(
    () => fiveStarCsv('Date,Name,Year,Letterboxd URI\n2020-01-01,Film,2020,https://boxd.it/x\n'),
    /Not a Letterboxd ratings export/,
  );
});

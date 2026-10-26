import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FILM_STOCK_NAMES, filmStockName } from './film-stocks.ts';

test('a known stock reads as its maker prints it', () => {
  assert.equal(filmStockName('cinestill400d'), 'CineStill 400D');
  assert.equal(filmStockName('kodaktrix400'), 'Kodak Tri-X 400');
  assert.equal(filmStockName('portra400'), 'Kodak Portra 400');
});

test('an unknown stock still reads as words, never as a slug', () => {
  assert.equal(filmStockName('fomapan100'), 'Fomapan 100');
  assert.equal(filmStockName('superia400x'), 'Superia 400 x');
});

test('every stock in rolls.yaml today has an exact name', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const albums = new URL('../../../albums/', import.meta.url);
  const stocks = new Set<string>();
  for (const batch of readdirSync(albums)) {
    let text: string;
    try {
      text = readFileSync(new URL(`${batch}/rolls.yaml`, albums), 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/filmStock:\s*'?([a-z0-9]+)'?/g)) stocks.add(match[1] ?? '');
  }
  assert.ok(stocks.size > 0, 'found no stocks in albums/*/rolls.yaml');
  for (const stock of stocks) {
    assert.ok(stock in FILM_STOCK_NAMES, `add "${stock}" to FILM_STOCK_NAMES`);
  }
});

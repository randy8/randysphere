import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderInline, renderQuiet } from './markup.ts';

test('renderInline turns **bold** into <strong>', () => {
  assert.equal(renderInline("**454 g** Rao's penne"), "<strong>454 g</strong> Rao's penne");
});

test('renderInline escapes HTML in the source text rather than passing it through', () => {
  assert.equal(renderInline('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('renderInline leaves plain text with no ** markers untouched', () => {
  assert.equal(renderInline('Butter'), 'Butter');
});

test('renderQuiet turns **bold** into a quiet span, not <strong> — instructions read continuously, not scanned', () => {
  assert.equal(
    renderQuiet('Boil for **1 minute**.'),
    'Boil for <span class="measurement">1 minute</span>.',
  );
});

test('renderQuiet escapes HTML in the source text rather than passing it through', () => {
  assert.equal(renderQuiet('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

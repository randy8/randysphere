import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import Anthropic from '@anthropic-ai/sdk';

import type { Extraction, MessagesClient } from './extract.ts';
import { checkUrl, draftRecipe, readCaption, saveRecipe } from './importer.ts';
import type { DraftInput, ImporterDeps } from './importer.ts';

const URL = 'https://www.instagram.com/reel/C9xYz_Ab-12/';
const CAPTION =
  'Gochujang tofu! 1 block tofu, 2 tbsp gochujang. Air fry 20 minutes then toss. #vegan';

function extraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    isRecipe: true,
    title: 'Gochujang Tofu',
    description: 'Air-fried tofu tossed in gochujang.',
    prepTime: '',
    cookTime: '20 min',
    totalTime: '',
    servings: '',
    ingredients: [
      { amount: '1 block', text: 'tofu', flag: '' },
      { amount: '2 tbsp', text: 'gochujang', flag: '' },
      { amount: '1 tbsp', text: 'oil', flag: '' },
    ],
    optionalIngredients: [],
    instructions: [{ text: 'Air fry the tofu for 20 minutes, then toss in gochujang.', flag: '' }],
    notes: [],
    tags: ['korean', 'tofu'],
    vegetarian: 'yes',
    nonVegetarianIngredients: [],
    creator: '',
    warnings: [],
    ...overrides,
  };
}

/** A fake client that records each request and answers with the given message parts. */
function fakeClient(answer: Partial<Anthropic.Beta.BetaMessage> | Error): {
  client: MessagesClient;
  requests: Anthropic.Beta.MessageCreateParamsNonStreaming[];
} {
  const requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    beta: {
      messages: {
        create(body) {
          requests.push(body);
          if (answer instanceof Error) return Promise.reject(answer);
          return Promise.resolve({
            stop_reason: 'end_turn',
            content: [],
            ...answer,
          } as Anthropic.Beta.BetaMessage);
        },
      },
    },
  };
  return { client, requests };
}

function answering(value: Extraction): Partial<Anthropic.Beta.BetaMessage> {
  return { content: [{ type: 'text', text: JSON.stringify(value), citations: null }] };
}

function deps(claude: MessagesClient | null, files: Record<string, string> = {}): ImporterDeps {
  const recipesDirectory = mkdtempSync(join(tmpdir(), 'recipes-'));
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(recipesDirectory, name), text);
  return {
    recipesDirectory,
    claude,
    ytDlp: () => Promise.reject(Object.assign(new Error(), { code: 'ENOENT' })),
  };
}

function input(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    url: URL,
    text: CAPTION,
    textFromCaption: false,
    creator: '@somecook',
    creatorName: '',
    screenshots: [],
    ...overrides,
  };
}

test('checkUrl refuses a Reel that is already a recipe', () => {
  const d = deps(null, {
    'gochujang-tofu.yaml': `title: 'Gochujang Tofu'\nsource:\n  url: 'https://www.instagram.com/reels/C9xYz_Ab-12/'\n`,
  });
  const result = checkUrl(d, 'instagram.com/reel/C9xYz_Ab-12?igsh=xyz');
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : '', /Already imported as “Gochujang Tofu”/);
  assert.equal(checkUrl(d, 'https://www.instagram.com/reel/Other123/').ok, true);
  assert.equal(checkUrl(d, 42).ok, false);
});

test('readCaption checks the link before running anything', async () => {
  let ran = false;
  const d = { ...deps(null), ytDlp: () => ((ran = true), Promise.resolve('{}')) };
  const result = await readCaption(d, 'https://example.com/reel/C9xYz_Ab-12/');
  assert.equal(result.ok, false);
  assert.equal(ran, false);
});

test('a draft carries the credit, the tags and a vegetarian tag, and passes amounts the caption states', async () => {
  const { client, requests } = fakeClient(answering(extraction()));
  const result = await draftRecipe(deps(client), input());
  assert.ok(result.ok);
  const draft = result.value;
  assert.equal(draft.source.url, URL);
  assert.equal(draft.source.creator, 'somecook');
  assert.equal(draft.source.via, 'pasted');
  assert.deepEqual(draft.tags, ['korean', 'tofu', 'vegetarian']);
  assert.deepEqual(
    draft.ingredients.map((line) => line.flag !== ''),
    [false, false, false],
    '"1 tbsp oil": 1 is in the caption, so it passes the number check',
  );

  const request = requests[0];
  assert.ok(request);
  assert.equal(request.model, 'claude-opus-5-5');
  assert.deepEqual(request.output_config?.format?.type, 'json_schema');
  assert.match(JSON.stringify(request.messages), /<caption>\\nGochujang tofu!/);
});

test('an invented amount is flagged when the caption is the only source', async () => {
  const { client } = fakeClient(
    answering(extraction({ ingredients: [{ amount: '3 tbsp', text: 'soy sauce', flag: '' }] })),
  );
  const result = await draftRecipe(deps(client), input());
  assert.ok(result.ok);
  assert.match(result.value.ingredients[0]?.flag ?? '', /isn’t in the caption/);
});

test('with screenshots, amounts are not number-checked against the text', async () => {
  const { client, requests } = fakeClient(
    answering(extraction({ ingredients: [{ amount: '3 tbsp', text: 'soy sauce', flag: '' }] })),
  );
  const result = await draftRecipe(
    deps(client),
    input({ text: '', screenshots: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }] }),
  );
  assert.ok(result.ok);
  assert.equal(result.value.ingredients[0]?.flag, '');
  assert.equal(result.value.source.via, 'screenshots');
  assert.match(JSON.stringify(requests[0]?.messages), /"type":"image"/);
});

test('a recipe with meat is drafted with a warning at the top', async () => {
  const { client } = fakeClient(
    answering(extraction({ vegetarian: 'no', nonVegetarianIngredients: ['chicken thighs'] })),
  );
  const result = await draftRecipe(deps(client), input());
  assert.ok(result.ok);
  assert.match(result.value.warnings[0] ?? '', /^Not vegetarian \(chicken thighs\)/);
  assert.ok(!result.value.tags.includes('vegetarian'));
});

test('drafting fails with a sentence for each way it can go wrong', async () => {
  const cases: [ImporterDeps, DraftInput, RegExp][] = [
    [deps(null), input(), /ANTHROPIC_API_KEY/],
    [deps(fakeClient(answering(extraction())).client), input({ text: '  ' }), /Paste the caption/],
    [
      deps(fakeClient(answering(extraction())).client),
      input({ text: 'x'.repeat(20_001) }),
      /too long/,
    ],
    [
      deps(fakeClient(answering(extraction())).client),
      input({ url: 'https://example.com' }),
      /Instagram link/,
    ],
    [
      deps(
        fakeClient(answering(extraction({ isRecipe: false, warnings: ['It is a dance video.'] })))
          .client,
      ),
      input(),
      /doesn’t look like a recipe\. It is a dance video\./,
    ],
    [deps(fakeClient({ stop_reason: 'refusal' }).client), input(), /declined/],
    [deps(fakeClient({ stop_reason: 'max_tokens' }).client), input(), /too long/],
    [deps(fakeClient({ content: [] }).client), input(), /nothing/],
    [
      deps(fakeClient({ content: [{ type: 'text', text: '{oops', citations: null }] }).client),
      input(),
      /wasn’t readable/,
    ],
    [
      deps(fakeClient(new Anthropic.APIConnectionError({ message: 'offline' })).client),
      input(),
      /Couldn’t reach/,
    ],
  ];
  for (const [d, i, message] of cases) {
    const result = await draftRecipe(d, i);
    assert.equal(result.ok, false, String(message));
    assert.match(!result.ok ? result.message : '', message);
  }
});

test('saveRecipe re-checks the link from the form and refuses a duplicate', () => {
  const d = deps(null);
  const form = {
    title: 'Gochujang Tofu',
    ingredients: [{ amount: '1 block', text: 'tofu', flag: '' }],
    instructions: [{ text: 'Cook.', flag: '' }],
    source: { url: 'instagram.com/reel/C9xYz_Ab-12/', creator: 'somecook', via: 'pasted' },
  };
  const first = saveRecipe(d, form);
  assert.equal(first.ok, true);
  const second = saveRecipe(d, form);
  assert.equal(!second.ok && second.reason, 'duplicate');
  const bad = saveRecipe(d, { ...form, source: { url: 'https://evil.example/' } });
  assert.equal(!bad.ok && bad.reason, 'url');
  assert.equal(readdirSync(d.recipesDirectory).length, 1);
});

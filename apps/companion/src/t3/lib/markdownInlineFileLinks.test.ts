import assert from 'node:assert/strict';
import test from 'node:test';

import { ENRICHED_INLINE_FILE_LINK_REGEX } from './enrichedLinkPresentation';
import { markdownWithInlineFileLinks } from './markdownInlineFileLinks';

const link = (markdown: string) =>
  markdownWithInlineFileLinks(markdown, ENRICHED_INLINE_FILE_LINK_REGEX);

test('inline code naming a file becomes a link the renderer draws as a chip', () => {
  assert.equal(link('See `src/demo.ts:3` now.'), 'See [src/demo.ts:3](<src/demo.ts:3>) now.');
  assert.equal(link('Edit `./a[1].ts`'), 'Edit [./a\\[1\\].ts](<./a\\[1\\].ts>)');
});

test('other code, fenced code and code inside a link label stay as written', () => {
  assert.equal(link('Run `yarn test` then `x + y`.'), 'Run `yarn test` then `x + y`.');
  const fenced = '```ts\nconst p = `src/demo.ts:3`;\n```\nafter `src/demo.ts`';
  assert.equal(
    link(fenced),
    '```ts\nconst p = `src/demo.ts:3`;\n```\nafter [src/demo.ts](<src/demo.ts>)',
  );
  assert.equal(link('[`src/demo.ts`](src/demo.ts)'), '[`src/demo.ts`](src/demo.ts)');
});

test('indented code, a fence in a blockquote and a mixed link label stay as written', () => {
  const indented = 'Paths:\n\n    const path = `src/demo.ts`;\n\nthen `src/demo.ts`';
  assert.equal(
    link(indented),
    'Paths:\n\n    const path = `src/demo.ts`;\n\nthen [src/demo.ts](<src/demo.ts>)',
  );
  const quoted = '> ```ts\n> const p = `src/demo.ts:3`;\n> ```\n> see `src/demo.ts:3`';
  assert.equal(
    link(quoted),
    '> ```ts\n> const p = `src/demo.ts:3`;\n> ```\n> see [src/demo.ts:3](<src/demo.ts:3>)',
  );
  const label = '[the `src/demo.ts` greeting](src/demo.ts:32) and `notes/plan.md`';
  assert.equal(
    link(label),
    '[the `src/demo.ts` greeting](src/demo.ts:32) and [notes/plan.md](<notes/plan.md>)',
  );
});

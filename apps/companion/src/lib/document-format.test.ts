import assert from 'node:assert/strict';

import { formatDocument } from './document-format';

assert.deepEqual(formatDocument('summary.json', '{"ok":true}'), [
  {
    kind: 'json',
    text: '{\n  "ok": true\n}',
  },
]);

assert.deepEqual(
  formatDocument(
    'report.md',
    [
      '# Ready gate',
      '',
      '- [x] **Evidence** captured',
      '1. Open [PR](https://example.test)',
      '> quoted note',
      '| File | Status |',
      '| --- | --- |',
      '| `after.png` | ok |',
    ].join('\n'),
  ).map(({ kind, text }) => ({ kind, text })),
  [
    { kind: 'heading', text: 'Ready gate' },
    { kind: 'paragraph', text: '' },
    { kind: 'bullet', text: '☑ Evidence captured' },
    { kind: 'numbered', text: '1. Open PR' },
    { kind: 'quote', text: 'quoted note' },
    { kind: 'table', text: 'File  |  Status\nafter.png  |  ok' },
  ],
);

// snake_case / SCREAMING_CASE identifiers must survive — they are not emphasis.
assert.deepEqual(
  formatDocument(
    'report.md',
    [
      'Set `node_support_dir` and MY_CONST, then run a_b_c.',
      'Real _emphasis_ stays stripped.',
    ].join('\n'),
  ).map(({ kind, text }) => ({ kind, text })),
  [
    { kind: 'paragraph', text: 'Set node_support_dir and MY_CONST, then run a_b_c.' },
    { kind: 'paragraph', text: 'Real emphasis stays stripped.' },
  ],
);

console.log('document format tests passed');

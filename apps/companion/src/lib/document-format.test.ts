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

console.log('document format tests passed');

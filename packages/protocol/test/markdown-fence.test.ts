import assert from 'node:assert/strict';
import test from 'node:test';

import { markdownFence } from '../src/markdown-fence.js';

test('a fenced block outlasts every backtick run inside it and keeps one line ending style', () => {
  assert.equal(markdownFence('npm test'), '```\nnpm test\n```');
  assert.equal(markdownFence('{}', 'json'), '```json\n{}\n```');
  assert.equal(markdownFence('a ``` b ```` c'), '`````\na ``` b ```` c\n`````');
  assert.equal(markdownFence('one\r\ntwo\rthree\n\n'), '```\none\ntwo\nthree\n```');
});

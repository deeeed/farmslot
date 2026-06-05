import assert from 'node:assert/strict';
import test from 'node:test';

import { shellQuoteForZsh } from './completion.js';

test('shellQuoteForZsh preserves apostrophes in paths', () => {
  const quoted = shellQuoteForZsh("/Users/O'Connor/.local/share/zsh/site-functions");
  assert.equal(quoted, "'/Users/O'\\''Connor/.local/share/zsh/site-functions'");
});

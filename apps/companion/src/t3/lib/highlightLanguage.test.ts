import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveHighlightLanguage } from './highlightLanguage';

test('a fence language or a file extension picks the native lexer', () => {
  assert.equal(resolveHighlightLanguage({ language: 'TS' }), 'ts');
  assert.equal(resolveHighlightLanguage({ path: 'src/demo.tsx' }), 'tsx');
  assert.equal(resolveHighlightLanguage({ path: 'notes/plan.md' }), 'md');
  assert.equal(resolveHighlightLanguage({ path: 'Dockerfile' }), 'dockerfile');
  assert.equal(resolveHighlightLanguage({ path: 'theme.xsl' }), 'xml');
  assert.equal(resolveHighlightLanguage({ language: 'nope', path: 'a.unknownext' }), 'text');
});

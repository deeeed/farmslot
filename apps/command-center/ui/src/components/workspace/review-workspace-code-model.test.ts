import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewWorkspaceLanguageForPath } from './review-workspace-code-model.js';

test('reviewWorkspaceLanguageForPath maps known review file extensions', () => {
  assert.equal(reviewWorkspaceLanguageForPath('src/app.tsx'), 'typescript');
  assert.equal(reviewWorkspaceLanguageForPath('README.md'), 'markdown');
  assert.equal(reviewWorkspaceLanguageForPath('scripts/check.py'), 'python');
  assert.equal(reviewWorkspaceLanguageForPath('Makefile'), 'plaintext');
});

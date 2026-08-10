import assert from 'node:assert/strict';
import test from 'node:test';

import { runWorkspaceTabForLegacyPackageTab } from './legacy-run-route';

test('legacy run links preserve supported package tabs and default to evidence', () => {
  assert.equal(runWorkspaceTabForLegacyPackageTab('diff'), 'diff');
  assert.equal(runWorkspaceTabForLegacyPackageTab('files'), 'files');
  assert.equal(runWorkspaceTabForLegacyPackageTab('timeline'), 'timeline');
  assert.equal(runWorkspaceTabForLegacyPackageTab(''), 'evidence');
  assert.equal(runWorkspaceTabForLegacyPackageTab('unknown'), 'evidence');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeGlobalFilters,
  projectMatchesGlobalFilter,
} from './project-filter.js';

test('projectMatchesGlobalFilter treats farmslot and farmslot-farm as aliases', () => {
  assert.equal(projectMatchesGlobalFilter('farmslot', ['farmslot-farm']), true);
  assert.equal(projectMatchesGlobalFilter('farmslot-farm', ['farmslot']), true);
  assert.equal(projectMatchesGlobalFilter('metamask-mobile-farm', ['farmslot-farm']), false);
  assert.equal(projectMatchesGlobalFilter('farmslot', []), true);
});

test('normalizeGlobalFilters migrates legacy farmslot chip to farmslot-farm', () => {
  assert.deepEqual(
    normalizeGlobalFilters({ projects: ['farmslot', 'metamask-mobile-farm'], machines: [] }),
    { projects: ['farmslot-farm', 'metamask-mobile-farm'], machines: [] },
  );
});
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultTargetProjectsForGlobalFilters, syncedDraftProject } from './planning-projects.js';

test('draft project follows a single global project filter', () => {
  assert.equal(
    syncedDraftProject({
      currentProject: 'metamask-extension-farm',
      availableProjects: ['metamask-extension-farm', 'metamask-mobile-farm'],
      globalProjects: ['metamask-mobile-farm'],
    }),
    'metamask-mobile-farm',
  );
});

test('draft project keeps a deliberate current project without a single global project filter', () => {
  assert.equal(
    syncedDraftProject({
      currentProject: 'custom-farm',
      availableProjects: ['metamask-extension-farm', 'metamask-mobile-farm'],
      globalProjects: ['metamask-extension-farm', 'metamask-mobile-farm'],
      fallbackProjects: ['unassigned'],
    }),
    'custom-farm',
  );
});

test('draft project treats configured fallback projects as unset', () => {
  assert.equal(
    syncedDraftProject({
      currentProject: 'unassigned',
      availableProjects: ['metamask-core-farm'],
      globalProjects: [],
      fallbackProjects: ['unassigned'],
    }),
    'metamask-core-farm',
  );
});

test('default target projects prefill only a single global filter', () => {
  assert.deepEqual(defaultTargetProjectsForGlobalFilters(['farmslot-farm']), ['farmslot-farm']);
  assert.deepEqual(
    defaultTargetProjectsForGlobalFilters(['farmslot-farm', 'metamask-mobile-farm']),
    [],
  );
  assert.deepEqual(defaultTargetProjectsForGlobalFilters([]), []);
  assert.deepEqual(defaultTargetProjectsForGlobalFilters(['farmslot-farm', 'farmslot-farm']), [
    'farmslot-farm',
  ]);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { syncedDraftProject } from './planning-projects.js';

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

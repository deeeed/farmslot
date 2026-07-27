import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  concretePlanningProjects,
  syncedDraftProject,
  syncedDraftTargetProjects,
} from './planning-projects.js';

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

test('draft target projects follow a single filter', () => {
  assert.deepEqual(
    syncedDraftTargetProjects({
      currentTargets: [],
      concreteGlobalProjects: ['farmslot-farm'],
      preserveCurrentTargets: false,
    }),
    ['farmslot-farm'],
  );
});

test('draft target projects clear automatic targets for multiple filters', () => {
  assert.deepEqual(
    syncedDraftTargetProjects({
      currentTargets: ['operator-selected-farm'],
      concreteGlobalProjects: ['farmslot-farm', 'metamask-mobile-farm'],
      preserveCurrentTargets: false,
    }),
    [],
  );
});

test('draft target projects remain unchanged without filters', () => {
  assert.deepEqual(
    syncedDraftTargetProjects({
      currentTargets: ['operator-selected-farm'],
      concreteGlobalProjects: [],
      preserveCurrentTargets: false,
    }),
    ['operator-selected-farm'],
  );
});

test('draft target projects preserve operator selections', () => {
  assert.deepEqual(
    syncedDraftTargetProjects({
      currentTargets: ['operator-selected-farm'],
      concreteGlobalProjects: ['farmslot-farm', 'metamask-mobile-farm'],
      preserveCurrentTargets: true,
    }),
    ['operator-selected-farm'],
  );
});

test('draft target projects preserve an explicit empty selection', () => {
  assert.deepEqual(
    syncedDraftTargetProjects({
      currentTargets: [],
      concreteGlobalProjects: ['farmslot-farm'],
      preserveCurrentTargets: true,
    }),
    [],
  );
});

test('capture reset replaces prior explicit targets with current filter defaults', () => {
  assert.deepEqual(
    syncedDraftTargetProjects({
      currentTargets: ['operator-selected-farm', 'another-farm'],
      concreteGlobalProjects: ['farmslot-farm'],
      preserveCurrentTargets: false,
    }),
    ['farmslot-farm'],
  );
});

test('concrete planning projects normalize filters', () => {
  assert.deepEqual(
    concretePlanningProjects(['global', 'unassigned', ' farmslot-farm ', 'farmslot-farm', '']),
    ['farmslot-farm'],
  );
});

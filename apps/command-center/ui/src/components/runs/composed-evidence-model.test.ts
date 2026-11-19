import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunEvidenceFlow, RunEvidenceFlowNode } from '@farmslot/adapter-sdk/evidence';
import { validViewRoute } from '@farmslot/protocol/surfaces/view-links';

import {
  composedEvidenceNode,
  composedEvidenceOccurrenceKey,
  composedEvidencePositionFromHash,
  composedEvidenceRecipeGroup,
  composedEvidenceSelectionHash,
} from './composed-evidence-model.js';

const sharedNode: RunEvidenceFlowNode = {
  id: '$root',
  parentId: null,
  recipeRef: 'root',
  nodeId: null,
  label: 'Root',
  action: 'recipe',
  children: ['first', 'second'],
  entry: 'first',
  teardown: null,
  next: null,
  cases: {},
  default: null,
  claimIds: [],
  depth: 0,
  breadcrumbIds: ['$root'],
  status: 'running',
  occurrences: [],
};

const flow: RunEvidenceFlow = {
  version: 1,
  recipeRunId: 'attempt#2',
  rootId: '$root',
  activeId: 'second',
  nodes: [
    sharedNode,
    ...['first', 'second'].map(
      (id): RunEvidenceFlowNode => ({
        ...sharedNode,
        id,
        parentId: '$root',
        nodeId: id,
        label: 'Repeat',
        children: [],
        entry: null,
        depth: 1,
        breadcrumbIds: ['$root', id],
      }),
    ),
  ],
  progress: { current: 1, completed: 0, total: null, remaining: null, qualification: 'unknown' },
};

test('a linked call is scoped to its gateway run and recipe execution', () => {
  const hash = composedEvidenceSelectionHash(
    'gateway/run',
    { recipeRunId: flow.recipeRunId, invocationId: 'first' },
    '#runs?run=abc&tab=evidence',
  );
  const position = composedEvidencePositionFromHash('gateway/run', hash);
  assert.deepEqual(position, { recipeRunId: flow.recipeRunId, invocationId: 'first' });
  assert.equal(composedEvidenceNode(flow, position)?.id, 'first');
  assert.equal(composedEvidencePositionFromHash('other-run', hash), null);
  assert.equal(composedEvidenceNode({ ...flow, recipeRunId: 'prior' }, position)?.id, 'second');
  assert.ok(hash.includes('tab=evidence'));
  assert.equal(validViewRoute(hash), true);
});

test('a legacy or unresolved selection falls back to the SDK active node then root', () => {
  assert.equal(composedEvidenceNode(flow, null)?.id, 'second');
  assert.equal(composedEvidenceNode({ ...flow, activeId: null }, null)?.id, '$root');
  assert.equal(composedEvidenceNode(null, null), undefined);
  assert.notEqual(
    composedEvidenceOccurrenceKey({ recipeRunId: 'current', traceIndex: 1 }),
    composedEvidenceOccurrenceKey({ recipeRunId: 'retained', traceIndex: 1 }),
  );
});

test('a call link restores a known non-default recipe group', () => {
  const groups = [
    { id: 'current-artifacts', recipeRunId: null },
    { id: 'qa-default', recipeRunId: 'attempt#1' },
    { id: 'live-run:request-id', recipeRunId: flow.recipeRunId },
  ];
  const link = { recipeRunId: flow.recipeRunId, invocationId: 'first' };
  assert.equal(composedEvidenceRecipeGroup(groups, link, 'qa-default'), 'live-run:request-id');
  assert.equal(
    composedEvidenceRecipeGroup(groups, { ...link, recipeRunId: 'missing' }, 'qa-default'),
    undefined,
  );
  assert.equal(composedEvidenceRecipeGroup(groups, null, 'qa-default'), undefined);
});

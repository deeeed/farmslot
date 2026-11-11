import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, Run } from '@farmslot/protocol';

import { litText } from '../../testing/lit-text.js';

import {
  renderReviewExecutionLocation,
  reviewExecutionLocation,
  reviewExecutionLocations,
} from './review-execution-location.js';

type PlacementRun = Parameters<typeof reviewExecutionLocations>[0];
const workspace: NonNullable<Run['reviewWorkspace']> = {
  workspaceId: 'workspace-123',
  machine: 'macpro',
  executionNodeId: 'macpro',
  checkoutPath: '/retained/review/source',
  taskPath: '/retained/review/task',
  artifactPath: '/retained/review/artifacts',
};
const reviewer: AgentContext = {
  id: 'rev-one',
  role: 'review',
  label: 'Reviewer',
  status: 'working',
  runId: 'run-one',
  slotId: 'mini-mmt-1',
  executionLocation: { machine: 'mini', checkoutPath: '/Volumes/FD/original-checkout' },
};

test('slot-free review exposes the retained workspace in selectable visible text', () => {
  const run: PlacementRun = { reviewWorkspace: workspace };
  const location = reviewExecutionLocation(run, { ...reviewer, slotId: null });
  assert(location);
  assert.equal(location.slotId, undefined);
  const rendered = litText(renderReviewExecutionLocation(location));
  assert.match(rendered, /macpro/);
  assert.match(rendered, /Workspace .*workspace-123/);
  assert.match(rendered, /review-checkout-path/);
  assert.match(rendered, />\/retained\/review\/source<\/code\s*>/);
});

test('finished and cleaned workspaces keep their original checkout and mark cleanup', () => {
  const [location] = reviewExecutionLocations({
    reviewWorkspace: { ...workspace, cleanedAt: '2026-11-12T00:00:00Z' },
  });
  assert.equal(location.checkoutPath, workspace.checkoutPath);
  assert.match(litText(renderReviewExecutionLocation(location)), /cleaned/);
});

test('pipeline reviewer placement survives completion and fleet slot reuse', () => {
  const locations = reviewExecutionLocations({
    agentContexts: [{ ...reviewer, status: 'complete' }],
  });
  assert.deepEqual(locations, [
    {
      source: 'slot',
      machine: 'mini',
      slotId: 'mini-mmt-1',
      checkoutPath: '/Volumes/FD/original-checkout',
    },
  ]);
  assert.match(litText(renderReviewExecutionLocation(locations[0])), /mini · mini-mmt-1/);
});

test('different reviewers retain their own placement, identical placements share one header entry', () => {
  const other: AgentContext = {
    ...reviewer,
    id: 'rev-two',
    slotId: 'macpro-mmt-1',
    executionLocation: { machine: 'macpro', checkoutPath: '/other/source' },
  };
  const locations = reviewExecutionLocations({
    agentContexts: [
      reviewer,
      { ...reviewer, id: 'rev-same' },
      other,
      { ...reviewer, id: 'worker', role: 'primary' },
    ],
  });
  assert.equal(locations.length, 2);
  assert.equal(locations[1].checkoutPath, '/other/source');
});

test('legacy reviews show recorded slot and node without inventing a checkout', () => {
  const legacy = {
    ...reviewer,
    executionLocation: undefined,
    nativeSession: {
      sessionId: 'native-one',
      executionNodeId: 'mini',
      ownerPrincipalId: 'owner',
      leaseId: 'lease',
      commandId: 'command',
    },
  };
  assert.deepEqual(reviewExecutionLocation({}, legacy), {
    source: 'slot',
    machine: 'mini',
    slotId: 'mini-mmt-1',
    checkoutPath: undefined,
  });
  assert.equal(
    reviewExecutionLocation(
      {},
      {
        ...legacy,
        slotId: null,
        nativeSession: { ...legacy.nativeSession, executionNodeId: 'local' },
      },
    ),
    undefined,
  );
});

test('allocation target is not presented as an allocated workspace', () => {
  assert.deepEqual(reviewExecutionLocations({ reviewWorkspaceTarget: { machine: 'macpro' } }), []);
});

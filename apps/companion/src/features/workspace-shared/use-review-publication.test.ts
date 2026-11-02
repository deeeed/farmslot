import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';

import type { Run } from '@farmslot/protocol';
import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

import { Methods } from '../../../../../packages/protocol/src/rpc/registry';
import { savedReviewView } from '../../../../../packages/protocol/src/runs/review-chain';
import { mountHook } from '../../hooks/hook-harness.fixtures';

function run(flowType: Run['flowType']): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    lane: 'production',
    flowType,
    status: 'done',
    project: 'example-mobile',
    ticketOrPr: 'PR-1',
    summary: 'Run',
    slotId: 'slot-1',
    branch: 'fix/run-1',
    taskFile: '/repo/TASK.md',
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

type SavedState = {
  savedLoading: boolean;
  savedError: string | undefined;
  readDisabled: boolean;
};

function isSavedState(value: unknown): value is SavedState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'savedLoading' in value &&
    'savedError' in value &&
    'readDisabled' in value
  );
}

/** The saved-review states Run Detail's panel renders for `shown`, given the run.get read. */
function savedState(shown: Run, observation: ResourceQueryState, status = 'connected') {
  const hook = mountHook<[Run, null, 'saved']>(
    new URL('./use-review-publication.ts', import.meta.url),
    'useReviewPublication',
    {
      'react-native': { Linking: { openURL: async () => undefined } },
      '@farmslot/protocol': {
        createReviewCuration: () => null,
        Methods,
        reviewCurationView: () => null,
        reviewPostingFingerprint: () => '',
        savedReviewView,
        toggleReviewFinding: () => null,
      },
      '@farmslot/protocol/client-cache': {
        resourceQuery: (method: string, params: unknown) => ({
          id: `${method}:${JSON.stringify(params)}`,
        }),
      },
      '@farmslot/review-dispatch': {
        refreshReviewGateView: async () => ({ error: null }),
        reviewGateRefreshBlocksPost: () => false,
      },
      '../../hooks/useResourceQuery': { useResourceQuery: () => observation },
      '../../lib/connection-authority': { currentFarmConnection: () => () => true },
      '../../lib/resource-cache': { getResourceCache: () => undefined },
      '../../lib/resource-read-status': {
        readErrorMessage: (read: ResourceQueryState) => read.error?.message,
      },
      '../../lib/review-curation': {
        loadReviewFindingSource: async () => null,
        reviewFindingSourceRequest: () => null,
      },
      '../../lib/review-publication': { reviewPublicationView: () => null },
      '../../lib/run-collections': { assertNativeRunReady: () => undefined },
      '../../store/connection': {
        useConnectionStore: (select: (state: Record<string, unknown>) => unknown) =>
          select({ client: null, activeProfileId: 'profile', authorityEpoch: 1, status }),
      },
      '../../store/held-connection': { heldConnectionCurrent: () => status === 'connected' },
    },
  );
  const result = hook.render(shown, null, 'saved');
  if (!isSavedState(result)) throw new Error('useReviewPublication returned no saved state');
  return result;
}

const loading: ResourceQueryState = { status: 'loading' };
const failed: ResourceQueryState = {
  status: 'error',
  error: { code: 'READ_FAILED', message: 'Request run.get timed out' },
};

test('a run with no saved review gets no saved-review card while run.get loads or fails', () => {
  for (const observation of [loading, failed]) {
    const state = savedState(run('fix-bug'), observation);
    assert.equal(state.savedLoading, false);
    assert.equal(state.savedError, undefined);
  }
});

test('a finished review run gets the loading card, then a retry that can be pressed', () => {
  assert.equal(savedState(run('review-pr'), loading).savedLoading, true);
  const afterFailure = savedState(run('review-pr'), failed);
  assert.equal(afterFailure.savedError, 'Request run.get timed out');
  assert.equal(afterFailure.readDisabled, false);
  assert.equal(savedState(run('review-pr'), failed, 'disconnected').readDisabled, true);
});

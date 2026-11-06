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
function publicationHook(
  observation: ResourceQueryState,
  status = 'connected',
  dependencies: Record<string, unknown> = {},
) {
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
      ...dependencies,
    },
  );
  return hook;
}

function savedState(shown: Run, observation: ResourceQueryState, status = 'connected') {
  const hook = publicationHook(observation, status);
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

test('refresh stays pending for the server result and reports a disconnect', async () => {
  const shown = run('review-pr');
  const calls: Array<{ method: string; timeout: number | null | undefined }> = [];
  let disconnect: ((error: Error) => void) | undefined;
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const client = {
    request: (method: string, _params: unknown, timeout?: number | null) => {
      calls.push({ method, timeout });
      return new Promise((_resolve, reject) => {
        disconnect = reject;
      });
    },
  };
  const hook = publicationHook({ status: 'ready', data: { run: shown } }, 'connected', {
    '../../store/connection': {
      useConnectionStore: (select: (state: Record<string, unknown>) => unknown) =>
        select({
          client,
          activeProfileId: 'profile',
          authorityEpoch: 1,
          status: 'connected',
        }),
    },
    '@farmslot/review-dispatch': {
      refreshReviewGateView: async (refresh: () => Promise<unknown>) => {
        try {
          await refresh();
          return { error: null };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        } finally {
          finish?.();
        }
      },
      reviewGateRefreshBlocksPost: (pending: boolean, error?: string) => pending || Boolean(error),
    },
  });
  const render = () => {
    const result = hook.render(shown, null, 'saved');
    if (
      !result ||
      typeof result !== 'object' ||
      !('refresh' in result) ||
      typeof result.refresh !== 'function' ||
      !('busy' in result) ||
      !('error' in result)
    )
      throw new Error('Missing refresh state');
    return { refresh: result.refresh, busy: result.busy, error: result.error };
  };
  try {
    render().refresh();
    assert.deepEqual(calls, [{ method: Methods.RUN_REFRESH_REVIEW_GATE, timeout: null }]);
    assert.equal(render().busy, true);
    assert(disconnect);
    disconnect(new Error('Gateway disconnected'));
    await finished;
    // Drain the dispatch and controller continuations without a wall-clock wait.
    for (let step = 0; step < 10 && render().busy; step += 1) await Promise.resolve();
    assert.equal(render().busy, false);
    assert.equal(render().error, 'Gateway disconnected');
  } finally {
    hook.cleanup();
  }
});

import type { FleetStatus, RunGetResult } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { useConnectionStore } from '../store/connection';
import { useDecisionStore } from '../store/decisions';
import { useFleetStore } from '../store/fleet';
import { useRunStore } from '../store/runs';

import { nativeDecisionsQuery, nativeFleetQuery, NativeRunCollections } from './gateway-run-sync';
import { notifyDecision } from './notifications';
import {
  getResourceCache,
  getResourceWorkspaceAccess,
  getResourceWorkspaceKey,
  subscribeResourceCache,
} from './resource-cache';

const collections = new NativeRunCollections((snapshot) => {
  useFleetStore.setState({
    observation: snapshot.fleet,
    fleet: snapshot.fleet.data?.fleet ?? null,
    loading: snapshot.fleet.status === 'loading',
  });
  useRunStore.setState({
    observation: snapshot.runs,
    runs: snapshot.runs.data?.runs ?? [],
    activeLoading: snapshot.active.status === 'loading',
    historyLoading: snapshot.history?.status === 'loading',
    historyLoaded: Boolean(snapshot.history && snapshot.history.status !== 'loading'),
  });
  const previous = useDecisionStore.getState().observation;
  useDecisionStore.setState({
    observation: snapshot.decisions,
    decisions: snapshot.decisions.data?.decisions ?? [],
  });
  if (
    previous.data &&
    snapshot.decisions.status === 'ready' &&
    useConnectionStore.getState().status === 'connected'
  ) {
    const ids = new Set(previous.data.decisions.map(({ id }) => id));
    for (const decision of snapshot.decisions.data?.decisions ?? [])
      if (!ids.has(decision.id)) {
        void notifyDecision(decision).catch((error: unknown) => {
          useConnectionStore.setState({
            lastSyncError: `Decision notification failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
      }
  }
});

function bind(): void {
  const state = useConnectionStore.getState();
  const farm =
    getResourceWorkspaceAccess() === 'farm' ||
    (state.status === 'connected' && state.workspaceAccess === 'farm');
  collections.bind(
    farm && !state.signedOut ? getResourceCache() : undefined,
    getResourceWorkspaceKey(),
  );
}

export function initializeNativeRunCollections(): () => void {
  const stopCache = subscribeResourceCache(bind);
  const stopConnection = useConnectionStore.subscribe(bind);
  bind();
  return () => {
    stopCache();
    stopConnection();
    collections.dispose();
  };
}

export const openNativeRunHistory = () => collections.openHistory();
export const retryNativeDecisions = () => collections.retryDecisions();

export function assertNativeFleetReady(): FleetStatus {
  const state = useConnectionStore.getState();
  const observed = getResourceCache()?.read(nativeFleetQuery);
  if (
    state.status !== 'connected' ||
    state.client?.connectionState !== 'connected' ||
    getResourceWorkspaceAccess() !== 'farm' ||
    observed?.status !== 'ready' ||
    !observed.data ||
    observed.data.fleet.stale
  )
    throw new Error('Wait for a current fleet read before acting.');
  return observed.data.fleet;
}

export function assertNativeDecisionReady(decisionId: string): void {
  const state = useConnectionStore.getState();
  const observed = getResourceCache()?.read(nativeDecisionsQuery);
  if (
    state.status !== 'connected' ||
    state.client?.connectionState !== 'connected' ||
    state.workspaceAccess !== 'farm' ||
    observed?.status !== 'ready' ||
    !observed.data?.decisions.some(({ id }) => id === decisionId)
  )
    throw new Error('Wait for current decisions before acting.');
}

export function assertNativeRunReady(
  runId: string,
  expected?: RunGetResult['run'],
): RunGetResult['run'] {
  const cache = getResourceCache();
  const state = useConnectionStore.getState();
  const observed = cache?.read(resourceQuery<RunGetResult>('run.get', { runId }));
  if (
    state.client?.connectionState !== 'connected' ||
    getResourceWorkspaceAccess() !== 'farm' ||
    observed?.status !== 'ready' ||
    observed.data?.run.id !== runId
  )
    throw new Error('Wait for the current run before acting.');
  if (expected && observed.data.run !== expected)
    throw new Error('The run changed. Review it again before acting.');
  return observed.data.run;
}

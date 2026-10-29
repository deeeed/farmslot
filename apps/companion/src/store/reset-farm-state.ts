import { useDecisionStore } from './decisions';
import { useFilterStore } from './filters';
import { useFleetStore } from './fleet';
import { usePRStore } from './prs';
import { useRunFilterStore } from './run-filters';
import { useRunStore } from './runs';

export function resetFarmState() {
  useFleetStore.setState({ fleet: null, observation: { status: 'loading' }, loading: false });
  useRunStore.setState({
    runs: [],
    observation: { status: 'loading' },
    activeLoading: false,
    historyLoading: false,
    historyLoaded: false,
  });
  // Production PRs retire with ResourceCacheOwner. Clear the separate screenshot/test fixture too.
  usePRStore.setState({ prs: [], updatedAt: null, loading: false, lastError: null });
  useDecisionStore.setState({ decisions: [], observation: { status: 'loading' } });
  useFilterStore.setState((state) => ({
    filters: { projects: [], machines: [] },
    availableProjects: [],
    availableMachines: [],
    availableSources: [],
    initialized: true,
    initializing: false,
    mutationVersion: state.mutationVersion + 1,
    lastPersistenceError: null,
  }));
  useRunFilterStore.getState().resetForAccount();
}

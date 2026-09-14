import { useDecisionStore } from './decisions';
import { useFilterStore } from './filters';
import { useFleetStore } from './fleet';
import { usePRStore } from './prs';
import { useRunFilterStore } from './run-filters';
import { useRunStore } from './runs';

export function resetFarmState() {
  useFleetStore.setState({ fleet: null, loading: false });
  useRunStore.setState({
    runs: [],
    activeLoading: false,
    historyLoading: false,
    historyLoaded: false,
  });
  usePRStore.setState({ prs: [], updatedAt: null, loading: false, lastError: null });
  useDecisionStore.setState({ decisions: [] });
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

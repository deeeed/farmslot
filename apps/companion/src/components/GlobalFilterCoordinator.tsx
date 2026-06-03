import { useEffect } from 'react';

import { useDecisionStore } from '../store/decisions';
import { buildGlobalFilterSources, useFilterStore } from '../store/filters';
import { useFleetStore } from '../store/fleet';
import { useRunStore } from '../store/runs';

export function GlobalFilterCoordinator() {
  const decisions = useDecisionStore((s) => s.decisions);
  const fleet = useFleetStore((s) => s.fleet);
  const runs = useRunStore((s) => s.runs);
  const initFilters = useFilterStore((s) => s.init);
  const setAvailable = useFilterStore((s) => s.setAvailable);

  useEffect(() => {
    initFilters();
  }, [initFilters]);

  useEffect(() => {
    setAvailable(
      buildGlobalFilterSources({
        slots: fleet?.slots ?? [],
        runs,
        decisions,
      }),
    );
  }, [decisions, fleet, runs, setAvailable]);

  return null;
}

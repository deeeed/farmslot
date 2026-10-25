import { useMemo } from 'react';

import { useRoadmapController } from '../planning/use-roadmap-controller';

import { useSharedViewSelection } from './QuickActionsProvider';

/** Extracts displayed selection without changing the planning reader or its actions. */
export function useRoadmapViewSharing() {
  const screen = useRoadmapController();
  const { stage, search, deliveryFilter, deliveredExpanded } = screen.state;
  useSharedViewSelection(
    useMemo(
      () => ({
        pathname: '/roadmap',
        params: {
          nativeStage: stage,
          nativeSearch: search,
          nativeDelivery: deliveryFilter,
          nativeDelivered: deliveredExpanded ? '1' : '0',
        },
      }),
      [stage, search, deliveryFilter, deliveredExpanded],
    ),
  );
  return screen;
}

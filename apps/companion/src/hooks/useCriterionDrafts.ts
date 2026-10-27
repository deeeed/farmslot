import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { CriterionDraftModel } from '@farmslot/review-dispatch';

/** Native storage for the same authority-scoped gate draft used on the web. */
export function useCriterionDrafts(scope: string, snapshot: string): CriterionDraftModel {
  const model = useMemo(() => new CriterionDraftModel(AsyncStorage), []);
  // Rebind before rendering so another owner never sees the previous draft for a frame.
  model.setScope(scope, snapshot);
  const subscribe = useCallback((changed: () => void) => model.subscribe(changed), [model]);
  useSyncExternalStore(
    subscribe,
    () => model.viewVersion,
    () => model.viewVersion,
  );
  useEffect(() => () => model.deactivate(), [model]);
  useEffect(() => model.setScope(scope, snapshot), [model, scope, snapshot]);
  return model;
}

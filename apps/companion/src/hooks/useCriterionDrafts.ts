import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo, useReducer } from 'react';

import { CriterionDraftModel } from '@farmslot/review-dispatch';

/** Native storage for the same authority-scoped gate draft used on the web. */
export function useCriterionDrafts(scope: string, snapshot: string): CriterionDraftModel {
  const model = useMemo(() => new CriterionDraftModel(AsyncStorage), []);
  const [, changed] = useReducer((value: number) => value + 1, 0);
  useEffect(() => model.subscribe(changed), [model]);
  useEffect(() => model.setScope(scope, snapshot), [model, scope, snapshot]);
  return model;
}

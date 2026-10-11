import { useEffect, useReducer, useState } from 'react';

import {
  Methods,
  type RunnerModelCatalogResult,
  type RunnerVisibleModelsGetResult,
} from '@farmslot/protocol';
import {
  createReviewDispatchCatalog,
  type ReviewDispatchViewModel,
} from '@farmslot/review-dispatch';

import { useConnectionStore } from '../../store/connection';

export function useReviewDispatchCatalog(model: ReviewDispatchViewModel, onChange?: () => void) {
  const client = useConnectionStore((state) => state.client);
  const status = useConnectionStore((state) => state.status);
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => model.subscribe(refresh), [model]);

  useEffect(() => {
    if (!client || status !== 'connected') return;
    let active = true;
    const generation = client.connectionGeneration;
    void client
      .request<RunnerVisibleModelsGetResult>(Methods.RUNNER_VISIBLE_MODELS_GET, {})
      .then(async (visible) => {
        const catalogs = await Promise.all(
          visible.runners.map(({ runner }) =>
            client.request<RunnerModelCatalogResult>(Methods.RUNNER_MODEL_CATALOG, { runner }),
          ),
        );
        if (!active || generation !== client.connectionGeneration) return;
        model.setCatalog(
          createReviewDispatchCatalog({
            runnerIds: visible.runners.map(({ runner }) => runner),
            visibleModels: visible.runners,
            runnerModels: catalogs,
          }),
        );
        setError(null);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [client, model, status]);

  const change = (edit: () => void) => {
    try {
      edit();
      setError(null);
      onChange?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return { error, change };
}

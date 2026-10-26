import { useEffect, useMemo, useReducer, useState, useSyncExternalStore } from 'react';

import {
  Methods,
  type RunnerModelCatalogResult,
  type RunnerVisibleModelsGetResult,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';
import {
  createReviewDispatchCatalog,
  type ReviewDispatchViewModel,
} from '@farmslot/review-dispatch';

import { useResourceQueries, useResourceQuery } from '../../hooks/useResourceQuery';
import { getResourceNativeOwnerId, subscribeResourceCache } from '../../lib/resource-cache';
import { useWorkspaceRenderAccess } from '../../lib/use-workspace-render-access';

export function useReviewDispatchCatalog(
  model: ReviewDispatchViewModel,
  onChange?: () => void,
  discover = true,
) {
  const access = useWorkspaceRenderAccess();
  const owner = useSyncExternalStore(
    subscribeResourceCache,
    getResourceNativeOwnerId,
    getResourceNativeOwnerId,
  );
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => model.subscribe(refresh), [model]);

  // Shared observations: gateway notices refresh preferences and catalogs; no per-view reads.
  const visibleQuery = useMemo(
    () =>
      discover && access === 'farm' && owner
        ? resourceQuery<RunnerVisibleModelsGetResult>(Methods.RUNNER_VISIBLE_MODELS_GET, {}, owner)
        : undefined,
    [access, discover, owner],
  );
  const visible = useResourceQuery(visibleQuery);
  const runnerIds = visible.data?.runners.map(({ runner }) => runner).join('\0') ?? '';
  const catalogQueries = useMemo(
    () =>
      (runnerIds ? runnerIds.split('\0') : []).map((runner) =>
        resourceQuery<RunnerModelCatalogResult>(Methods.RUNNER_MODEL_CATALOG, { runner }),
      ),
    [runnerIds],
  );
  const catalogs = useResourceQueries(catalogQueries);

  useEffect(() => {
    const runners = visible.data?.runners;
    if (!runners) return;
    model.setCatalog(
      createReviewDispatchCatalog({
        runnerIds: runners.map(({ runner }) => runner),
        visibleModels: runners,
        runnerModels: catalogs.flatMap((state) => (state.data ? [state.data] : [])),
      }),
    );
  }, [catalogs, model, visible.data]);

  const change = (edit: () => void) => {
    try {
      edit();
      setError(null);
      onChange?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const readError =
    visible.error?.message ?? catalogs.find((state) => state.error)?.error?.message ?? null;
  return { error: error ?? readError, change };
}

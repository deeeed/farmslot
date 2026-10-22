const view = document.querySelector('slot-view');
const queries = view?._runQueries;
if (!view || !queries) return { mounted: false };
const cacheUrl = performance
  .getEntriesByType('resource')
  .map((entry) => entry.name)
  .filter((name) => new URL(name).pathname === '/src/resource-cache.ts')
  .at(-1);
if (!cacheUrl) throw new Error('The current resource cache module did not load');
const cache = (await import(cacheUrl)).getResourceCache();
const reads = Object.fromEntries(
  ['slot', 'pinned', 'recipes'].map((key) => {
    const controller = queries[key];
    const query = Reflect.get(controller, 'query');
    if (query && cache?.read(query) !== controller.state)
      throw new Error('Inspect the canonical query owning the actual slot run');
    return [
      key,
      {
        query: query && { id: query.id, method: query.method, params: query.params },
        status: controller.state.status,
        observedAt: controller.state.observedAt,
        error: controller.state.error?.message,
        resourceState: controller.state.resourceState,
      },
    ];
  }),
);
const run = view._linkedRun;
const lifecycle = view.querySelector('.sv-lifecycle-badge');
const lifecycleRect = lifecycle?.getBoundingClientRect();
return {
  mounted: true,
  slotId: view.slotId,
  slotLifecycle: view._slot?.lifecycle,
  renderedLifecycle: lifecycle?.textContent?.trim(),
  lifecycleVisible: Boolean(
    lifecycleRect &&
    lifecycleRect.width > 0 &&
    lifecycleRect.height > 0 &&
    lifecycleRect.top >= 0 &&
    lifecycleRect.right <= innerWidth &&
    lifecycleRect.bottom <= innerHeight,
  ),
  slotCurrentRunId: view._slot?.currentRunId ?? null,
  runId: run?.id,
  runStatus: run?.status,
  tags: run?.tags,
  runCanonical: Boolean(
    run && (run === queries.slot.state.data?.run || run === queries.pinned.state.data?.run),
  ),
  recipesCanonical: view._recipeRuns === queries.recipes.state.data?.recipeRuns,
  runCurrent: view._linkedRunCurrent,
  recipesCurrent: view._recipeRunsCurrent,
  actionsBlocked: view._runActionsBlocked,
  contextBlocked: view._isRecoveryBlocked,
  reads,
  recipeGroups: view._recipeRuns.map((group) => ({
    id: group.id,
    label: group.label,
    recipe: Boolean(group.recipeJson),
    artifacts: group.artifactManifest.map((entry) => entry.path),
  })),
  titleRendered: Boolean(run && view.textContent.includes(run.ticketOrPr)),
  mirrorDisabled: view.querySelector('[data-testid="slot-recipe-refresh-mirror"]')?.disabled,
  mirrorBusy: view._mirrorRefreshing,
  mirrorFeedback: view._mirrorRefreshFeedback,
  freshness: view.querySelector('[data-slot-run-freshness]')?.textContent?.trim(),
  runError: view._linkedRunReadError,
  errorRendered: view.querySelector('[data-slot-run-read-error]')?.textContent?.trim(),
  recipesError: view._recipeRunsError,
};

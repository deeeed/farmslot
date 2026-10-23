const detail = document.querySelector('run-detail');
if (!detail?.shadowRoot) return { mounted: false };
const moduleUrl = (path) =>
  performance
    .getEntriesByType('resource')
    .map(({ name }) => name)
    .filter((name) => new URL(name).pathname === path)
    .at(-1);
const cacheUrl = moduleUrl('/src/resource-cache.ts');
const gatewayUrl = moduleUrl('/src/gateway-client.ts');
if (!cacheUrl || !gatewayUrl) throw new Error('Inspect the active resource owner and gateway');
const cache = (await import(cacheUrl)).getResourceCache();
const { gateway } = await import(gatewayUrl);
const controller = Reflect.get(detail, 'progressQuery');
if (!cache || !controller?.belongsToWorkspace) return { mounted: true, query: false };
const query = Reflect.get(controller, 'query');
if (!query) return { mounted: true, query: false };
if (cache.read(query) !== controller.state)
  throw new Error('Inspect canonical run-detail progress');
const root = detail.shadowRoot;
const pipeline = root.querySelector('run-pipeline');
const strip = pipeline?.shadowRoot?.querySelector('run-checklist-progress');
const selected = Reflect.get(detail, 'selectedProgressQuery');
const selectedQuery = Reflect.get(selected, 'query');
const inspector = root.querySelector('step-inspector');
const tracker = inspector?.shadowRoot?.querySelector('[data-testid="step-task-progress"]');
const errorText = root.querySelector('[data-run-progress-error]')?.textContent ?? '';
const staleText = root.querySelector('[data-run-progress-freshness="stale"]')?.textContent ?? '';
return {
  mounted: true,
  hash: location.hash,
  selectedStep: detail.selectedStep?.name,
  runId: detail.runId,
  connectionId: gateway.resourceConnectionId,
  connectionState: gateway.connectionState,
  canonical:
    pipeline?.taskProgress === controller.state.data?.structured &&
    detail.taskProgress === controller.state.data?.structured,
  freshness: controller.state.status,
  observedAt: controller.state.observedAt,
  resourceState: controller.state.resourceState,
  markdown: controller.state.data?.markdown,
  ledgerError: controller.state.data?.acceptanceStatusError,
  completed: controller.state.data?.structured?.completedSteps,
  total: controller.state.data?.structured?.totalSteps,
  error: controller.state.error?.message,
  errorRendered: Boolean(
    controller.state.error && errorText.includes(controller.state.error.message),
  ),
  staleRendered: Boolean(staleText.includes('Saved') && staleText.includes('old')),
  rendered: Boolean(pipeline?.getClientRects().length && strip?.getClientRects().length),
  selectedFreshness: selected.state.status,
  selectedObservedAt: selected.state.observedAt,
  selectedCanonical: Boolean(
    selectedQuery &&
    cache.read(selectedQuery) === selected.state &&
    inspector?.taskProgress === selected.state.data?.structured,
  ),
  selectedCompleted: selected.state.data?.structured?.completedSteps,
  selectedRendered: Boolean(tracker?.getClientRects().length),
  actionsBlocked: Reflect.get(detail, '_actionsBlocked').call(detail),
  text: strip?.shadowRoot?.textContent ?? '',
};

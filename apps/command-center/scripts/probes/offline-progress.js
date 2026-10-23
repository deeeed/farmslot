const list = document.querySelector('run-list');
if (!list?.shadowRoot) return { mounted: false };
const runId = new URLSearchParams(location.hash.split('?')[1]).get('progressRun');
const url = performance
  .getEntriesByType('resource')
  .map(({ name }) => name)
  .filter((name) => new URL(name).pathname === '/src/resource-cache.ts')
  .at(-1);
if (!url) throw new Error('Inspect the active shared cache');
const cache = (await import(url)).getResourceCache();
const gatewayUrl = performance
  .getEntriesByType('resource')
  .map(({ name }) => name)
  .filter((name) => new URL(name).pathname === '/src/gateway-client.ts')
  .at(-1);
if (!gatewayUrl) throw new Error('Inspect the active gateway connection');
const { gateway } = await import(gatewayUrl);
const controller = [...list.progressQueries.values()].find(
  (value) => value.query?.params.runId === runId,
);
if (!controller) return { mounted: true, query: false, runId };
const query = controller.query;
if (cache.read(query) !== controller.state)
  throw new Error('Inspect the canonical progress observation');
const row = [...list.shadowRoot.querySelectorAll('[data-row-id]')].find(
  (value) => value.getAttribute('data-row-id') === runId,
);
const pipeline = row?.querySelector('run-pipeline-mini');
const strip = pipeline?.shadowRoot?.querySelector('run-checklist-progress');
const text = strip?.shadowRoot?.textContent ?? '';
return {
  mounted: true,
  connectionId: gateway.resourceConnectionId,
  connectionState: gateway.connectionState,
  runId,
  canonical: pipeline?.taskProgress === controller.state.data?.structured,
  freshness: controller.state.status,
  observedAt: controller.state.observedAt,
  resourceState: controller.state.resourceState,
  markdown: controller.state.data?.markdown,
  ledgerError: controller.state.data?.acceptanceStatusError,
  completed: controller.state.data?.structured?.completedSteps,
  total: controller.state.data?.structured?.totalSteps,
  error: controller.state.error?.message,
  errorRendered: Boolean(controller.state.error && text.includes(controller.state.error.message)),
  staleRendered: Boolean(strip?.stale && text.includes('Saved checklist,')),
  rendered: Boolean(row?.getClientRects().length && strip?.getClientRects().length),
  text,
};

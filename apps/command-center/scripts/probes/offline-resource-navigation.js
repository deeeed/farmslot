const moduleUrl = (pathname) =>
  performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => new URL(name).pathname === pathname)
    .at(-1);
const stateUrl = moduleUrl('/src/state.ts');
const gatewayUrl = moduleUrl('/src/gateway-client.ts');
if (!stateUrl || !gatewayUrl) return { mounted: false, url: location.href };
const state = (await import(stateUrl)).getState();
const gateway = (await import(gatewayUrl)).gateway;
const diagnostics = await document
  .querySelector('farm-resource-store-notice')
  ?.resourceStoreDiagnostics();
return {
  mounted: true,
  url: location.href,
  documentStartedAt: performance.timeOrigin,
  connection: gateway.connectionState,
  connectionId: gateway.resourceConnectionId,
  status: state.runsObservation.status,
  observedAt: state.runsObservation.observedAt,
  rows: state.runs.length,
  workerStarts: performance.getEntriesByName('farmslot-resource-worker-start').length,
  diagnostics,
};

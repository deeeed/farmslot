// Read only safe connection metadata and real rendered indicator/layout props.
const modules = Array.from(__r.getModules().values());
const store = modules.find((m) => m.verboseName?.endsWith('/store/connection.ts'))?.publicModule
  .exports.useConnectionStore;
const state = store?.getState();
const indicators = [];
const seen = new Set();
function visit(fiber) {
  if (!fiber || seen.has(fiber)) return;
  seen.add(fiber);
  if (fiber.memoizedProps?.testID === 'gateway-offline-indicator') {
    indicators.push({ testID: fiber.memoizedProps.testID, style: fiber.memoizedProps.style });
  }
  visit(fiber.child);
  visit(fiber.sibling);
}
const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
for (const renderer of hook?.renderers?.keys() ?? [])
  for (const root of hook.getFiberRoots(renderer)) visit(root.current);
return {
  status: state?.status,
  health: state?.healthStatus,
  gatewayUrl: state?.gatewayUrl,
  recoveryEnabled: state?.client?.recoveryEnabled,
  connectionGeneration: state?.client?.connectionGeneration,
  indicators,
};

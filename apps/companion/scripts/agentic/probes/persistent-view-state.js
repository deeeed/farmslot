// Read the actual route and rendered round cards after user-driven native navigation.
const modules = Array.from(__r.getModules().values());
const exported = (suffix) =>
  modules.find((module) => module.verboseName?.endsWith(suffix))?.publicModule.exports;
const connection = exported('/store/connection.ts')?.useConnectionStore.getState();
const routeContext = modules.find((module) =>
  module.verboseName?.endsWith('/global-state/routeInfoContext.js'),
)?.publicModule.exports.RouteInfoContext;
let route;
const environment = exported('/lib/app-environment.ts')?.getCompanionEnvironment();
const cards = [];
const seen = new Set();
function visit(fiber) {
  if (!fiber || seen.has(fiber)) return;
  seen.add(fiber);
  if (fiber.memoizedProps?.activityState !== 0 && fiber.memoizedProps?.mode !== 'hidden') {
    if (fiber.type === routeContext || fiber.type?._context === routeContext)
      route = fiber.memoizedProps?.value;
    if (fiber.type?.name === 'ReviewRoundCard')
      cards.push({
        key: fiber.memoizedProps.card.round.key,
        round: fiber.memoizedProps.card.round.roundNumber,
        findings: fiber.memoizedProps.card.round.findings.length,
      });
    visit(fiber.child);
  }
  visit(fiber.sibling);
}
const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
for (const renderer of hook?.renderers?.keys() ?? [])
  for (const root of hook.getFiberRoots(renderer)) visit(root.current);
const profile = connection?.profiles?.find((entry) => entry.id === connection.activeProfileId);
return {
  connection: { status: connection?.status, principalId: connection?.principalId },
  pathname: route?.pathname,
  params: route?.params
    ? Object.fromEntries(
        Object.entries(route.params).filter(([key]) =>
          ['runId', 'panels', 'round', 'step', 'tab', 'diffPath', 'mediaIndex'].includes(key),
        ),
      )
    : undefined,
  environment: {
    appVersion: environment?.appVersion,
    appScheme: environment?.appScheme,
    runtimeVersion: environment?.runtimeVersion,
  },
  commandCenterConfigured: Boolean(profile?.commandCenterUrl),
  cards,
};

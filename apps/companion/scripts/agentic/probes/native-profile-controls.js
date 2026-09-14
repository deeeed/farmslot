const text = (value) =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : Array.isArray(value)
      ? value.map(text).join('')
      : value?.props
        ? text(value.props.children)
        : '';
const controls = [];
const seen = new Set();
const visit = (fiber) => {
  if (!fiber || seen.has(fiber)) return;
  seen.add(fiber);
  const props = fiber.memoizedProps;
  const hidden =
    props?.activityState === 0 || props?.mode === 'hidden' || props?.['aria-hidden'] === true;
  if (!hidden) {
    if (typeof props?.testID === 'string' && props.testID.startsWith('companion-native-')) {
      controls.push({
        id: props.testID,
        disabled: props.disabled ?? props.accessibilityState?.disabled,
        selected: props.accessibilityState?.selected,
        expanded: props.accessibilityState?.expanded,
        text: text(props.children),
        value: props.value ?? props.text,
      });
    }
    visit(fiber.child);
  }
  visit(fiber.sibling);
};
const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
if (!hook?.getFiberRoots) throw new Error('React native inspection is unavailable');
for (const renderer of hook.renderers.keys())
  for (const root of hook.getFiberRoots(renderer)) visit(root.current);
const loaded = Array.from(__r.getModules().values());
const connection = loaded
  .find((item) => item.verboseName?.endsWith('/store/connection.ts'))
  ?.publicModule.exports.useConnectionStore.getState();
const router = loaded.find((item) => item.verboseName?.endsWith('global-state/router-store.js'))
  ?.publicModule.exports.store;
return {
  controls,
  route: router?.getRouteInfo(),
  connection: {
    status: connection?.status,
    principalId: connection?.principalId,
    gatewayUrl: connection?.gatewayUrl,
    pending: [...(connection?.client?.pending?.keys() ?? [])],
  },
};

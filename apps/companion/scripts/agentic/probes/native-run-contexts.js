// Read-only proof after navigating through the real run or slot session controls.
const seen = new Set();
const screens = [];
function visit(fiber) {
  if (!fiber || seen.has(fiber)) return;
  seen.add(fiber);
  if (fiber.memoizedProps?.activityState !== 0 && fiber.memoizedProps?.mode !== 'hidden') {
    if (['NativeConversationScreen', 'SlotSessionTabs'].includes(fiber.type?.name))
      screens.push(fiber);
    visit(fiber.child);
  }
  visit(fiber.sibling);
}
const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
for (const renderer of hook.renderers.keys())
  for (const root of hook.getFiberRoots(renderer)) visit(root.current);
const screen = screens.find((fiber) => fiber.type.name === 'NativeConversationScreen');
const tabs = screens.find((fiber) => fiber.type.name === 'SlotSessionTabs');
if (!screen || !tabs)
  throw new Error('Slot must show the existing native conversation and peer tabs');
const vm = screen.memoizedProps.viewModel;
const props = tabs.memoizedProps;
const selected = props.nativeTabs.find(
  (tab) => tab.target.contextId === props.selectedNativeContextId,
);
if (!vm.connected || !vm.session || !selected || !vm.entries.length)
  throw new Error('The selected reviewer conversation has not loaded');
if (vm.session.id !== selected.target.binding.sessionId)
  throw new Error('Conversation does not match the selected native context');
return {
  runId: selected.target.runId,
  contextId: selected.target.contextId,
  sessionId: vm.session.id,
  executionNodeId: vm.session.executionNodeId,
  entries: vm.entries.length,
  writable: vm.writable,
  ownerReadOnly: selected.target.readOnly,
  error: vm.error,
  nativeTabs: props.nativeTabs.map((tab) => ({
    label: tab.label,
    contextId: tab.target.contextId,
  })),
  tmuxWindows: props.windows.map((window) => ({ index: window.index, name: window.name })),
};

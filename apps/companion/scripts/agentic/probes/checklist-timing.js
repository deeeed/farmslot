// Read-only native proof after opening an existing run's Timeline.
const panels = [];
const seen = new Set();
function visit(fiber) {
  if (!fiber || seen.has(fiber)) return;
  seen.add(fiber);
  if (fiber.memoizedProps?.activityState !== 0 && fiber.memoizedProps?.mode !== 'hidden') {
    if (fiber.type?.name === 'TaskProgressPanel') panels.push(fiber);
    visit(fiber.child);
  }
  visit(fiber.sibling);
}
const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
for (const renderer of hook.renderers.keys())
  for (const root of hook.getFiberRoots(renderer)) visit(root.current);
const panel = panels.find((fiber) => fiber.memoizedProps.progress?.timing);
if (!panel) throw new Error('Open an existing run with timed Worker progress');
const text = [];
const durations = [];
function contents(fiber) {
  if (!fiber) return;
  if (fiber.tag === 6 && typeof fiber.memoizedProps === 'string') text.push(fiber.memoizedProps);
  if (['checklist-elapsed', 'checklist-duration'].includes(fiber.memoizedProps?.testID))
    durations.push({ kind: fiber.memoizedProps.testID, text: fiber.memoizedProps.children });
  contents(fiber.child);
  contents(fiber.sibling);
}
contents(panel.child);
if (!durations.length) throw new Error('Native checklist durations are missing');
return {
  runId: panel.memoizedProps.run?.id,
  timing: panel.memoizedProps.progress.timing,
  text,
  durations,
};

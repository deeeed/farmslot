// Read only how many rows and entries the mounted native conversation's view model holds.
const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
const seen = new Set();
let found;
function visit(fiber) {
  if (!fiber || seen.has(fiber) || found) return;
  seen.add(fiber);
  const viewModel = fiber.memoizedProps?.viewModel;
  if (Array.isArray(viewModel?.rows) && Array.isArray(viewModel?.entries)) {
    found = { rows: viewModel.rows.length, entries: viewModel.entries.length };
    return;
  }
  visit(fiber.child);
  visit(fiber.sibling);
}
for (const renderer of hook?.renderers?.keys() ?? [])
  for (const root of hook.getFiberRoots(renderer)) visit(root.current);
return found;

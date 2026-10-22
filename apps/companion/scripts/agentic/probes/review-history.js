// Inspect the rendered native run panel after opening a real, paired run.
const connection = Array.from(__r.getModules().values())
  .find((module) => module.verboseName?.endsWith('/store/connection.ts'))
  ?.publicModule.exports.useConnectionStore.getState();
if (connection?.status !== 'connected' || connection.workspaceAccess !== 'farm')
  throw new Error('Pair the development app with the live farm before proving review history');
const panels = [];
const seen = new Set();
function visit(fiber) {
  if (!fiber || seen.has(fiber)) return;
  seen.add(fiber);
  if (fiber.memoizedProps?.activityState !== 0 && fiber.memoizedProps?.mode !== 'hidden') {
    if (fiber.type?.name === 'ReviewHistoryPanel') panels.push(fiber);
    visit(fiber.child);
  }
  visit(fiber.sibling);
}
const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
if (!hook?.getFiberRoots) throw new Error('Native inspection is unavailable');
for (const renderer of hook.renderers.keys())
  for (const root of hook.getFiberRoots(renderer)) visit(root.current);
const panel = panels.find((fiber) => {
  for (let parent = fiber.return; parent; parent = parent.return)
    if (parent.type?.name === 'RunDetailScreen') return true;
  return false;
});
if (!panel) throw new Error('Review history is missing from native run detail');
const run = panel.memoizedProps.run;
const { run: saved } = await connection.client.request('run.get', { runId: run.id });
const rounds = [];
const text = [];
function contents(fiber) {
  if (!fiber) return;
  if (fiber.type?.name === 'ReviewAttemptCard') {
    const round = fiber.memoizedProps.round;
    rounds.push({
      round: round.loopNumber,
      runner: round.runner,
      model: round.model,
      mode: round.mode,
      verdict: round.verdict,
      durationMs: round.durationMs,
      findings: round.findings.length,
      fixRange: round.fixRange,
      fixStat: round.fixStat,
      fixDurationMs: round.fixDurationMs,
      resolution: round.resolution,
    });
  }
  if (fiber.tag === 6 && typeof fiber.memoizedProps === 'string') text.push(fiber.memoizedProps);
  contents(fiber.child);
  contents(fiber.sibling);
}
contents(panel.child);
if (rounds.length < 4 || !text.join(' ').includes('Review round'))
  throw new Error('Native run detail did not render four recorded rounds');
if (saved.id !== run.id) throw new Error('Rendered history does not belong to the live run');
return { runId: run.id, status: saved.status, connected: true, screen: 'RunDetailScreen', rounds };

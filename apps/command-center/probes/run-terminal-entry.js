// Run through cdp.mjs against setup-terminal's private active and finished run pages.
// Opens the existing terminal and reads its snapshot. Never types into a worker.
function all(root, selector) {
  return [
    ...root.querySelectorAll(selector),
    ...[...root.querySelectorAll('*')]
      .filter((element) => element.shadowRoot)
      .flatMap((element) => all(element.shadowRoot, selector)),
  ];
}
const deadline = Date.now() + 15000;
let detail, button;
do {
  detail = all(document, 'run-detail')[0];
  button = detail?.shadowRoot?.querySelector('[data-testid="run-terminal-toggle"]');
  if (detail?.run && button) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
} while (Date.now() < deadline);
if (!detail?.run || !button) throw new Error('Run terminal entry did not load');
const run = detail.run;
if (run.id === 'gate-review-fixture-issues-run') {
  if (!button.disabled || !detail.shadowRoot.textContent.includes('This run is finished.'))
    throw new Error('Finished run did not show its disabled terminal reason');
  return { runId: run.id, disabled: true, reason: 'This run is finished.' };
}
const worktree = run.id === 'gate-review-fixture-bypass-run';
if (run.id !== 'gate-review-fixture-request-run' && !worktree)
  throw new Error('Use the private terminal fixture');
if (detail.shadowRoot.querySelector('terminal-view')) {
  button.click();
  await detail.updateComplete;
}
button.click();
await detail.updateComplete;
const terminal = detail.shadowRoot.querySelector('terminal-view');
if (
  !terminal ||
  (!worktree && (terminal.contextId !== 'rev-proof-3' || terminal.role !== 'review'))
)
  throw new Error('Opening the run did not select its running reviewer');
const params = terminal._targetParams();
const { gateway } = await import('/src/gateway-client.ts');
const snapshot = await gateway.request('terminal.snapshot', { ...params, lines: 30 });
if (
  !snapshot.lines.some((line) =>
    line.includes(worktree ? 'TERMINAL PROOF WORKTREE' : 'TERMINAL PROOF REVIEWER'),
  ) ||
  snapshot.lines.some((line) => line.includes('TERMINAL PROOF WORKER'))
)
  throw new Error('Terminal snapshot did not come from the exact reviewer pane');
// The actor label and snapshot can be correct while PTY attachment shows a different window.
let rendered = '';
let stable = 0;
while (Date.now() < deadline && stable < 3) {
  const editor = terminal._terminal;
  const buffer = editor?.buffer.active;
  rendered = buffer
    ? Array.from(
        { length: editor.rows },
        (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '',
      ).join('\n')
    : '';
  stable =
    rendered.includes(worktree ? 'TERMINAL PROOF WORKTREE' : 'TERMINAL PROOF REVIEWER') &&
    !rendered.includes('TERMINAL PROOF WORKER')
      ? stable + 1
      : 0;
  if (stable < 3) await new Promise((resolve) => setTimeout(resolve, 100));
}
if (stable < 3) throw new Error(`Rendered terminal is not the selected actor: ${rendered}`);
const fleet = await gateway.request('fleet.status');
const slot = fleet.fleet.slots.find((entry) => entry.slot === params.slotId);
const context = worktree
  ? run.agentContexts[0]
  : run.agentContexts.find((entry) => entry.id === params.contextId);
terminal.scrollIntoView({ block: 'center' });
return {
  ...params,
  node: slot?.machine ?? run.reviewWorkspace?.machine,
  session: context.target.session,
  window: context.target.window,
  reviewerMarkerFound: true,
  workerMarkerFound: false,
  renderedReviewerMarkerFound: true,
  renderedWorkerMarkerFound: false,
  inputSent: false,
};

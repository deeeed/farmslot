// Read the live run and drive its recorded round and fix-diff controls.
function all(root, selector) {
  return [
    ...root.querySelectorAll(selector),
    ...[...root.querySelectorAll('*')]
      .filter((element) => element.shadowRoot)
      .flatMap((element) => all(element.shadowRoot, selector)),
  ];
}
async function until(read, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(description);
}
await until(() => {
  const app = document.querySelector('farm-app');
  return app?.connection === 'connected' && app.hydrated;
}, 'Command Center is not connected to the live farm');
const inspector = await until(() => all(document, 'step-inspector')[0], 'No step inspector');
const panel = await until(
  () => inspector.shadowRoot.querySelector('[data-testid="review-history"]'),
  'No review history on this review step',
);
await until(() => !inspector._historyLoading, 'Recorded history did not load');
const rounds = [...panel.querySelectorAll('[data-round]')];
if (rounds.length < 4) throw new Error('Expected at least four recorded rounds');
const third = rounds[2];
if (!third.open) third.querySelector('summary').click();
await until(() => third.open, 'Round toggle did not expand');
const findings = [...third.querySelectorAll('.review-loop-issue')].map((row) =>
  row.textContent.trim().replace(/\s+/g, ' '),
);
if (!findings.length) throw new Error('Expanded round has no recorded findings');
const button = [...third.querySelectorAll('button')].find((element) =>
  element.textContent.includes('Changed files and diff'),
);
if (!button || button.disabled) throw new Error('Recorded fix diff is unavailable');
button.click();
const modal = await until(() => {
  const view = inspector.shadowRoot.querySelector('diff-viewer-modal');
  return view?.open && view.diffText?.includes('diff --git') ? view : null;
}, 'Fix diff did not open');
const diff = { path: modal.title, bytes: modal.diffText.length };
const close = all(modal, 'button').find((element) => element.classList.contains('dvm-close'));
if (!close) throw new Error('No diff close control');
close.click();
await until(() => !modal.open, 'Diff did not close');
panel.scrollIntoView({ block: 'start' });
await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
return {
  runId: inspector.run.id,
  step: inspector.step.name,
  runStatus: inspector.run.status,
  connected: true,
  rounds: rounds.map((round) => ({
    round: Number(round.dataset.round),
    summary: round.querySelector('summary').textContent.trim().replace(/\s+/g, ' '),
  })),
  findings,
  fix: third.querySelector('.review-loop-fix')?.textContent.trim().replace(/\s+/g, ' '),
  diff,
  actualControlClicks: true,
  viewport: { width: innerWidth, height: innerHeight },
};

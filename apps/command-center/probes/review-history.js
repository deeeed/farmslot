// Shared history proof against a real run. Interactions inspect only, never dispatch reviews.
function all(root, selector) {
  return [
    ...root.querySelectorAll(selector),
    ...[...root.querySelectorAll('*')]
      .filter((element) => element.shadowRoot)
      .flatMap((element) => all(element.shadowRoot, selector)),
  ];
}
async function until(read, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}
await until(
  () => document.querySelector('farm-app')?.connection === 'connected',
  'Farm not connected',
);
const panel = await until(
  () => all(document, 'review-history-panel')[0],
  'No shared history panel',
);
await until(
  () => !panel._historyLoading && panel.shadowRoot.querySelectorAll('[data-round]').length >= 2,
  'History did not load',
);
const rounds = [...panel.shadowRoot.querySelectorAll('[data-round]')];
const first = rounds.find((round) => round.querySelector('.review-loop-issue'));
if (!first) throw new Error('No completed findings');
if (!first.open) first.querySelector('summary').click();
const fix = panel.shadowRoot.querySelector('[data-fix]');
if (!fix) throw new Error('No intervening fix');
if (!fix.open) fix.querySelector('summary').click();
const diff = [...fix.querySelectorAll('button')].find((button) =>
  button.textContent.includes('Changed files and diff'),
);
if (!diff || diff.disabled) throw new Error('Fix diff action unavailable');
diff.click();
const modal = await until(() => {
  const view = panel.shadowRoot.querySelector('diff-viewer-modal');
  return view?.open && view.diffText?.includes('diff --git') ? view : null;
}, 'Fix diff did not open');
const diffProof = { path: modal.title, bytes: modal.diffText.length };
const close = all(modal, '.dvm-close')[0];
if (!close) throw new Error('No diff close control');
close.click();
await until(() => !modal.open, 'Diff did not close');
const findings = [...first.querySelectorAll('.review-loop-issue')].map((finding) => ({
  id: finding.dataset.finding,
  text: ['.finding-heading', '.finding-location', '.finding-text']
    .map((selector) => finding.querySelector(selector)?.textContent.trim())
    .join(' ')
    .replace(/\s+/g, ' '),
}));
first.scrollIntoView({ block: 'start' });
await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
return {
  runId: panel.run.id,
  runStatus: panel.run.status,
  rounds: rounds.map((round) => ({
    round: Number(round.dataset.round),
    summary: round.querySelector('summary').textContent.trim().replace(/\s+/g, ' '),
  })),
  findings,
  fix: fix.textContent.trim().replace(/\s+/g, ' '),
  diff: diffProof,
  actualControlClicks: true,
  viewport: { width: innerWidth, height: innerHeight },
};

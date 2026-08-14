const waitFor = async (predicate, label, timeoutMs = 120000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

location.hash = '#fleet';
const shell = await waitFor(() => document.querySelector('farm-app'), 'farm app');
const openButton = await waitFor(
  () => shell.querySelector('button[title="Co-Pilot (Cmd+K)"]'),
  'Co-Pilot button',
);
let panel = document.querySelector('chat-panel');
if (!panel?.open) openButton.click();
panel = await waitFor(() => document.querySelector('chat-panel'), 'Co-Pilot panel');
const card = await waitFor(
  () => panel.querySelector('[data-testid="copilot-runtime-card"]'),
  'runtime card',
);

const startedByProbe = !panel.querySelector('[data-testid="copilot-stop"]');
if (startedByProbe) {
  panel.querySelector('[data-testid="copilot-start-sandboxed"]')?.click();
  await waitFor(() => /Running/i.test(card.textContent || ''), 'sandboxed running state');
}

if (!card.classList.contains('compact')) {
  throw new Error('Running Co-Pilot controls are not compact by default');
}
const details = await waitFor(
  () => panel.querySelector('[data-testid="copilot-details-toggle"]'),
  'runtime details toggle',
);
details.click();
await waitFor(() => !card.classList.contains('compact'), 'expanded runtime details');
details.click();
await waitFor(() => card.classList.contains('compact'), 'collapsed runtime details');

const terminal = await waitFor(
  () => panel.querySelector('[data-testid="copilot-terminal"] terminal-view'),
  'Co-Pilot terminal',
);
const terminalWorker = JSON.parse(terminal.workerRefJson || 'null');
if (!terminalWorker || terminalWorker.target !== panel.runtime?.terminalWorker?.target) {
  throw new Error('Co-Pilot terminal is not bound to the runtime terminal worker');
}
if (panel.querySelector('textarea.cp-input')) {
  throw new Error('Legacy Co-Pilot composer is still rendered');
}

panel.querySelector('[data-testid="copilot-reconnect"]')?.click();
await waitFor(() => /Reconnected/.test(card.textContent || ''), 'reconnect state');

if (startedByProbe) {
  panel.querySelector('[data-testid="copilot-stop"]')?.click();
  await waitFor(() => /Stopped/i.test(card.textContent || ''), 'restored stopped state');
}

const stewardRoutePresent = location.hash.includes('steward');
if (stewardRoutePresent)
  throw new Error('Co-Pilot runtime probe unexpectedly entered a steward route');

return {
  ok: true,
  start: startedByProbe ? 'sandboxed' : 'already-running',
  terminal: 'exact-worker',
  controls: 'compact-with-details',
  composer: 'removed',
  reconnect: 'same-runtime',
  stop: startedByProbe ? 'restored-stopped' : 'left-running',
  stewardRoutePresent,
};

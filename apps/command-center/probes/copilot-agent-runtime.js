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

const stop = panel.querySelector('[data-testid="copilot-stop"]');
if (stop) {
  stop.click();
  await waitFor(() => /Stopped/i.test(card.textContent || ''), 'stopped state');
}

panel.querySelector('[data-testid="copilot-start-sandboxed"]')?.click();
await waitFor(() => /Running/i.test(card.textContent || ''), 'sandboxed running state');

await waitFor(() => panel.querySelector('textarea.cp-input'), 'message input');
await panel.createManualSession();
const contextualSessionId = panel.activeSessionIdValue;
if (!contextualSessionId?.startsWith('manual:')) {
  throw new Error('Could not select a contextual Co-Pilot session before shared-runtime send');
}
await panel.submitPrompt('COPILOT_PROBE_SHARED_HISTORY');
if (panel.activeSessionIdValue !== 'global') {
  throw new Error('Contextual prompt did not return the panel to the canonical shared transcript');
}
await waitFor(() => /COPILOT_PROBE_SHARED_HISTORY/.test(panel.textContent || ''), 'shared history');

panel.querySelector('[data-testid="copilot-reconnect"]')?.click();
await waitFor(() => /Reconnected/.test(card.textContent || ''), 'reconnect state');

panel.querySelector('[data-testid="copilot-stop"]')?.click();
await waitFor(() => /Stopped/i.test(card.textContent || ''), 'final stopped state');

const stewardRoutePresent = location.hash.includes('steward');
if (stewardRoutePresent)
  throw new Error('Co-Pilot runtime probe unexpectedly entered a steward route');

return {
  ok: true,
  start: 'sandboxed',
  send: 'visible',
  history: 'shared',
  contextualSessionId,
  canonicalTranscriptId: panel.activeSessionIdValue,
  reconnect: 'same-runtime',
  stop: 'operator-controlled',
  stewardRoutePresent,
};

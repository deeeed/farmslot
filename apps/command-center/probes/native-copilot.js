// Run with cdp.mjs eval <route> --file probes/native-copilot.js --out <evidence.json>.
// Opens the actual workspace controls and observes their rendered state. No store injection.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = read();
    if (result) return result;
    await pause(100);
  }
  throw new Error(`Missing ${description}`);
}
await customElements.whenDefined('chat-panel');
const panel = await waitFor(() => document.querySelector('chat-panel'), 'Copilot');
if (!panel.querySelector('.cp-drawer')) {
  const button = document.querySelector('button[title="Co-Pilot (Cmd+K)"]');
  if (!button) throw new Error('Copilot toolbar control absent');
  button.click();
}
const workspaceTab = await waitFor(
  () => panel.querySelector('[data-testid="copilot-workspace-mode"]'),
  'Agent workspace tab',
);
if (!panel.querySelector('native-session-view')) workspaceTab.click();
const view = await waitFor(
  () => panel.querySelector('native-session-view')?.shadowRoot,
  'native conversation',
);
await waitFor(
  () => view.querySelector('[data-testid="native-create"], [data-testid="native-message"], .error'),
  'session controls',
);
const errors = Array.from(view.querySelectorAll('.error'))
  .map((element) => element.textContent.trim())
  .filter(Boolean);
const selection = view.querySelector('[data-testid="native-session-select"]')?.value ?? '';
const [executionNodeId, sessionId] = selection.startsWith('[')
  ? JSON.parse(selection)
  : ['local', selection];
return {
  executionNodeId,
  sessionId,
  contexts: Array.from(view.querySelectorAll('[data-testid="native-context"] option')).map(
    (option) => ({ value: option.value, label: option.textContent.trim() }),
  ),
  selectedContext: view.querySelector('[data-testid="native-context"]')?.value,
  identity: view.querySelector('.identity')?.textContent.trim(),
  timeline: view.querySelector('.timeline')?.innerText.trim(),
  requests: Array.from(view.querySelectorAll('[data-request-id]')).map((element) => ({
    id: element.dataset.requestId,
    text: element.textContent.trim(),
  })),
  sendEnabled:
    !!view.querySelector('[data-testid="native-send"]') &&
    !view.querySelector('[data-testid="native-send"]').disabled,
  stopEnabled:
    !!view.querySelector('[data-testid="native-stop"]') &&
    !view.querySelector('[data-testid="native-stop"]').disabled,
  errors,
};

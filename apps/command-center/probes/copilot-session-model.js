// CDP probe: validate single-global-session co-pilot behavior.
//
// Verifies:
//  - chat-panel mounts after reload on #fleet
//  - activeSessionId is 'global' regardless of route
//  - hashchange to #run/foo does NOT switch sessions (no auto-switch)
//  - "History" button is rendered, no legacy session <select>
//  - Save chat button is hidden when active session is 'global' (already pinned)

async function waitFor(predicate, timeoutMs = 4000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function findChatPanel() {
  const farmApp = document.querySelector('farm-app');
  return farmApp?.shadowRoot?.querySelector('chat-panel') ?? document.querySelector('chat-panel');
}

async function openChat() {
  const panel = await waitFor(findChatPanel);
  if (!panel) throw new Error('chat-panel not found');
  panel.open = true;
  await new Promise((r) => setTimeout(r, 200));
  return panel;
}

async function inspect(panel) {
  await new Promise((r) => setTimeout(r, 150));
  const select = panel.querySelector('.cp-session-select');
  const historyBtn = [...panel.querySelectorAll('button')].find((b) =>
    /^History/.test(b.textContent.trim()),
  );
  const saveBtn = [...panel.querySelectorAll('button')].find((b) =>
    /Save chat/.test(b.textContent),
  );
  const label = panel.querySelector('.cp-session-label')?.textContent?.trim();
  return {
    activeSessionId:
      typeof panel.activeSessionId === 'function'
        ? panel.activeSessionId()
        : panel['activeSessionIdValue'],
    label,
    hasLegacySelect: !!select,
    hasHistoryBtn: !!historyBtn,
    historyBtnText: historyBtn?.textContent?.trim() ?? null,
    hasSaveBtn: !!saveBtn,
  };
}

location.hash = '#fleet';
await new Promise((r) => setTimeout(r, 300));
const panel = await openChat();
const onFleet = await inspect(panel);

location.hash = '#run/test-run-id';
await new Promise((r) => setTimeout(r, 400));
const onRun = await inspect(panel);

location.hash = '#slot/runner-browser-1';
await new Promise((r) => setTimeout(r, 400));
const onSlot = await inspect(panel);

return {
  onFleet,
  onRun,
  onSlot,
  identical:
    onFleet.activeSessionId === onRun.activeSessionId &&
    onRun.activeSessionId === onSlot.activeSessionId,
};

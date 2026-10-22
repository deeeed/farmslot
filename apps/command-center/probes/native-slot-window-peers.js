// Read the real slot's tmux peers while a native context is selected, before a window click.
function find(root, selector) {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot) {
      const found = find(element.shadowRoot, selector);
      if (found) return found;
    }
  }
}
let terminal;
const viewDeadline = Date.now() + 15000;
while (Date.now() < viewDeadline) {
  terminal = find(document, 'terminal-view');
  if (terminal?.nativeWorker && terminal.slotId) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}
if (!terminal?.nativeWorker || !terminal.slotId) throw new Error('Select a slot native context');
const windowDeadline = Date.now() + 15000;
while (!terminal._tmuxWindows.length && Date.now() < windowDeadline)
  await new Promise((resolve) => setTimeout(resolve, 50));
const windows = terminal._tmuxWindows.map((window) => ({ index: window.index, name: window.name }));
const tabs = [...terminal.shadowRoot.querySelectorAll('[role="tab"]')].map((tab) =>
  tab.textContent.trim(),
);
if (
  !windows.length ||
  !windows.every((window) => tabs.some((tab) => tab.startsWith(`${window.index}:`)))
)
  throw new Error('The real slot window peers are not rendered beside the native conversation');
return {
  contextId: terminal.nativeWorker.contextId,
  sessionId: terminal.nativeWorker.binding.sessionId,
  beforeWindowClick: true,
  windows,
  tabs,
};

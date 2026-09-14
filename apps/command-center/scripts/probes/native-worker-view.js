const walk = (root) =>
  [...root.querySelectorAll('*')].flatMap((element) =>
    element.shadowRoot ? [element, ...walk(element.shadowRoot)] : [element],
  );
const view = walk(document).find((element) => element.matches('native-session-view'));
const root = view?.shadowRoot;
const input = root?.querySelector('textarea');
const send = root?.querySelector('[data-testid=native-send]');
const rect = send?.getBoundingClientRect();
let top = rect ? Math.max(0, rect.top) : 0;
let bottom = rect ? Math.min(innerHeight, rect.bottom) : 0;
let parent = send?.parentElement;
while (parent) {
  const style = getComputedStyle(parent);
  const bounds = parent.getBoundingClientRect();
  if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)) {
    top = Math.max(top, bounds.top);
    bottom = Math.min(bottom, bounds.bottom);
  }
  parent = parent.parentElement ?? parent.getRootNode().host;
}
return {
  state: root?.querySelector('.status[data-state]')?.getAttribute('data-state'),
  delivery: root?.querySelector('[data-testid=native-delivery]')?.textContent.trim(),
  inputReady: Boolean(input && !input.disabled),
  label: root?.querySelector('[data-testid=native-worker-label]')?.textContent.trim(),
  send: send
    ? {
        disabled: send.disabled,
        width: rect.width,
        height: rect.height,
        visible: bottom - top >= rect.height - 1,
      }
    : null,
  timelineHeight: root?.querySelector('.timeline')?.getBoundingClientRect().height ?? 0,
  newSession: Boolean(root?.querySelector('[data-testid=native-new]')),
  errors: [...(root?.querySelectorAll('[role=alert]') ?? [])].map((element) =>
    element.textContent.trim(),
  ),
  text: root?.querySelector('.timeline')?.innerText,
};

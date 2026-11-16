// Observe the real workspace reader and its rendered failure, never replace state.
const view = document.querySelector('slot-view');
const state = view?._workspaceReads?.stateOf('fs.list', {
  slotId: view.slotId,
  path: '.',
  includeIgnored: view._showIgnored,
});
const placeholder = (view?.shadowRoot ?? view)?.querySelector('farm-hydrating');
const alert = placeholder?.shadowRoot?.querySelector('[role="alert"]');
const rect = alert?.getBoundingClientRect();
return {
  connected: document.querySelector('farm-app')?.connection === 'connected',
  slotId: view?.slotId,
  code: state?.error?.code,
  readError: view?._wsError,
  text: alert?.textContent.trim().replace(/\s+/g, ' '),
  visible: Boolean(rect && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight),
  retry: Boolean(alert?.querySelector('button')),
};

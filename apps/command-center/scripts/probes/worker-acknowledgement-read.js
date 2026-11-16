// Observe the actual run-page checklist; never replace its data or render state.
const detail = document.querySelector('run-detail');
const pipeline = detail?.shadowRoot?.querySelector('run-pipeline');
const panel = pipeline?.shadowRoot?.querySelector('[data-panel="run-step-progress"]');
const strip = panel?.querySelector('run-checklist-progress');
const acknowledgement = strip?.shadowRoot?.querySelector('[data-testid="worker-acknowledged"]');
const time = acknowledgement?.querySelector('time');
const rect = acknowledgement?.getBoundingClientRect();
return {
  connected: document.querySelector('farm-app')?.connection === 'connected',
  modalOpen: Boolean(
    document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('button.primary'),
  ),
  runId: detail?.run?.id,
  status: detail?.run?.status,
  panelOpen: panel?.querySelector('button')?.getAttribute('aria-expanded') === 'true',
  completed: detail?.taskProgress?.completedSteps,
  total: detail?.taskProgress?.totalSteps,
  text: acknowledgement?.textContent.trim().replace(/\s+/g, ' '),
  acknowledgedAt: time?.dateTime,
  visible: Boolean(rect && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight),
  counts: strip?.shadowRoot?.querySelector('.counts')?.textContent,
};

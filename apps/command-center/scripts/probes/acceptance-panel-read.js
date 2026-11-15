// Read-only run/acceptance DOM observation; never mutates client state.
const detail = document.querySelector('run-detail');
const run = detail?.run;
const root = detail?.shadowRoot?.querySelector('run-pipeline')?.shadowRoot;
const panel = root?.querySelector('[data-panel="run-acceptance"]');
const rows = [...(panel?.querySelectorAll('[data-testid="acceptance-row"]') ?? [])];
return {
  connected: document.querySelector('farm-app')?.connection === 'connected',
  modalOpen: Boolean(
    document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('button.primary'),
  ),
  runId: run?.id,
  status: run?.status,
  taskFile: run?.taskFile ?? null,
  writeTask: run?.steps.find((step) => step.name === 'write-task')?.status,
  heading: panel?.querySelector('button')?.textContent.trim().replace(/\s+/g, ' '),
  tally: panel?.querySelector('[data-testid="run-acceptance-toggle-summary"]')?.textContent.trim(),
  text: panel?.textContent.trim().replace(/\s+/g, ' '),
  rows: rows.map((row) => ({
    id: row.dataset.acId,
    text: row.querySelector('.ac-text')?.textContent,
    nestedTextDisclosure: Boolean(row.querySelector('details.gate-claim-text')),
  })),
  errors: [...(panel?.querySelectorAll('[data-testid="acceptance-error"]') ?? [])].map(
    (e) => e.textContent,
  ),
  preparing: Boolean(panel?.querySelector('[data-testid="acceptance-awaiting-task"]')),
};

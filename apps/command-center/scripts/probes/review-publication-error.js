// Read-only DOM plus the canonical run observation. No client state writes.
function find(root, selector) {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  for (const element of root.querySelectorAll('*'))
    if (element.shadowRoot) {
      const child = find(element.shadowRoot, selector);
      if (child) return child;
    }
}
const detail = find(document, 'run-detail');
const workspace = detail?.shadowRoot?.querySelector('review-workspace');
const error = workspace?.querySelector('[data-testid="review-publication-error"]');
const run = workspace?._queries.run.state.data?.run;
const bounds = error?.getBoundingClientRect();
const button = workspace?.querySelector('[data-testid="review-post"]');
return {
  connected: document.querySelector('farm-app')?.connection === 'connected',
  mounted: Boolean(workspace),
  modalOpen: Boolean(
    document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('button.primary'),
  ),
  readOnly: workspace?.readOnly,
  runId: run?.id,
  storedError: run?.reviewPublication?.error ?? null,
  receipt: run?.reviewPublication?.receipt?.state ?? null,
  errorText: error?.textContent.trim().replace(/\s+/g, ' ') ?? null,
  role: error?.getAttribute('role'),
  errorVisible: Boolean(
    bounds &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.top >= 0 &&
    bounds.bottom <= innerHeight,
  ),
  postDisabled: button?.disabled,
  actionError: workspace?.querySelector('[data-testid="review-action-error"]')?.textContent,
};

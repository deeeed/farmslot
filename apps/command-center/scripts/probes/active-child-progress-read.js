// Read only the mounted two-level strip and its existing run context.
const detail = document.querySelector('run-detail');
const pipeline = detail?.shadowRoot?.querySelector('run-pipeline');
const panel = pipeline?.shadowRoot?.querySelector('[data-panel="run-step-progress"]');
const root = panel?.querySelector('run-checklist-progress')?.shadowRoot;
const child = root?.querySelector('[data-testid="checklist-child-progress"]');
const rect = child?.getBoundingClientRect();
return {
  connected: document.querySelector('farm-app')?.connection === 'connected',
  runId: detail?.run?.id,
  modalOpen: Boolean(
    document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('button.primary'),
  ),
  panelOpen: panel?.querySelector('button')?.getAttribute('aria-expanded') === 'true',
  parentCounts: root?.querySelector('.strip .counts')?.textContent.trim(),
  childCounts: child?.querySelector('.counts')?.textContent.trim(),
  childTitle: child?.querySelector('.child-title .item')?.textContent.trim(),
  childStep: child?.querySelector('.label .item')?.textContent.trim(),
  childStatus: child?.querySelector('.child-status')?.textContent.trim(),
  childBars: root?.querySelectorAll('[data-testid="checklist-child-progress"]').length ?? 0,
  fits: Boolean(
    child &&
    child.scrollWidth <= child.clientWidth + 1 &&
    rect &&
    rect.left >= 0 &&
    rect.right <= innerWidth,
  ),
  visible: Boolean(rect && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight),
};

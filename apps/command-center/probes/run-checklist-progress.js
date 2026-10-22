// Read-only proof of the real run projection. Run at either runs or run/<id>.
const elements = [];
function walk(root) {
  for (const element of root.querySelectorAll('*')) {
    if (element.tagName === 'RUN-CHECKLIST-PROGRESS') elements.push(element);
    if (element.shadowRoot) walk(element.shadowRoot);
  }
}
walk(document);
const rows = elements.map((element) => {
  const progressbar = element.shadowRoot?.querySelector('[role="progressbar"]');
  const label = element.shadowRoot?.querySelector('.item');
  const rect = element.getBoundingClientRect();
  const input = element.progress;
  const row = {
    runId: element.run?.id,
    counts: element.shadowRoot?.querySelector('.counts')?.textContent ?? null,
    currentItem: label?.textContent ?? null,
    completed: progressbar?.getAttribute('aria-valuenow') ?? null,
    total: progressbar?.getAttribute('aria-valuemax') ?? null,
    trackHeight: progressbar ? getComputedStyle(progressbar).height : null,
    reservedHeight: rect.height,
    width: rect.width,
    labelFits: !label || label.getBoundingClientRect().right <= rect.right + 1,
    matchesProjection:
      !progressbar ||
      (Number(progressbar.getAttribute('aria-valuenow')) === input?.completedSteps &&
        Number(progressbar.getAttribute('aria-valuemax')) === input?.totalSteps),
  };
  if (row.reservedHeight !== 28) throw new Error('Checklist strip changed the reserved row height');
  if (!row.labelFits) throw new Error('Checklist label overflows its strip');
  if (progressbar && row.trackHeight !== '2px')
    throw new Error('Checklist bar must be thinner than the pipeline');
  if (!row.matchesProjection) throw new Error('Checklist counts differ from the live projection');
  return row;
});
if (!rows.some((row) => row.counts)) throw new Error('No live checklist is visible');
return { viewport: { width: innerWidth, height: innerHeight }, rows };

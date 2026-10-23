// Read-only inspection after opening Worker progress on an existing run.
const panels = [];
function visit(root) {
  for (const element of root.querySelectorAll('*')) {
    if (element.tagName === 'PROGRESS-TRACKER' && element.getBoundingClientRect().height)
      panels.push(element);
    if (element.shadowRoot) visit(element.shadowRoot);
  }
}
visit(document);
const panel = panels.find((element) => element.structured?.timing);
if (!panel) throw new Error('Open a real timed Worker progress panel');
const rows = [...panel.shadowRoot.querySelectorAll('.substep')].map((row) => {
  const duration = row.querySelector('.substep-duration');
  const bounds = row.getBoundingClientRect();
  if (duration && duration.getBoundingClientRect().right > bounds.right + 1)
    throw new Error('Duration overflows the row');
  return {
    label: row.querySelector('.substep-name')?.textContent,
    status: row.className,
    duration: duration?.textContent?.trim() ?? null,
    live: duration?.getAttribute('data-live') === 'true',
  };
});
if (!rows.some((row) => row.duration)) throw new Error('No checklist durations rendered');
return {
  runId: panel.runId,
  timing: panel.structured.timing,
  rows,
  viewport: { width: innerWidth, height: innerHeight },
};

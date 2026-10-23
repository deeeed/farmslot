// Read-only proof of the rendered shared CI line, after opening the Runs page.
const rows = [];
function walk(root) {
  for (const element of root.querySelectorAll('*')) {
    if (element.tagName === 'RUN-CI-WATCH-STATUS') {
      const text = element.shadowRoot?.querySelector('[data-testid="ci-watch-status"]');
      if (text && text.getBoundingClientRect().width) {
        const style = getComputedStyle(text);
        if (style.borderTopWidth !== '0px' || style.paddingLeft !== '0px')
          throw new Error('CI status must be plain text');
        if (text.scrollWidth > text.clientWidth + 1) throw new Error('CI line overflows');
        rows.push({
          runId: element.run?.id,
          label: text.textContent.trim(),
          title: text.title,
          nowMs: element.nowMs,
          fontSize: style.fontSize,
          clockRunning: Boolean(element.timer),
        });
      }
    }
    if (element.shadowRoot) walk(element.shadowRoot);
  }
}
walk(document);
if (!rows.length) throw new Error('No CI-watch summary is visible');
return { rows, viewport: { width: innerWidth, height: innerHeight } };

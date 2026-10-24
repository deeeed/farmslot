const panels = [];
function visit(root) {
  for (const element of root.querySelectorAll('*')) {
    if (element.localName === 'source-status-panel') panels.push(element);
    if (element.shadowRoot) visit(element.shadowRoot);
  }
}
visit(document);
return panels.map((panel) => {
  const state = Reflect.get(panel, 'controller').getSnapshot();
  return {
    freshness: state.freshness,
    observedAt: state.observedAt,
    line: state.view?.line,
    stale: panel.shadowRoot.querySelector('[data-testid="sources-stale"]')?.textContent.trim(),
    interactive: state.interactive,
    hidden: state.hidden,
    error: state.error,
    pinRevision: state.view?.pinRevision,
    rows: state.view?.rows.map((row) => ({
      sourceId: row.declaration.id,
      ref: row.effective?.effectiveRef,
      materializations: row.materializations,
      details: row.details,
    })),
    errors: state.view?.errors,
    controls: [...panel.shadowRoot.querySelectorAll('button,input')]
      .filter((control) =>
        /^source-.*-(sync|pin|unpin|main|branch)$/.test(control.dataset.testid ?? ''),
      )
      .map((control) => ({ id: control.dataset.testid, disabled: control.disabled })),
  };
});

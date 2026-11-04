() => {
  const elements = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll('*')) {
      elements.push(element);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  const history = elements.find((element) => element.tagName === 'REVIEW-HISTORY-PANEL');
  const root = history?.shadowRoot;
  return {
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight },
    panels: elements
      .filter((element) => element.hasAttribute('data-panel'))
      .map((element) => ({
        id: element.getAttribute('data-panel'),
        open: element.getAttribute('data-open'),
      })),
    history: root
      ? {
          runId: history.run?.id,
          loading: history._historyLoading,
          artifactCount: Object.keys(history._historyArtifacts ?? {}).length,
          loadingText: [...root.querySelectorAll('.history-load-state')]
            .map((element) => element.textContent.trim())
            .filter(Boolean),
          rounds: [...root.querySelectorAll('.review-history-round')].map((element) => ({
            key: element.getAttribute('data-event'),
            open: element.open,
            summary: element.querySelector('summary')?.textContent.replace(/\s+/g, ' ').trim(),
            height: element.getBoundingClientRect().height,
          })),
          warnings: [...root.querySelectorAll('.history-warning')].map((element) =>
            element.textContent.replace(/\s+/g, ' ').trim(),
          ),
        }
      : null,
  };
};

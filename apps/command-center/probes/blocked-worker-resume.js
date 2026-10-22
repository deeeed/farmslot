// Read-only CDP probe for a private run fixture. Drive Resume with cdp.mjs click.
return (() => {
  function all(root, selector) {
    const found = [...root.querySelectorAll(selector)];
    for (const element of root.querySelectorAll('*'))
      if (element.shadowRoot) found.push(...all(element.shadowRoot, selector));
    return found;
  }
  const detail = all(document, 'run-detail')[0];
  if (!detail?.shadowRoot) throw new Error('Open the fixture run detail first');
  const recovery = all(detail.shadowRoot, 'blocked-run-recovery')[0];
  const resume = recovery?.shadowRoot?.querySelector('[data-testid="blocked-run-retry-monitor"]');
  return {
    labels: all(detail.shadowRoot, '.status-badge').map((element) => element.textContent.trim()),
    recoveryPresent: Boolean(recovery),
    resumeEnabled: Boolean(resume && !resume.disabled),
    resumeLabel: resume?.textContent.trim() ?? null,
    recoveryText:
      recovery?.shadowRoot?.querySelector('section')?.textContent.replace(/\s+/g, ' ').trim() ??
      null,
  };
})();

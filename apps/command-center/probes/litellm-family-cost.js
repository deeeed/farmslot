// Read the real run detail returned by the isolated cost-accounting gateway.
function elements(root) {
  return [...root.querySelectorAll('*')].flatMap((node) => [
    node,
    ...(node.shadowRoot ? elements(node.shadowRoot) : []),
  ]);
}
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  const nodes = elements(document);
  nodes.find((node) => node.tagName === 'BUTTON' && node.textContent.trim() === 'Got it')?.click();
  const quality = nodes.find(
    (node) => node.matches('.rdy-tab') && node.textContent.trim().startsWith('Quality'),
  );
  if (quality && !quality.classList.contains('active')) quality.click();
  const panel = elements(document).find((node) => node.tagName === 'GATE-SUMMARY-PANEL');
  panel?.shadowRoot?.querySelector('details:not([open]) > summary')?.click();
  const total = panel?.shadowRoot?.querySelector('.gs-token-row.gs-total');
  if (
    total?.textContent.includes('Includes unpriced or uncaptured sessions') &&
    total.getBoundingClientRect().height > 0
  ) {
    total.scrollIntoView({ behavior: 'instant', block: 'center' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const bounds = total.getBoundingClientRect();
    if (bounds.top < 0 || bounds.bottom > innerHeight) continue;
    return {
      pass: true,
      text: total.textContent.trim(),
      visible: true,
    };
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
throw new Error('The incomplete family cost reason did not render visibly in the Quality tab');

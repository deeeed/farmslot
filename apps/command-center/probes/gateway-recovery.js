// Read-only outage proof: actual rendered indicator, retained rows and content geometry.
() => {
  const elements = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll('*')) {
      elements.push(element);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  const indicator = elements.find((e) => e.tagName === 'GATEWAY-CONNECTION-INDICATOR');
  const main = document.querySelector('.fa-main');
  const box = main?.getBoundingClientRect();
  return {
    url: location.href,
    status: indicator?.shadowRoot?.querySelector('[role="status"]')?.textContent?.trim() ?? null,
    main: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
    slots: elements.filter((e) => e.tagName === 'SLOT-CARD').map((e) => e.slotData?.slot),
  };
};

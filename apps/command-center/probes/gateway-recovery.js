// Read-only outage proof: actual rendered indicator, retained rows and content geometry.
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
const fleet = elements.find((element) => element.tagName === 'FLEET-CANVAS');
const slots =
  fleet?.slots?.map((slot) => slot.slot) ??
  elements
    .filter((element) => element.tagName === 'SLOT-CARD')
    .map((element) => element.slotData?.slot);
const rows = elements
  .filter(
    (element) =>
      element.classList.contains('slot-name') && slots.includes(element.textContent?.trim()),
  )
  .map((element) => {
    const box = element.getBoundingClientRect();
    return {
      slot: element.textContent.trim(),
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    };
  });
const box = main?.getBoundingClientRect();
return {
  url: location.href,
  connection: elements.find((element) => element.tagName === 'FLEET-SUMMARY-BAR')?.connection,
  status: indicator?.shadowRoot?.querySelector('[role="status"]')?.textContent?.trim() ?? null,
  main: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
  slots,
  rows,
};

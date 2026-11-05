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
const measure = (element, slot) => {
  const box = element.getBoundingClientRect();
  return { slot, x: box.x, y: box.y, width: box.width, height: box.height };
};
const rows = elements
  .filter((element) => element.classList.contains('slot-name'))
  .flatMap((element) => {
    const group = element.getRootNode().host;
    if (group?.tagName !== 'MACHINE-GROUP') return [];
    const label = element.textContent.trim();
    const prefix = `${group.machine}-`;
    const slot = group.slots.find(
      (entry) =>
        entry.slot === label ||
        (entry.slot.startsWith(prefix) && entry.slot.slice(prefix.length) === label),
    );
    return slot ? [measure(element, slot.slot)] : [];
  });
for (const card of elements.filter((element) => element.tagName === 'SLOT-CARD')) {
  const id = card.slotData?.slot;
  if (id && !rows.some((row) => row.slot === id)) rows.push(measure(card, id));
}
const box = main?.getBoundingClientRect();
return {
  url: location.href,
  connection: elements.find((element) => element.tagName === 'FLEET-SUMMARY-BAR')?.connection,
  status: indicator?.shadowRoot?.querySelector('[role="status"]')?.textContent?.trim() ?? null,
  main: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
  slots,
  rows,
};

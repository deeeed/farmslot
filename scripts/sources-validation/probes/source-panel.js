// Read rendered source facts through the normal Command Center routes.
function panels(root) {
  return [...root.querySelectorAll('*')].flatMap((element) => [
    ...(element.localName === 'source-status-panel' ? [element] : []),
    ...(element.shadowRoot ? panels(element.shadowRoot) : []),
  ]);
}
return panels(document).map((panel) => ({
  text: panel.shadowRoot?.textContent?.replace(/\s+/g, ' ').trim(),
  inputs: [...(panel.shadowRoot?.querySelectorAll('input') ?? [])].map((input) => ({
    value: input.value,
    disabled: input.disabled,
  })),
  buttons: [...(panel.shadowRoot?.querySelectorAll('button') ?? [])].map((button) => ({
    id: button.dataset.testid,
    label: button.textContent.trim(),
    disabled: button.disabled,
  })),
}));

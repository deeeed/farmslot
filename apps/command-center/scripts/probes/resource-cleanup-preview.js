const findDeep = (root, selector) =>
  root.querySelector(selector) ||
  [...root.querySelectorAll('*')]
    .map((element) => element.shadowRoot && findDeep(element.shadowRoot, selector))
    .find(Boolean);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fleet = findDeep(document, 'fleet-canvas');
if (!fleet) throw new Error('fleet-canvas not found');
const fleetRoot = fleet.shadowRoot;
const buttonNamed = (text) =>
  [...fleetRoot.querySelectorAll('button')].find((button) => button.textContent.trim() === text);
const waitForEnabledButton = async (text) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const button = buttonNamed(text);
    if (button && !button.disabled) return button;
    await sleep(250);
  }
  throw new Error(`${text} button did not become ready`);
};

const assertPreview = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const preview = fleetRoot.querySelector('resource-cleanup-preview');
    const root = preview?.shadowRoot;
    if (root?.querySelector('[role="dialog"]')) {
      const text = root.textContent.replace(/\s+/g, ' ').trim();
      if (!text.includes('configured shutdown hook') || !text.includes('Active, held, manual')) {
        throw new Error('cleanup preview omitted effect or exclusion explanation');
      }
      const targets = root.querySelectorAll('.target').length;
      const checkboxes = [...root.querySelectorAll('input[type="checkbox"]')];
      if (checkboxes.length !== targets || checkboxes.some((checkbox) => !checkbox.checked)) {
        throw new Error('cleanup rows are not selected by default');
      }
      const modalButton = (label) =>
        [...root.querySelectorAll('button')].find((button) => button.textContent.trim() === label);
      const confirmButton = () =>
        [...root.querySelectorAll('button')].find((button) =>
          button.textContent.includes('selected resource'),
        );
      if (targets > 0) {
        modalButton('Clear')?.click();
        await preview.updateComplete;
        await sleep(0);
        if (!confirmButton()?.disabled)
          throw new Error('empty cleanup selection did not disable execution');
        modalButton('Select all')?.click();
        await preview.updateComplete;
        await sleep(0);
        if (confirmButton()?.disabled)
          throw new Error('Select all did not restore cleanup execution');
      } else if (!confirmButton()?.disabled) {
        throw new Error('zero-target cleanup preview did not disable execution');
      }
      return {
        targets,
        hasImpact: Boolean(root.querySelector('.impact-known')),
        empty: text.includes('No idle running or stale resources are eligible.'),
        selectionVerified: true,
      };
    }
    await sleep(250);
  }
  throw new Error('cleanup impact preview did not open');
};

const previewButton = await waitForEnabledButton('Preview cleanup');
previewButton.click();
const previewResult = await assertPreview();
const firstPreviewRoot = fleetRoot.querySelector('resource-cleanup-preview')?.shadowRoot;
[...(firstPreviewRoot?.querySelectorAll('button') ?? [])]
  .find((button) => button.textContent.trim() === 'Cancel')
  ?.click();
await sleep(100);

const stopButton = await waitForEnabledButton('Review & stop idle');
stopButton.click();
const stopResult = await assertPreview();
const pauseButton = buttonNamed('Pause watches');
const watchNote = fleetRoot.querySelector('.resource-watch-note')?.textContent.replace(/\s+/g, ' ');
if (
  !pauseButton?.title.includes('does not stop apps') ||
  !watchNote?.includes('marks resource status unknown')
) {
  throw new Error('watch pause impact is not explained in the control bar');
}

return {
  previewResult,
  stopResult,
  sameTwoStepFlow: previewResult.targets === stopResult.targets,
  watchPauseExplained: true,
  mutationPerformed: false,
};

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

const assertPreview = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const preview = fleetRoot.querySelector('resource-cleanup-preview');
    const root = preview?.shadowRoot;
    if (root?.querySelector('[role="dialog"]')) {
      const text = root.textContent.replace(/\s+/g, ' ').trim();
      if (!text.includes('configured shutdown hook') || !text.includes('Active, held, manual')) {
        throw new Error('cleanup preview omitted effect or exclusion explanation');
      }
      return {
        targets: root.querySelectorAll('.target').length,
        hasImpact: Boolean(root.querySelector('.impact-known')),
        empty: text.includes('No idle running or stale resources are eligible.'),
      };
    }
    await sleep(100);
  }
  throw new Error('cleanup impact preview did not open');
};

const previewButton = buttonNamed('Preview cleanup');
if (!previewButton) throw new Error('Preview cleanup button not found');
previewButton.click();
const previewResult = await assertPreview();
fleetRoot.querySelector('resource-cleanup-preview')?.shadowRoot?.querySelector('button')?.click();
await sleep(100);

const stopButton = buttonNamed('Review & stop idle');
if (!stopButton) throw new Error('Review & stop idle button not found');
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

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
let fixtureUsed = false;
const ensureSelectablePreview = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const preview = fleetRoot.querySelector('resource-cleanup-preview');
    const snapshot = fleet.resourceCleanupPreview;
    if (preview?.shadowRoot?.querySelector('[role="dialog"]') && snapshot) {
      if (snapshot.cleanupCandidates.length > 0) return;
      const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
      const machine = params.get('machines') ?? 'macwork';
      const project = params.get('projects') ?? 'proof-project';
      const slot = fleet.slots.find(
        (candidate) => candidate.machine === machine && candidate.project === project,
      );
      fleet.resourceCleanupPreview = {
        ...snapshot,
        summary: { ...snapshot.summary, cleanupCandidates: 1 },
        cleanupCandidates: [
          {
            machine,
            project,
            slotId: slot?.slot ?? `${machine}-proof-slot`,
            resourceId: '__ui_selection_proof__',
            label: 'UI selection proof fixture (confirmation intercepted)',
            status: 'stale',
            slotLifecycle: 'ready',
            currentRunId: null,
            effect: 'configured-shutdown-hook',
            activeWorkExcluded: true,
          },
        ],
      };
      fixtureUsed = true;
      await fleet.updateComplete;
      const updatedPreview = fleetRoot.querySelector('resource-cleanup-preview');
      await updatedPreview?.updateComplete;
      await updatedPreview?.updateComplete;
      return;
    }
    await sleep(250);
  }
  throw new Error('cleanup preview did not become available for selection proof');
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
      const modalButton = (label) =>
        [...root.querySelectorAll('button')].find((button) => button.textContent.trim() === label);
      let checkboxes = [...root.querySelectorAll('input[type="checkbox"]')];
      if (checkboxes.length !== targets || checkboxes.some((checkbox) => !checkbox.checked)) {
        if (!fixtureUsed) throw new Error('cleanup rows are not selected by default');
        modalButton('Select all')?.click();
        await preview.updateComplete;
        checkboxes = [...root.querySelectorAll('input[type="checkbox"]')];
        if (checkboxes.some((checkbox) => !checkbox.checked)) {
          throw new Error('fixture cleanup rows could not be selected');
        }
      }
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
      let confirmEventTargets = 0;
      if (targets > 0) {
        preview.addEventListener(
          'cleanup-preview-confirm',
          (event) => {
            event.stopImmediatePropagation();
            confirmEventTargets = event.detail?.targets?.length ?? 0;
          },
          { capture: true, once: true },
        );
        confirmButton()?.click();
        await sleep(0);
        if (confirmEventTargets !== targets) {
          throw new Error('second-step confirmation omitted selected exact targets');
        }
      }
      return {
        targets,
        hasImpact: Boolean(root.querySelector('.impact-known')),
        empty: text.includes('No idle running or stale resources are eligible.'),
        selectionVerified: true,
        confirmEventTargets,
      };
    }
    await sleep(250);
  }
  throw new Error('cleanup impact preview did not open');
};

const previewButton = await waitForEnabledButton('Preview cleanup');
previewButton.click();
await ensureSelectablePreview();
const previewResult = await assertPreview();
const firstPreviewRoot = fleetRoot.querySelector('resource-cleanup-preview')?.shadowRoot;
[...(firstPreviewRoot?.querySelectorAll('button') ?? [])]
  .find((button) => button.textContent.trim() === 'Cancel')
  ?.click();
await sleep(100);

const stopButton = await waitForEnabledButton('Review & stop idle');
stopButton.click();
await ensureSelectablePreview();
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
  confirmEventsIntercepted:
    previewResult.confirmEventTargets > 0 && stopResult.confirmEventTargets > 0,
  fixtureUsed,
};

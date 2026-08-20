const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fixture = document.querySelector('dev-harness machine-pause-dev');
if (!fixture) throw new Error('open #dev/machine-pause before running this probe');
const dialog = fixture.querySelector('machine-pause-dialog');
if (!dialog?.shadowRoot) throw new Error('machine pause dialog did not render');

const root = dialog.shadowRoot;
const panel = root.querySelector('[role="dialog"]');
if (!panel) throw new Error('accessible dialog panel missing');

const tabs = [...root.querySelectorAll('[role="tab"]')];
if (tabs.length !== 2) throw new Error(`expected two pause mode tabs, found ${tabs.length}`);
if (!tabs.some((tab) => tab.textContent.includes('Pause & release'))) {
  throw new Error('release pause mode is missing');
}

const processRows = [...root.querySelectorAll('.mpd-process')];
if (processRows.length < 3) throw new Error('expanded process attribution details are missing');
if (root.querySelector('.sparkline')) throw new Error('dialog duplicated the pressure graphs');
const unmappedNote = root.querySelector('[data-testid="machine-pause-unmapped-note"]');
if (
  !processRows.some((row) => row.textContent.includes('system / unmapped')) ||
  !unmappedNote?.textContent.includes('no verified Farmslot run, slot, or resource') ||
  !unmappedNote.textContent.includes('never cleanup-eligible')
) {
  throw new Error('unknown process ownership label or safety explanation is missing');
}

const previewRows = [...root.querySelectorAll('[data-testid="machine-pause-preview"] .mpd-run')];
const rejectedRows = previewRows.filter((row) => row.classList.contains('rejected'));
if (previewRows.length !== 3 || rejectedRows.length !== 1) {
  throw new Error('pause preview did not render eligible and rejected runs');
}
const rejectedCheckbox = rejectedRows[0].querySelector('input[type="checkbox"]');
if (!rejectedCheckbox?.disabled || !rejectedRows[0].textContent.includes('non-idempotent')) {
  throw new Error('rejected run is not disabled with its backend reason');
}

let restore = root.querySelector('[data-testid="machine-pause-restore-preview"]');
if (!restore || restore.querySelectorAll('.mpd-run').length !== 2) {
  throw new Error('selective restore preview is missing');
}
const status = root.querySelector('[data-testid="machine-pause-status"]');
if (
  !status?.textContent.includes('resource-hook-failed') &&
  !status?.textContent.includes('Project shutdown hook exited 1')
) {
  throw new Error('durable action errors are missing');
}
if (!status.textContent.includes('Residual runner')) {
  throw new Error('residual worker/resource state is missing');
}

let pauseExecute = root.querySelector('[data-testid="machine-pause-execute"]');
let restoreExecute = root.querySelector('[data-testid="machine-pause-restore-execute"]');
let confirm = root.querySelector('.mpd-confirm input[type="checkbox"]');
if (!confirm) throw new Error('explicit confirmation control is missing');
if (confirm.checked) {
  confirm.click();
  await sleep(0);
}
if (!pauseExecute?.disabled || !restoreExecute?.disabled) {
  throw new Error('mutations must require explicit confirmation');
}

const buttonWithText = (section, text) =>
  [...section.querySelectorAll('button')].find((button) => button.textContent.includes(text));
const pauseSection = root.querySelector('[data-testid="machine-pause-preview"]');
const pauseClear = buttonWithText(pauseSection, 'Clear');
const restoreClear = buttonWithText(restore, 'Clear');
if (!pauseClear || !restoreClear) throw new Error('Clear controls are missing');
pauseClear.click();
restoreClear.click();
await sleep(20);

const checkedAfterClear = root.querySelectorAll(
  '[data-testid="machine-pause-preview"] .mpd-run input:checked, [data-testid="machine-pause-restore-preview"] .mpd-run input:checked',
);
pauseExecute = root.querySelector('[data-testid="machine-pause-execute"]');
restoreExecute = root.querySelector('[data-testid="machine-pause-restore-execute"]');
confirm = root.querySelector('.mpd-confirm input[type="checkbox"]');
if (checkedAfterClear.length !== 0) throw new Error('Clear left backend-selected rows checked');
if (!pauseExecute?.disabled || !restoreExecute?.disabled) {
  throw new Error('Clear did not disable both exact mutation controls');
}
confirm.click();
await sleep(0);
if (!pauseExecute.disabled || !restoreExecute.disabled) {
  throw new Error('confirmation enabled an empty mutation batch');
}

const pauseSelectAll = buttonWithText(
  root.querySelector('[data-testid="machine-pause-preview"]'),
  'Select all eligible',
);
restore = root.querySelector('[data-testid="machine-pause-restore-preview"]');
const restoreSelectAll = buttonWithText(restore, 'Select all eligible');
if (!pauseSelectAll || !restoreSelectAll)
  throw new Error('Select all eligible controls are missing');
pauseSelectAll.click();
restoreSelectAll.click();
await sleep(20);

pauseExecute = root.querySelector('[data-testid="machine-pause-execute"]');
restoreExecute = root.querySelector('[data-testid="machine-pause-restore-execute"]');
confirm = root.querySelector('.mpd-confirm input[type="checkbox"]');
if (confirm.checked) throw new Error('selection refresh did not reset confirmation');
confirm.click();
await sleep(0);
if (pauseExecute.disabled || restoreExecute.disabled) {
  throw new Error('reviewed eligible selections did not re-enable exact actions');
}

return {
  machine: dialog.machine,
  modeTabs: tabs.length,
  processRows: processRows.length,
  unknownOwnershipLabel: 'system / unmapped',
  previewRows: previewRows.length,
  rejectedDisabled: rejectedCheckbox.disabled,
  restoreRows: restore.querySelectorAll('.mpd-run').length,
  confirmationRequired: true,
  clearDisabledMutations: true,
  eligibleReselectionEnabledMutations: true,
  durableStatus: true,
  duplicatedGraphs: false,
};

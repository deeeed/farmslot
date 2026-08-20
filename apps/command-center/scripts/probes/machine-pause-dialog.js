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
const pressureValues = [
  ...root.querySelectorAll('[data-testid="machine-pause-pressure"] .mpd-stat-value'),
].map((value) => value.textContent.trim());
if (pressureValues[0] !== '88%' || pressureValues[1] !== '84%' || pressureValues[2] !== '1.32×') {
  throw new Error(`pressure formats are incorrect: ${pressureValues.join(', ')}`);
}
const sampler = root.querySelector('[data-testid="machine-pause-sampler"]');
const degraded = root.querySelector('[data-testid="machine-pause-sampler-degraded"]');
const compactText = (element) => element?.textContent.replace(/\s+/g, ' ').trim() ?? '';
const samplerText = compactText(sampler);
const degradedText = compactText(degraded);
const rootText = compactText(root);
if (
  !samplerText.includes('84ms') ||
  !samplerText.includes('12 executions') ||
  !samplerText.includes('8 avoided probes') ||
  !samplerText.includes('1 failures') ||
  !samplerText.includes('Process inventory timed out once') ||
  !degradedText.includes('last complete bounded sample') ||
  !rootText.includes('3 lower-pressure group(s) omitted') ||
  !rootText.includes('Sustained CPU and memory pressure')
) {
  throw new Error('sampler diagnostics, truncation, degradation, or concerns are incomplete');
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
if (status.querySelector('.mpd-residuals') || !status.textContent.includes('Observed state')) {
  throw new Error('healthy known residual states were rendered as warnings');
}

let pauseExecute = root.querySelector('[data-testid="machine-pause-execute"]');
let restoreExecute = root.querySelector('[data-testid="machine-pause-restore-execute"]');
let pauseConfirm = root.querySelector('[data-testid="machine-pause-confirm"]');
let restoreConfirm = root.querySelector('[data-testid="machine-restore-confirm"]');
if (!pauseConfirm || !restoreConfirm) throw new Error('scoped confirmation controls are missing');
for (const checkbox of [pauseConfirm, restoreConfirm]) {
  if (checkbox.checked) checkbox.click();
}
await sleep(0);
if (!pauseExecute?.disabled || !restoreExecute?.disabled) {
  throw new Error('mutations must require explicit confirmation');
}

const restoreEvents = [];
dialog.addEventListener('machine-pause-restore', (event) => restoreEvents.push(event.detail));

// Confirming restore must not arm pause. The fixture applies the emitted all selector and then
// returns an exclude preview, just as a backend refresh would.
restoreConfirm.click();
await sleep(0);
if (restoreExecute.disabled || !pauseExecute.disabled) {
  throw new Error('restore confirmation armed the wrong action');
}
restoreExecute.click();
await sleep(20);
if (
  restoreEvents.length !== 1 ||
  restoreEvents[0].selector.kind !== 'all' ||
  restoreEvents[0].execute !== true
) {
  throw new Error(
    `default all restore selector was not preserved: ${JSON.stringify(restoreEvents)}`,
  );
}

pauseExecute = root.querySelector('[data-testid="machine-pause-execute"]');
restoreExecute = root.querySelector('[data-testid="machine-pause-restore-execute"]');
pauseConfirm = root.querySelector('[data-testid="machine-pause-confirm"]');
restoreConfirm = root.querySelector('[data-testid="machine-restore-confirm"]');
if (pauseConfirm.checked || restoreConfirm.checked) {
  throw new Error('restore preview refresh did not reset scoped confirmation');
}
pauseConfirm.click();
await sleep(0);
if (pauseExecute.disabled || !restoreExecute.disabled) {
  throw new Error('pause confirmation armed the wrong action');
}
pauseConfirm.click();
restoreConfirm.click();
await sleep(0);
restoreExecute.click();
await sleep(20);
if (
  restoreEvents.length !== 2 ||
  restoreEvents[1].selector.kind !== 'exclude' ||
  restoreEvents[1].selector.runIds.join(',') !== 'run-monitor-18'
) {
  throw new Error(`exclude restore selector was not preserved: ${JSON.stringify(restoreEvents)}`);
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
pauseConfirm = root.querySelector('[data-testid="machine-pause-confirm"]');
restoreConfirm = root.querySelector('[data-testid="machine-restore-confirm"]');
if (checkedAfterClear.length !== 0) throw new Error('Clear left backend-selected rows checked');
if (!pauseExecute?.disabled || !restoreExecute?.disabled) {
  throw new Error('Clear did not disable both exact mutation controls');
}
pauseConfirm.click();
restoreConfirm.click();
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
pauseConfirm = root.querySelector('[data-testid="machine-pause-confirm"]');
restoreConfirm = root.querySelector('[data-testid="machine-restore-confirm"]');
if (pauseConfirm.checked || restoreConfirm.checked) {
  throw new Error('selection refresh did not reset scoped confirmations');
}
restoreConfirm.click();
await sleep(0);
if (restoreExecute.disabled || !pauseExecute.disabled) {
  throw new Error('restore-only confirmation did not remain scoped after reselection');
}
restoreConfirm.click();
pauseConfirm.click();
await sleep(0);
if (pauseExecute.disabled || !restoreExecute.disabled) {
  throw new Error('pause-only confirmation did not remain scoped after reselection');
}
restoreConfirm.click();
await sleep(0);
if (pauseExecute.disabled || restoreExecute.disabled) {
  throw new Error('reviewed eligible selections did not re-enable their exact actions');
}
// Return the fixture to its default-all preview through the same restore event path so the probe
// remains repeatable without writing component state.
restoreExecute.click();
await sleep(20);
if (restoreEvents[2]?.selector.kind !== 'include') {
  throw new Error('eligible reselection did not emit its reviewed include selector');
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
  confirmationsScoped: true,
  restoreSelectors: restoreEvents.slice(0, 2).map((event) => event.selector.kind),
  loadPerCore: pressureValues[2],
  samplerDiagnostics: true,
  clearDisabledMutations: true,
  eligibleReselectionEnabledMutations: true,
  durableStatus: true,
  duplicatedGraphs: false,
};

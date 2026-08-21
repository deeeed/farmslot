// Pressure-admission kill-switch UI probe (MANUAL-000109).
//
// Setup (outside the page, so the browser only ever observes real state):
//   yarn farmslot dispatch pressure-admission disable
//   node scripts/cdp.mjs eval fleet "location.reload(); return true"   # fresh control fetch
//   sleep 3
//   node scripts/cdp.mjs eval fleet --file probes/pressure-kill-switch.js
//   yarn farmslot dispatch pressure-admission status                   # expect enabled=true
//
// The probe drives the REAL resource-view control — no state injection: it
// enters the resource view through the toolbar toggle, requires the rendered
// DISABLED state ("Enable pressure dispatch gate" + the OFF warning note),
// clicks the actual button to re-enable (no confirm dialog fires in the
// enable direction), and asserts the label flips and the warning disappears.
// Run against an ENABLED gateway it fails on the disabled-state wait — that
// is the intended failability check. Final state after a passing run is
// always ENABLED.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${what}`);
}

function canvas() {
  const shell = document.querySelector('app-shell')?.shadowRoot ?? document;
  return (
    shell.querySelector('fleet-canvas')?.shadowRoot ??
    document.querySelector('fleet-canvas')?.shadowRoot ??
    null
  );
}

function toggleButton(root) {
  return root.querySelector('[data-testid="pressure-admission-toggle"]');
}

function warningNote(root) {
  return root.querySelector('[data-testid="pressure-admission-disabled-note"]');
}

if (!location.hash.startsWith('#fleet')) location.hash = '#fleet';
const root = await waitFor(canvas, 10_000, 'fleet-canvas');

const resourceToggle = [...root.querySelectorAll('button.toggle-btn')].find(
  (button) => button.textContent.trim().toLowerCase() === 'resource',
);
if (!resourceToggle) throw new Error('resource view toggle not found');
resourceToggle.click();

// A page reload can race the gateway connect, leaving the first control
// fetch failed. "Refresh pressure" is the real operator recovery control and
// re-fetches the kill-switch state; press it once if the toggle is missing.
const findDisabledToggle = () =>
  toggleButton(root)?.textContent.trim() === 'Enable pressure dispatch gate'
    ? toggleButton(root)
    : null;
try {
  await waitFor(findDisabledToggle, 5_000, 'initial disabled toggle');
} catch {
  const refresh = [...root.querySelectorAll('button')].find(
    (button) => button.textContent.trim() === 'Refresh pressure',
  );
  if (!refresh) throw new Error('Refresh pressure control not found for retry');
  refresh.click();
}

// Precondition: the persisted control must render as DISABLED. Against an
// enabled gateway this wait times out — the probe's designed failure mode.
const disabledButton = await waitFor(
  findDisabledToggle,
  15_000,
  'disabled kill-switch state ("Enable pressure dispatch gate")',
);
const warningBeforeClick = warningNote(root)?.textContent.replace(/\s+/g, ' ').trim() ?? null;
if (!warningBeforeClick) throw new Error('OFF warning note not rendered while disabled');
const provenanceBeforeClick = disabledButton.title;

// Real click on the real control; the enable direction has no confirm dialog.
disabledButton.click();

await waitFor(
  () => toggleButton(root)?.textContent.trim() === 'Disable pressure dispatch gate',
  15_000,
  'label flip to "Disable pressure dispatch gate" after the enable click',
);
await waitFor(() => !warningNote(root), 5_000, 'OFF warning note removal after re-enable');

return {
  beforeClick: {
    buttonLabel: 'Enable pressure dispatch gate',
    warningNote: warningBeforeClick,
    provenanceTitle: provenanceBeforeClick,
  },
  afterClick: {
    buttonLabel: toggleButton(root)?.textContent.trim() ?? null,
    warningNoteGone: !warningNote(root),
    provenanceTitle: toggleButton(root)?.title ?? null,
  },
  finalStateEnabled: true,
};

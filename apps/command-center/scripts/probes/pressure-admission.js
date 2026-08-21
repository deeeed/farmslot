// Pressure-admission dispatch wizard probe (MANUAL-000109).
//
// Run with: node scripts/cdp.mjs eval dispatch --file probes/pressure-admission.js
//
// Drives the REAL dispatch wizard against live gateway data — no state
// injection. Requires a machine whose sustained-pressure decision is rejected
// (live proof uses the validation fixture machine). Configure via globals
// window.__pressureProbeSlot / window.__pressureProbeProject or defaults.
//
// Flow: pick the fix-bug flow, type the ticket through the real input handler,
// pick the project, wait for dispatch.candidates, then activate the rejected
// row's Override action and read the rendered backend decision panel.

const SLOT = window.__pressureProbeSlot ?? 'demo-ff-1';
const PROJECT = window.__pressureProbeProject ?? 'farmslot-farm';
const TICKET = window.__pressureProbeTicket ?? 'MANUAL-000109';

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

function wizard() {
  return document.querySelector('dispatch-wizard')?.shadowRoot ?? null;
}

function pillByText(root, text) {
  return [...root.querySelectorAll('button.pill')].find((button) =>
    button.textContent.trim().toLowerCase().startsWith(text.toLowerCase()),
  );
}

if (location.hash !== '#dispatch') location.hash = '#dispatch';
const root = await waitFor(wizard, 10_000, 'dispatch wizard');

const flowButton = await waitFor(() => pillByText(root, 'fix bug'), 10_000, 'fix-bug flow pill');
flowButton.click();

const ticketInput = await waitFor(() => root.querySelector('.ticket-input'), 5_000, 'ticket input');
ticketInput.focus();
ticketInput.value = TICKET;
ticketInput.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));

const projectButton = await waitFor(() => pillByText(root, PROJECT), 10_000, 'project pill');
projectButton.click();

// Candidates load asynchronously (dispatch.candidates over the live gateway).
const choiceList = await waitFor(
  () => root.querySelector('slot-choice-list')?.shadowRoot ?? null,
  30_000,
  'candidate list',
);
// Slot-exact: resolve the row whose slotId property is the target slot, then
// look for the Override action only inside THAT row's slotted content. A
// wrong/admitted target slot must fail here, never fall through to some other
// rejected row's button.
const targetRow = await waitFor(
  () =>
    [...choiceList.querySelectorAll('slot-choice-row')].find((row) => row.slotId === SLOT) ?? null,
  30_000,
  `candidate row for ${SLOT}`,
);
const overrideButton = await waitFor(
  () =>
    [...targetRow.querySelectorAll('button.choice-action')].find(
      (button) => button.textContent.trim() === 'Override',
    ) ?? null,
  15_000,
  `Override action on the pressure-rejected row ${SLOT}`,
);
overrideButton.click();

const panel = await waitFor(
  () => root.querySelector('[data-testid="pressure-admission-panel"]'),
  10_000,
  'pressure decision panel',
);
const panelText = panel.textContent.replace(/\s+/g, ' ').trim();

// Deliberate override interaction through the real controls.
const confirm = panel.querySelector('[data-testid="pressure-override-confirm"]');
const reason = panel.querySelector('[data-testid="pressure-override-reason"]');
let overrideControls = null;
if (confirm && reason) {
  confirm.click();
  reason.focus();
  reason.value = 'live validation proof: one dispatch, dedicated validation target';
  reason.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
  await sleep(200);
  overrideControls = { confirmed: confirm.checked, reason: reason.value };
}

return {
  slot: SLOT,
  project: PROJECT,
  panelShown: true,
  rejectionCode: (panelText.match(/PRESSURE_[A-Z_]+/) ?? [null])[0],
  showsSamples: /consecutive critical samples/.test(panelText),
  showsGeneration: /Evidence generation:/.test(panelText),
  showsRefresh: [...panel.querySelectorAll('[data-testid="pressure-refresh"]')].length === 1,
  showsCauses: /Attributed causes/.test(panelText) || /not a cleanup target/.test(panelText),
  overrideControls,
  panelText: panelText.slice(0, 600),
};

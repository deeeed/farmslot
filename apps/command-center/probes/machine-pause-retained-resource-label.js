// Drives the real machine-pause dialog on the fleet map and reads what an
// operator actually sees for a manifest resource the project catalog retains.
//
// No state injection: it clicks the pressure-details control that opens the
// dialog, clicks the dialog's own "Pause & release" mode button, and reads the
// rendered preview rows. Every value comes from the live gateway preview.
//
//   node apps/command-center/scripts/cdp.mjs eval fleet \
//     --file apps/command-center/probes/machine-pause-retained-resource-label.js
//
// Set FARMSLOT_PROBE_MACHINE in the page URL hash or edit MACHINE below when
// the slot under test is not on macwork.
const MACHINE = 'macwork';

function deepFind(root, selector) {
  const hit = root.querySelector?.(selector);
  if (hit) return hit;
  for (const node of root.querySelectorAll?.('*') ?? []) {
    if (node.shadowRoot) {
      const found = deepFind(node.shadowRoot, selector);
      if (found) return found;
    }
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A dialog left open from an earlier look still holds the preview it fetched
// then. Close it and reopen so the rows below come from a preview taken now.
let dialog = deepFind(document, 'machine-pause-dialog');
if (dialog) {
  const openRoot = dialog.shadowRoot ?? dialog;
  [...openRoot.querySelectorAll('button')]
    .find((button) => button.textContent.trim() === 'Close')
    ?.click();
  await sleep(1500);
}
const opener = deepFind(document, `[data-testid="pressure-details-${MACHINE}"]`);
if (!opener) return JSON.stringify({ error: `no pressure-details control for ${MACHINE}` });
opener.click();
await sleep(3000);
dialog = deepFind(document, 'machine-pause-dialog');
if (!dialog) return JSON.stringify({ error: 'machine-pause-dialog never mounted' });

let root = dialog.shadowRoot ?? dialog;
const release = [...root.querySelectorAll('button')].find((button) =>
  /Pause & release/i.test(button.textContent || ''),
);
if (release) release.click();

// A backstop while the reopened dialog is still fetching: its own Refresh
// control, not a write into component state.
const clickRefresh = () =>
  [...root.querySelectorAll('button')]
    .find((button) => button.textContent.trim() === 'Refresh')
    ?.click();

let section = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  await sleep(1000);
  dialog = deepFind(document, 'machine-pause-dialog');
  if (!dialog) continue;
  root = dialog.shadowRoot ?? dialog;
  section = root.querySelector('[data-testid="machine-pause-preview"]');
  if (section?.querySelector('.mpd-run')) break;
  if (attempt === 10 || attempt === 25) clickRefresh();
}
if (!section) return JSON.stringify({ error: 'release preview never rendered a row' });

const previewRows = [...section.querySelectorAll('.mpd-run')].map((row) => ({
  runId: row.querySelector('.mpd-run-title')?.textContent.trim() ?? null,
  meta: row.querySelector('.mpd-run-meta')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
  resources: row.querySelector('.mpd-resources')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
}));

// The parked-record section is where a retained resource must NOT be reported
// as an unexpected residual, since a parked release record shows it running.
const statusSection = root.querySelector('[data-testid="machine-pause-status"]');
const parkedRecords = [...(statusSection?.querySelectorAll('.mpd-run') ?? [])].map((row) => ({
  runId: row.querySelector('.mpd-run-title')?.textContent.trim() ?? null,
  summary: row.querySelector('.mpd-phase')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
}));

return JSON.stringify(
  {
    machine: MACHINE,
    previewRows,
    parkedRecords,
    keptRunningRendered: (section.textContent || '').includes('kept running'),
    unexpectedResourceWarning: (statusSection?.textContent || '').includes('unexpected resource'),
  },
  null,
  1,
);

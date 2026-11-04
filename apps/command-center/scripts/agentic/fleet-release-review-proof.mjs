import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const output = process.env.FARMSLOT_PROOF_OUT;
const origin = process.env.FARMSLOT_PROOF_UI_ORIGIN;
const endpoint = process.env.FARMSLOT_CDP_ENDPOINT;
const browserModule = process.env.FARMSLOT_PROOF_BROWSER_MODULE;
assert(output && origin && endpoint && browserModule);
assert.equal(new URL(endpoint).hostname, '127.0.0.1');
const { chromium } = await import(pathToFileURL(browserModule).href);
const browser = await chromium.connectOverCDP(endpoint);
const page = await browser.contexts()[0].newPage();
const connections = [];
const reads = new Map();
const timings = [];
const commands = [];
const held = [];
let holdFleet = false;
const until = async (read, valid, label) => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const result = await read();
    if (valid(result)) return result;
    assert(Date.now() < deadline, `${label}: ${JSON.stringify(result)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const snapshot = () =>
  page.evaluate(() => {
    const view = document.querySelector('fleet-canvas');
    const button = view?.shadowRoot.querySelector('.fleet-refresh-trigger');
    return {
      status: view?.fleetObservation.status,
      slots: view?.slots.length ?? 0,
      selected: [...(view?.selectedSlotIds ?? [])],
      disabled: button?.disabled,
      label: button?.textContent.trim(),
      hint: view?.shadowRoot.querySelector('.fleet-release-hint')?.textContent.trim(),
    };
  });
await fs.mkdir(output, { recursive: true });
try {
  await page.routeWebSocket('**/ws', (client) => {
    const server = client.connectToServer();
    connections.push(server);
    client.onMessage((data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'req') {
        if (['fleet.status', 'gateway.status'].includes(frame.method))
          reads.set(frame.id, { method: frame.method, start: performance.now() });
        if (['fleet.refreshSlots', 'slot.refresh'].includes(frame.method))
          commands.push(frame.method);
      }
      server.send(data);
    });
    server.onMessage((data) => {
      const frame = JSON.parse(String(data));
      const read = reads.get(frame.id);
      if (frame.type === 'res' && read) {
        timings.push({ method: read.method, ms: performance.now() - read.start, ok: frame.ok });
        reads.delete(frame.id);
        if (holdFleet && read.method === 'fleet.status') {
          held.push(() => client.send(data));
          return;
        }
      }
      client.send(data);
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/#fleet`, { waitUntil: 'domcontentloaded' });
  await until(snapshot, (value) => value.slots > 1, 'Real fleet rows');
  const dismiss = page.locator('whats-new-modal').getByRole('button', { name: 'Got it' });
  if (await dismiss.isVisible()) await dismiss.click();
  const slots = await page.locator('fleet-canvas').evaluate((view) =>
    view.filteredSlots
      .filter((slot) => slot.lifecycle === 'ready' && slot.enabled && slot.agent !== 'working')
      .slice(0, 2)
      .map((slot) => slot.slot),
  );
  assert.equal(slots.length, 2, 'Two real idle slots must be visible');
  for (const slot of slots)
    await page.getByRole('checkbox', { name: `Select ${slot}`, exact: true }).check();

  // Close only this proof tab's connection, then hold its real fleet replies.
  // This creates a stale read without writing application state or farm data.
  holdFleet = true;
  assert(connections.length);
  connections.at(-1).close({ code: 1012, reason: 'Read-only release review proof' });
  const stale = await until(
    snapshot,
    (value) => value.slots > 1 && value.status !== 'ready' && value.selected.length === 2,
    'Retained selected rows after reconnect',
  );
  await fs.writeFile(path.join(output, 'stale-selection.json'), JSON.stringify(stale, null, 2));
  await page.screenshot({ path: path.join(output, 'stale-selection.png') });
  assert.equal(stale.disabled, false, 'Selected shown slots must open the release review');
  await page.locator('.fleet-refresh-trigger').click();
  const modal = page.locator('fleet-refresh-modal');
  await modal.getByRole('dialog').waitFor();
  const pending = await modal.evaluate((view) => ({
    inspecting: view.model.inspecting,
    canRelease: view.model.canRelease,
    rows: view.model.rows.map((row) => row.slotId),
    enabledReleases: [...view.shadowRoot.querySelectorAll('button')].filter(
      (button) => /^(Release|Discard)/.test(button.textContent.trim()) && !button.disabled,
    ).length,
  }));
  assert.equal(pending.inspecting, true);
  assert.equal(pending.canRelease, false);
  assert.equal(pending.enabledReleases, 0);
  assert.deepEqual(pending.rows, slots);
  assert.deepEqual(commands, []);
  await page.screenshot({ path: path.join(output, 'inspection-pending.png') });
  await until(
    () => held.length,
    (count) => count > 0,
    'Real inspection reply',
  );
  holdFleet = false;
  held.splice(0).forEach((send) => send());
  const current = await until(
    () =>
      modal.evaluate((view) => ({
        inspecting: view.model.inspecting,
        canRelease: view.model.canRelease,
        error: view.model.error,
        rows: view.model.rows.map((row) => ({
          slotId: row.slotId,
          allowed: row.eligibility.allowed,
          reason: row.eligibility.reason,
        })),
      })),
    (value) => !value.inspecting,
    'Inspection settles from the real gateway reply',
  );
  assert.deepEqual(commands, [], 'Opening and inspecting never releases a slot');
  await page.screenshot({ path: path.join(output, 'inspection-result.png') });
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ pass: true, stale, pending, current, timings, commands }, null, 2),
  );
} finally {
  holdFleet = false;
  await fs.writeFile(path.join(output, 'timings.json'), JSON.stringify(timings, null, 2));
  await page.close();
  await browser.close();
}

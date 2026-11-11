import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { routeCandidateUiSource } from './candidate-ui-source.mjs';

const origin = process.env.FARMSLOT_PROOF_UI_ORIGIN;
const source = process.env.FARMSLOT_PROOF_SOURCE_ORIGIN;
const endpoint = process.env.FARMSLOT_CDP_ENDPOINT;
const output = process.env.FARMSLOT_PROOF_OUT;
const browserModule = process.env.FARMSLOT_PROOF_BROWSER_MODULE;
assert(origin && endpoint && output && browserModule);
assert.equal(new URL(endpoint).hostname, '127.0.0.1');
const execFile = promisify(execFileCallback);
const helper = fileURLToPath(new URL('../cdp.mjs', import.meta.url));
async function rpc(method, params) {
  const { stdout } = await execFile(
    process.execPath,
    [helper, 'gateway', method, JSON.stringify(params)],
    {
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout);
}
const running = (run) => !['done', 'failed', 'cancelled'].includes(run.status);
const { runs } = await rpc('run.list', { flowType: 'review-pr', limit: 100 });
const selected = process.env.FARMSLOT_PROOF_RUN_ID
  ? runs.find((run) => run.id === process.env.FARMSLOT_PROOF_RUN_ID)
  : (runs.find((run) => run.reviewWorkspace && running(run)) ??
    runs.find((run) => run.reviewWorkspace));
assert(selected?.reviewWorkspace, 'No static review with an allocated workspace');
if (process.argv.includes('--require-running'))
  assert(running(selected), 'No running static review available');
const workspace = selected.reviewWorkspace;
const { chromium } = await import(pathToFileURL(browserModule).href);
const browser = await chromium.connectOverCDP(endpoint);
const page = await browser.contexts()[0].newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let stopRouting;
await mkdir(output, { recursive: true });
try {
  if (source)
    stopRouting = await routeCandidateUiSource(page, {
      origin,
      source,
      root: new URL('../../../../', import.meta.url).pathname,
    });
  const target = new URL(origin);
  target.hash = `run/${selected.id}`;
  await page.goto(target.href, { waitUntil: 'domcontentloaded' });
  const detail = page.locator('run-detail');
  const header = detail.getByTestId('run-workspace-location');
  await header.waitFor({ state: 'visible', timeout: 120000 });
  const expectedMissing = process.argv.includes('--expect-missing');
  if (expectedMissing) {
    assert.equal(await header.getByTestId('review-checkout-path').count(), 0);
  } else {
    assert.equal(
      await header.getByTestId('review-checkout-path').innerText(),
      workspace.checkoutPath,
    );
    assert((await header.innerText()).includes(workspace.machine));
    assert((await header.innerText()).includes(workspace.workspaceId));
  }
  await header.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'header.png') });
  const panel = detail.locator('[data-panel="run-sessions"]');
  if ((await panel.getAttribute('data-open')) !== 'true')
    await panel.getByTestId('run-sessions-toggle').click();
  const row = panel
    .locator('[data-testid^="run-agent-session-"]')
    .filter({ has: page.locator('[data-role="review"]') })
    .first();
  await row.waitFor({ state: 'visible' });
  if (expectedMissing) {
    assert.equal(await row.getByTestId('review-checkout-path').count(), 0);
  } else {
    assert.equal(await row.getByTestId('review-checkout-path').innerText(), workspace.checkoutPath);
    assert((await row.innerText()).includes(workspace.workspaceId));
  }
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'reviewer.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  if (!expectedMissing) {
    await row.scrollIntoViewIfNeeded();
    const bounds = await row.getByTestId('review-checkout-path').boundingBox();
    assert(
      bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391,
      'Checkout must wrap inside the viewport',
    );
  }
  await page.screenshot({ path: path.join(output, 'narrow.png') });
  const current = await rpc('run.get', { runId: selected.id });
  const after = current.run ?? current;
  if (process.argv.includes('--require-running'))
    assert(running(after), 'Review finished before proof completed');
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        runId: selected.id,
        statusBefore: selected.status,
        statusAfter: after.status,
        workspace,
        expectedMissing,
        errors,
        source: source ?? 'deployed',
      },
      null,
      2,
    ),
  );
} finally {
  if (stopRouting) await stopRouting();
  await page.close();
  await browser.close();
}

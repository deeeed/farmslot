import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const origin = process.env.FARMSLOT_PROOF_UI_ORIGIN;
const source = process.env.FARMSLOT_PROOF_SOURCE_ORIGIN;
const endpoint = process.env.FARMSLOT_CDP_ENDPOINT;
const output = process.env.FARMSLOT_PROOF_OUT;
const browserModule = process.env.FARMSLOT_PROOF_BROWSER_MODULE;
assert(origin && source && endpoint && output && browserModule);
assert.equal(new URL(endpoint).hostname, '127.0.0.1');
const execFile = promisify(execFileCallback);
const gatewayHelper =
  process.env.FARMSLOT_PROOF_GATEWAY_HELPER ??
  fileURLToPath(new URL('../cdp.mjs', import.meta.url));
const { enumerateChecklistCheckboxes } = createRequire(import.meta.url)(
  '../../../../packages/agent-runtime/scripts/checklist-target.cjs',
);
async function rpc(method, params) {
  const { stdout } = await execFile(
    process.execPath,
    [gatewayHelper, 'gateway', method, JSON.stringify(params)],
    { env: process.env, cwd: path.dirname(gatewayHelper), maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}
const { chromium } = await import(pathToFileURL(browserModule).href);
const browser = await chromium.connectOverCDP(endpoint);
const page = await browser.contexts()[0].newPage();
const errors = [];
let stopRouting;
page.on('pageerror', (error) => errors.push(error.message));
await mkdir(output, { recursive: true });
try {
  // Source-only proxy keeps the existing agent-owned login on its original origin.
  // Gateway requests and authentication stay on that origin, without credential reads.
  const proxy = async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/' || url.pathname.startsWith('/api/') || url.pathname === '/ws')
      return route.continue();
    if (url.pathname === '/@vite/client')
      return route.fulfill({
        contentType: 'text/javascript',
        body: 'const styles=new Map();export const createHotContext=()=>({on(){},accept(){},prune(){},dispose(){},data:{}});export const injectQuery=(url)=>url;export function updateStyle(id,css){let s=styles.get(id);if(!s){s=document.createElement("style");document.head.append(s);styles.set(id,s)}s.textContent=css}export function removeStyle(id){styles.get(id)?.remove();styles.delete(id)}',
      });
    const response = await fetch(new URL(url.pathname + url.search, source));
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(
        [...response.headers].filter(
          ([key]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(key),
        ),
      ),
      body: Buffer.from(await response.arrayBuffer()),
    });
  };
  await page.route(`${origin}/**`, proxy);
  const workerSourcePattern = `${origin}/@fs${new URL('../../../../', import.meta.url).pathname}**`;
  await browser.contexts()[0].route(workerSourcePattern, proxy);
  stopRouting = () => browser.contexts()[0].unroute(workerSourcePattern, proxy);
  const live = await rpc('run.list', { active: true });
  const candidates = live.runs
    .filter((run) => run.slotId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const attempts = [];
  let selected;
  for (const run of candidates.slice(0, 12)) {
    let progress;
    try {
      progress = await rpc('task.progress', { slotId: run.slotId, runId: run.id });
    } catch (error) {
      attempts.push({ runId: run.id, readFailure: error.message });
      continue;
    }
    const row = enumerateChecklistCheckboxes(progress.markdown ?? '').find(
      (item) => item.detail && item.detail.length < 2500,
    );
    const step =
      row &&
      progress.structured?.phases
        .flatMap((phase) => phase.steps)
        .find((step) => step.index === row.stepNumber);
    attempts.push({
      runId: run.id,
      slotId: run.slotId,
      markdownBytes: progress.markdown?.length ?? 0,
      detailFound: !!step,
    });
    if (step && row) {
      selected = {
        runId: run.id,
        slotId: run.slotId,
        contextId: progress.contextId,
        stepIndex: step.index,
        stepTitle: step.name,
        detail: row.detail,
      };
      break;
    }
  }
  assert(
    selected,
    `No bound active run provides detail: ${JSON.stringify({ activeCount: live.runs.length, attempts })}`,
  );
  selected.attempts = attempts;
  await writeFile(path.join(output, 'selected.json'), JSON.stringify(selected, null, 2));
  const target = new URL(origin);
  target.hash = `run/${selected.runId}`;
  await page.bringToFront();
  await page.goto(target.href, { waitUntil: 'domcontentloaded' });
  const title = page
    .locator('progress-tracker')
    .getByText(selected.stepTitle, { exact: true })
    .first();
  await title.waitFor({ state: 'visible', timeout: 120000 });
  await title.scrollIntoViewIfNeeded();
  const renderedRunId = await title.evaluate((element) => element.getRootNode().host.runId);
  assert.equal(renderedRunId, selected.runId);
  assert.equal(await page.locator('.sv-recovery-overlay').count(), 0);
  const collapsed = await title.evaluate((element) => ({
    open: element.closest('details').open,
    text: element.textContent,
  }));
  assert.equal(collapsed.open, false);
  await page.screenshot({ path: path.join(output, 'collapsed.png') });
  await title.click();
  await page.waitForFunction(() =>
    new URLSearchParams(location.hash.split('?')[1]).has('stepDetails'),
  );
  const expanded = await title.evaluate((element) => {
    const details = element.closest('details');
    return {
      open: details.open,
      detail: details.querySelector('.step-instructions').textContent,
      visibleHeight: details.querySelector('.step-instructions').getBoundingClientRect().height,
    };
  });
  assert.equal(expanded.open, true);
  assert.equal(expanded.detail, selected.detail);
  assert(expanded.visibleHeight > 0);
  await page.screenshot({ path: path.join(output, 'expanded.png') });
  await title.click();
  await page.waitForFunction(
    () => !new URLSearchParams(location.hash.split('?')[1]).has('stepDetails'),
  );
  const closedAgain = await title.evaluate((element) => element.closest('details').open);
  assert.equal(closedAgain, false);
  const result = { selected, renderedRunId, collapsed, expanded, closedAgain, pageErrors: errors };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  assert.equal(errors.length, 0, errors.join('\n'));
} catch (error) {
  await writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify({ message: error.message, pageErrors: errors }, null, 2),
  );
  throw error;
} finally {
  await stopRouting?.();
  await page.close();
  await browser.close();
}

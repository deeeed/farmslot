import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CdpWebPage } from '../../../../packages/recipe-runner/src/runtime/cdp.js';

// Read-only DOM geometry. Inputs and state changes use CdpWebPage's real interactions.
const geometry = `(() => {
  const view = document.querySelector('native-session-view');
  const root = view.shadowRoot;
  const bounds = view.getBoundingClientRect();
  const all = (root) => [...root.querySelectorAll('*')].flatMap(el =>
    [el, ...(el.shadowRoot ? all(el.shadowRoot) : [])]);
  const clipped = all(root).filter(el => el.matches('button,input,textarea,choice-picker'))
    .filter(el => { const r=el.getBoundingClientRect(); return r.width && r.height &&
      (r.left < bounds.left - 1 || r.right > bounds.right + 1); })
    .map(el => ({tag:el.localName, test:el.dataset.testid, text:el.textContent.trim().slice(0,80)}));
  const create = root.querySelector('[data-testid=native-create]');
  const advanced = root.querySelector('[data-testid=native-advanced]');
  return {width:innerWidth, panelWidth:bounds.width, clipped,
    createY:create?.offsetTop,
    statusHeight:root.querySelector('native-read-status').getBoundingClientRect().height,
    error:root.querySelector('.launch-error').textContent.trim(),
    advancedOpen:advanced?.open,
    advancedHasProfile:!!advanced?.querySelector('native-profiles'),
    advancedHasMode:!!advanced?.querySelector('[data-testid=native-mode]')};
})()`;

async function capture(page: CdpWebPage, output: string | undefined, name: string) {
  if (!output) return;
  const screenshot = await page.session.call<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
  });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
}

export async function proveNativeLauncherLayout(
  page: CdpWebPage,
  output: string | undefined,
  failCreate: (value: boolean) => void,
) {
  const results = [];
  const runtimeErrors: unknown[] = [];
  const stop = page.session.on('Runtime.exceptionThrown', (event) => runtimeErrors.push(event));
  await page.session.call('Runtime.enable');
  await page.waitForExpression(
    `(() => { const r=document.querySelector('native-session-view').shadowRoot; return [...r.querySelectorAll('[data-testid=native-context] option')].some(o=>o.textContent.includes('mini')&&o.textContent.includes('Unavailable')) && ![...r.children].some(el=>el.textContent.includes('Session inventory is incomplete')); })()`,
    { timeoutMs: 10_000 },
  );
  failCreate(true);
  try {
    for (const width of [390, 1000, 1440]) {
      await page.session.call('Emulation.setDeviceMetricsOverride', {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      // Choosing an effort clears the previous action error through the actual picker callback.
      await page.click(
        `[data-testid="review-dispatch-effort-${width === 1000 ? 'medium' : 'high'}"]`,
      );
      const before = await page.evaluate<{
        clipped: unknown[];
        createY: number;
        advancedOpen: boolean;
        advancedHasProfile: boolean;
        advancedHasMode: boolean;
      }>(geometry);
      assert.deepEqual(before.clipped, []);
      assert.equal(before.advancedOpen, false);
      assert.equal(before.advancedHasProfile, true);
      assert.equal(before.advancedHasMode, true);
      await page.click('[data-testid="native-create"]');
      await page.waitForExpression(
        `document.querySelector('native-session-view').shadowRoot.querySelector('.launch-error').textContent.trim()==='Session start was not confirmed. Check Sessions before trying again.'`,
        { timeoutMs: 10_000 },
      );
      const after = await page.evaluate<{ clipped: unknown[]; createY: number }>(geometry);
      assert.deepEqual(after.clipped, []);
      assert.equal(after.createY, before.createY, 'The error must not shift the launch controls');
      assert.equal(
        await page.evaluate(
          `document.querySelector('native-session-view').shadowRoot.querySelector('[data-testid=native-prompt]').value`,
        ),
        'Read this workspace without changing files.',
      );
      await capture(page, output, `launcher-${width}`);
      await page.click('[data-testid="native-advanced"] > summary');
      assert.equal(
        await page.evaluate(
          `document.querySelector('native-session-view').shadowRoot.querySelector('[data-testid=native-advanced]').open`,
        ),
        true,
      );
      await capture(page, output, `advanced-${width}`);
      await page.click('[data-testid="native-advanced"] > summary');
      results.push({ before, after });
    }
    assert.deepEqual(runtimeErrors, []);
    if (output)
      await writeFile(
        path.join(output, 'launcher-layout.json'),
        JSON.stringify({ results, runtimeErrors }, null, 2),
      );
  } finally {
    stop();
    failCreate(false);
  }
}

export async function proveNativeLauncherRetry(
  page: CdpWebPage,
  output: string | undefined,
  recover: () => void,
) {
  await page.waitForSelector('[data-testid="native-refresh"]', { timeoutMs: 15_000 });
  const results = [];
  for (const width of [390, 1440]) {
    await page.session.call('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const before = await page.evaluate<{ clipped: unknown[]; statusHeight: number }>(geometry);
    assert.deepEqual(before.clipped, []);
    assert.equal(before.statusHeight, 56);
    await capture(page, output, `retry-${width}`);
    results.push(before);
  }
  recover();
  await page.click('[data-testid="native-refresh"]');
  await page.waitForExpression(
    `!document.querySelector('native-session-view').shadowRoot.querySelector('[data-testid=native-refresh]')`,
    { timeoutMs: 15_000 },
  );
  const after = await page.evaluate<{ statusHeight: number }>(geometry);
  assert.equal(after.statusHeight, 56);
  if (output)
    await writeFile(
      path.join(output, 'retry-layout.json'),
      JSON.stringify({ results, after }, null, 2),
    );
}

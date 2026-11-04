import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const output = process.env.FARMSLOT_PROOF_OUT;
const origin = process.env.FARMSLOT_PROOF_UI_ORIGIN;
const endpoint = process.env.FARMSLOT_CDP_ENDPOINT;
const browserModule = process.env.FARMSLOT_PROOF_BROWSER_MODULE;
const runId = process.env.FARMSLOT_PROOF_RUN_ID ?? '9b735dde-534c-46c4-8877-bb595b2f6e46';
assert(output && origin && endpoint && browserModule);
assert.equal(new URL(endpoint).hostname, '127.0.0.1');
const { chromium } = await import(pathToFileURL(browserModule).href);
const browser = await chromium.connectOverCDP(endpoint);
const page = await browser.contexts()[0].newPage();
const snapshots = [];
let failProgressRead = false;
let progressRequests = 0;
const methods = new Map();
await fs.mkdir(output, { recursive: true });
try {
  await page.routeWebSocket('**/ws', (client) => {
    const server = client.connectToServer();
    client.onMessage((data) => {
      if (typeof data === 'string') {
        const frame = JSON.parse(data);
        if (frame.type === 'req' && frame.method === 'task.progress') {
          methods.set(frame.id, frame.method);
          progressRequests++;
        }
      }
      server.send(data);
    });
    server.onMessage((data) => {
      if (typeof data === 'string') {
        const frame = JSON.parse(data);
        if (frame.type === 'res' && methods.delete(frame.id) && failProgressRead) {
          // A transport fixture proves failure rendering without corrupting a farm task.
          // Every other request and the subsequent Retry use the real gateway.
          client.send(
            JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: false,
              error: {
                code: 'RESOURCE_OBSERVATION_FAILED',
                message: 'Controlled progress read failure',
              },
            }),
          );
          return;
        }
      }
      client.send(data);
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/#run/${runId}`, {
    waitUntil: 'domcontentloaded',
  });
  const run = page.locator('run-detail');
  const toggle = run.locator('[data-testid="run-terminal-toggle"]');
  await toggle.waitFor({ state: 'visible', timeout: 60_000 });
  const announcement = page.locator('whats-new-modal').getByRole('button', { name: 'Got it' });
  if (await announcement.isVisible()) await announcement.click();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const terminal = run.locator('terminal-view');
  await terminal.locator('.xterm-screen').waitFor({ state: 'visible', timeout: 30_000 });
  if (process.env.FARMSLOT_PROOF_EXPECT_TEXT)
    await page.waitForFunction(
      (text) => {
        const view = document
          .querySelector('run-detail')
          ?.shadowRoot?.querySelector('terminal-view');
        const buffer = view?._terminal?.buffer.active;
        return (
          buffer &&
          Array.from({ length: buffer.length }, (_, index) =>
            buffer.getLine(index)?.translateToString(true),
          ).some((line) => line?.includes(text))
        );
      },
      process.env.FARMSLOT_PROOF_EXPECT_TEXT,
      { timeout: 30_000 },
    );
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 1440, height: 760 },
    { width: 1000, height: 760 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.waitForFunction(() => {
      const view = document.querySelector('run-detail')?.shadowRoot?.querySelector('terminal-view');
      return !!view?._terminal?.cols && !!view?._terminal?.rows;
    });
    await terminal.scrollIntoViewIfNeeded();
    const data = await terminal.evaluate((view) => {
      const root = view.shadowRoot;
      const rect = (element) => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom };
      };
      const screen = root.querySelector('.xterm-screen');
      const container = root.querySelector('.terminal-container');
      const wrap = root.querySelector('.terminal-wrap');
      const line = root.querySelector('.xterm-rows > div');
      const firstCell = line?.querySelector('span');
      const measurement = root.querySelector('.xterm-char-measure-element');
      return {
        viewport: { width: innerWidth, height: innerHeight },
        panel: rect(view.parentElement),
        host: rect(view),
        wrap: rect(wrap),
        container: rect(container),
        screen: rect(screen),
        rows: view._terminal.rows,
        cols: view._terminal.cols,
        rowFont: line ? getComputedStyle(line).font : null,
        cellFont: firstCell ? getComputedStyle(firstCell).font : null,
        cellFontFamily: firstCell ? getComputedStyle(firstCell).fontFamily : null,
        cellFontSize: firstCell ? getComputedStyle(firstCell).fontSize : null,
        cellWidth: firstCell ? rect(firstCell).width : null,
        measureVisible: measurement ? getComputedStyle(measurement).visibility !== 'hidden' : false,
        progressStatus: view.progressObservation?.status,
        progressErrorCode: view.progressObservation?.error?.code,
        notice:
          root
            .querySelector('progress-read-status')
            ?.shadowRoot?.querySelector('.row')
            ?.textContent.trim() ??
          root.querySelector('[data-terminal-progress]')?.textContent.trim() ??
          '',
        statusHeight: root.querySelector('progress-read-status')?.getBoundingClientRect().height,
        mode: view._mode,
      };
    });
    snapshots.push(data);
    await terminal.screenshot({
      path: path.join(output, `terminal-${viewport.width}-${viewport.height}.png`),
    });
  }
  await fs.writeFile(path.join(output, 'geometry.json'), JSON.stringify(snapshots, null, 2));
  for (const value of snapshots) {
    assert(Math.abs(value.host.height - value.panel.height) <= 2, 'Terminal must fill its panel');
    assert(
      value.screen.bottom <= value.wrap.bottom + 1,
      'Terminal rows must fit the available height',
    );
    assert.equal(
      value.measureVisible,
      false,
      'Measurement glyphs must never overlap terminal text',
    );
    if (value.progressStatus === 'unsupported')
      assert.equal(value.notice, '', 'An absent watch has no progress message');
    assert.equal(value.statusHeight, 28, 'Progress states use one fixed status row');
  }
  assert(snapshots[0].rows !== snapshots[1].rows, 'A height resize must refit rows');
  assert(snapshots[1].cols !== snapshots[2].cols, 'A width resize must refit columns');

  failProgressRead = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await toggle.waitFor({ state: 'visible', timeout: 60_000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const status = terminal.locator('progress-read-status');
  const retry = status.getByRole('button', { name: 'Retry', exact: true });
  await retry.waitFor({ state: 'visible', timeout: 60_000 });
  const failure = await status.evaluate((view) => ({
    height: view.getBoundingClientRect().height,
    text: view.shadowRoot.querySelector('.row')?.textContent.trim().replace(/\s+/g, ' '),
    appearance: getComputedStyle(view.shadowRoot.querySelector('button')).appearance,
  }));
  assert.equal(failure.text, 'Could not read progress Retry');
  assert.equal(failure.height, 28);
  assert.equal(failure.appearance, 'none', 'Retry uses the shared styled control');
  await terminal.screenshot({ path: path.join(output, 'read-failure.png') });
  const beforeRetry = progressRequests;
  failProgressRead = false;
  await retry.click();
  await page.waitForFunction(
    () => {
      const view = document.querySelector('run-detail')?.shadowRoot?.querySelector('terminal-view');
      return Boolean(
        view &&
        view.progressObservation.status !== 'loading' &&
        view.shadowRoot.querySelector('progress-read-status')?.notice?.kind !== 'error',
      );
    },
    undefined,
    { timeout: 60_000 },
  );
  assert(progressRequests > beforeRetry, 'Retry must read the actual progress endpoint');
  const restored = await status.evaluate((view) => ({
    height: view.getBoundingClientRect().height,
    text: view.shadowRoot.querySelector('.row')?.textContent.trim() ?? '',
  }));
  assert.equal(restored.height, failure.height, 'Resolving a read never moves the terminal');
  await terminal.screenshot({ path: path.join(output, 'read-restored.png') });
  await fs.writeFile(
    path.join(output, 'status-proof.json'),
    JSON.stringify(
      {
        failure,
        restored,
        progressRequests,
        controlledFailure: true,
        runId,
      },
      null,
      2,
    ),
  );
} finally {
  await page.close();
  await browser.close();
}

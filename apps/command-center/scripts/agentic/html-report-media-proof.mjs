// Opt-in live proof. Use an owned, authenticated CC browser with the real report open.
// Install playwright-core@1.56.1 outside the checkout and set FARMSLOT_PROOF_BROWSER_MODULE.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const runId = process.env.FARMSLOT_PROOF_RUN_ID;
const output = process.env.FARMSLOT_HTML_REPORT_PROOF_OUT;
const endpoint = process.env.FARMSLOT_CDP_ENDPOINT;
const modulePath = process.env.FARMSLOT_PROOF_BROWSER_MODULE;
assert(
  runId && output && endpoint && modulePath,
  'Select the run, output, owned CDP endpoint and browser proof module',
);
assert(
  ['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname),
  'Use an owned loopback CDP endpoint or SSH tunnel',
);
await fs.mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.connectOverCDP(endpoint);
const results = [];
const errors = [];
const observe = (page) => {
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /\.mp4|Media load rejected|srcdoc|blob:/i.test(message.text())
    )
      errors.push(message.text().slice(0, 500));
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && /\.mp4/i.test(response.url()))
      errors.push(`Video HTTP ${response.status()}`);
  });
};
const poll = async (read, accept, label) => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    assert(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const mediaState = (video) =>
  video.evaluate((element) => ({
    readyState: element.readyState,
    time: element.currentTime,
    duration: element.duration,
    paused: element.paused,
    error: element.error?.message ?? null,
  }));
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((entry) => {
      const target = new URL(entry.url());
      return (
        target.hash.startsWith(`#run/${runId}?`) &&
        new URLSearchParams(target.hash.split('?')[1]).get('artifact') === 'artifacts/report.html'
      );
    });
  assert(page, 'No owned CC tab for the selected report run');
  observe(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const report = page
    .locator('media-lightbox')
    .filter({ has: page.locator('iframe.ml-html-frame') })
    .first();
  const iframe = report.locator('iframe.ml-html-frame');
  await iframe.waitFor({ state: 'visible', timeout: 60_000 });
  const releaseNotes = page.locator('whats-new-modal button.primary');
  if (await releaseNotes.isVisible()) await releaseNotes.click();
  const sandbox = await iframe.getAttribute('sandbox');
  assert(!sandbox?.includes('allow-same-origin') && !sandbox?.includes('allow-scripts'));
  const expected = await report.evaluate(async (host) => {
    const item = host.items[host.selectedIndex];
    const { gatewayHttpFetch } = await import('/src/utils/gateway-origin.ts');
    const response = await gatewayHttpFetch(item.url);
    if (!response.ok) throw new Error(`Report HTTP ${response.status}`);
    const document = new DOMParser().parseFromString(await response.text(), 'text/html');
    return [...document.querySelectorAll('video')].map((video) => {
      const source =
        video.getAttribute('src') ?? video.querySelector('source')?.getAttribute('src');
      if (!source) throw new Error('Report video has no source');
      return decodeURIComponent(
        new URL(source, `https://artifact.invalid/${item.path}`).pathname.slice(1),
      );
    });
  });
  const reportFrame = await poll(
    () => page.frames().find((frame) => frame.url().startsWith('about:srcdoc')),
    Boolean,
    'the isolated report document',
  );
  assert(reportFrame, 'The isolated report frame must exist');
  const frameSession = await page.context().newCDPSession(reportFrame);
  const { frameTree } = await frameSession.send('Page.getFrameTree');
  const findReport = (node) =>
    node.frame.url.startsWith('about:srcdoc')
      ? node.frame
      : (node.childFrames ?? []).map(findReport).find(Boolean);
  const reportTarget = findReport(frameTree);
  assert(reportTarget);
  const { executionContextId } = await frameSession.send('Page.createIsolatedWorld', {
    frameId: reportTarget.id,
    worldName: 'report-read-proof',
  });
  const frameRead = async (expression) => {
    const result = await frameSession.send('Runtime.evaluate', {
      expression,
      contextId: executionContextId,
      returnByValue: true,
    });
    assert(!result.exceptionDetails, result.exceptionDetails?.text);
    return result.result.value;
  };
  assert.equal(
    await frameRead('document.querySelectorAll("video").length'),
    0,
    'No dead embedded player may remain',
  );
  const hrefs = await frameRead(
    '[...document.querySelectorAll("a[data-report-video]")].map(a=>a.href)',
  );
  assert(expected.length > 0);
  assert.equal(hrefs.length, expected.length, 'Every original video needs a player link');
  for (let index = 0; index < expected.length; index++) {
    const href = hrefs[index];
    const params = new URLSearchParams(new URL(href).hash.split('?')[1]);
    assert.equal(params.get('artifactRun'), runId);
    assert.equal(params.get('artifact'), expected[index]);
    if (index === 0) await page.screenshot({ path: path.join(output, 'report-video-links.png') });
    const local = await frameRead(
      `(() => {const a=document.querySelectorAll('a[data-report-video]')[${index}];a.scrollIntoView({block:'center',behavior:'instant'});const r=a.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`,
    );
    const frameBox = await iframe.boundingBox();
    assert(frameBox && local.width > 0 && local.height > 0, 'The report link must be visible');
    // Native pointer input needs no script event interceptor in the opaque iframe.
    // Noopener links intentionally have no Page.opener, so observe the owned context.
    const [player] = await Promise.all([
      page.context().waitForEvent('page'),
      page.mouse.click(
        frameBox.x + local.x + local.width / 2,
        frameBox.y + local.y + local.height / 2,
      ),
    ]);
    observe(player);
    try {
      await player.waitForLoadState('domcontentloaded');
      const video = player.locator('video.ml-video').first();
      await video.waitFor({ state: 'visible', timeout: 60_000 });
      const ready = await poll(
        () => mediaState(video),
        (value) => value.readyState >= 1 && !value.error,
        expected[index] + ' metadata',
      );
      const controls = player.locator('[data-testid="media-lightbox-video-controls"]').first();
      if (!ready.paused) await controls.getByRole('button', { name: 'Pause', exact: true }).click();
      const start = await mediaState(video);
      await controls.getByRole('button', { name: 'Play', exact: true }).click();
      const playing = await poll(
        () => mediaState(video),
        (value) => !value.paused && value.time > start.time + 0.2,
        expected[index] + ' playback',
      );
      await controls.getByRole('button', { name: 'Pause', exact: true }).click();
      const beforeSeek = await mediaState(video);
      await controls.getByRole('button', { name: '+1s', exact: true }).click();
      const sought = await poll(
        () => mediaState(video),
        (value) => value.time >= beforeSeek.time + 0.8 && !value.error,
        expected[index] + ' seek',
      );
      results.push({ path: expected[index], ready, playing, beforeSeek, sought });
      if (index === 0)
        await player.screenshot({ path: path.join(output, 'authenticated-video-seek.png') });
    } finally {
      await player.close();
    }
  }
  assert.deepEqual(errors, [], 'No related media console or HTTP errors');
  console.log(JSON.stringify({ result: 'PASS', runId, videos: results.length, sandbox }));
} finally {
  await fs.writeFile(
    path.join(output, 'video-playback.json'),
    JSON.stringify({ runId, results, errors }, null, 2),
  );
  await browser.close();
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import WebSocket from 'ws';

const runId = process.env.FARMSLOT_TEST_RUN_ID;
const ui = process.env.FARMSLOT_UI_URL;
const port = process.env.FARMSLOT_CDP_PORT ?? '19223';
assert.ok(
  runId && ui && process.env.FARMSLOT_GATEWAY,
  'Set isolated gateway, UI and disposable run',
);
const cdp = (...args) =>
  JSON.parse(
    execFileSync(process.execPath, ['apps/command-center/scripts/cdp.mjs', ...args], {
      encoding: 'utf8',
    }),
  );
const rpc = (method, params = { runId }) => cdp('gateway', method, JSON.stringify(params));
assert.equal(rpc('run.get').run.ticketOrPr, 'disposable-recording-viewer');
assert.equal(rpc('run.refreshMirror').ok, true);
const run = rpc('run.get').run;
const video = run.output.artifactManifest.find((artifact) =>
  artifact.path.endsWith('/videos/recipe-run.mp4'),
);
assert.ok(
  video?.timelinePath && video.sha256,
  'Gateway must retain manifest timing metadata and video digest',
);
const gatewayHttp = process.env.FARMSLOT_GATEWAY.replace(/^ws/, 'http');
const timeline = await (
  await fetch(
    `${gatewayHttp}/api/run-artifact?runId=${runId}&path=${encodeURIComponent(video.timelinePath)}`,
  )
).json();
if (process.env.FARMSLOT_RECORDING_REQUIRE_FRESH === '1') {
  const proof = await (
    await fetch(
      `${gatewayHttp}/api/run-artifact?runId=${runId}&path=artifacts%2Frecording-live-proof.json`,
    )
  ).json();
  assert.equal(proof.pass, true);
  assert.equal(
    proof.videoDigest,
    timeline.videoDigest,
    'Viewer must use the newly recorded and checked video',
  );
}
const route = `run/${runId}?artifactRun=${runId}&artifact=${encodeURIComponent(video.path)}`;
const target = await (
  await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${ui}/#${route}`)}`, {
    method: 'PUT',
  })
).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await once(socket, 'open');
let sequence = 0;
const pending = new Map();
socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
});
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
const lightbox = `document.querySelector('run-detail')?.shadowRoot?.querySelector('media-lightbox')`;
const evaluate = async (expression) => {
  const result = await call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  return result.result?.value;
};
async function waitFor(expression) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Viewer condition timed out: ${expression}`);
}
const click = (selector) => cdp('click', route, `run-detail >>> media-lightbox >>> ${selector}`);
async function observeNextPresentedFrame() {
  const promise = await call('Runtime.evaluate', {
    expression: `new Promise(resolve => ${lightbox}.shadowRoot.querySelector('video').requestVideoFrameCallback((_now, frame) => resolve(frame.mediaTime)))`,
    returnByValue: false,
  });
  return promise.result.objectId;
}
async function verifyPresentedFrame(promiseObjectId, expected) {
  const result = await call('Runtime.awaitPromise', { promiseObjectId, returnByValue: true });
  assert.ok(
    Math.abs(result.result.value - expected) < 0.002,
    `Presented frame ${result.result.value} must match measured timestamp ${expected}`,
  );
}
try {
  await call('Page.bringToFront');
  if (process.env.FARMSLOT_RECORDING_VIEWER_EXPECT_REJECTION === '1') {
    await waitFor(`${lightbox}?.shadowRoot?.textContent?.includes('different video bytes')`);
    assert.equal(
      await evaluate(
        `${lightbox}.shadowRoot.querySelector('[data-testid="video-next-frame"]').disabled`,
      ),
      true,
    );
    console.log(JSON.stringify({ pass: true, mismatchedTimelineRejected: true, runId }));
    socket.close();
    process.exit(0);
  }
  await waitFor(
    `Boolean(${lightbox}?.shadowRoot?.querySelector('[data-testid="video-next-frame"]:not([disabled])'))`,
  );
  await waitFor(`${lightbox}?.shadowRoot?.querySelector('video')?.readyState >= 2`);
  click('[data-testid="video-markers"] summary');
  const marker = timeline.markers.find((marker) => marker.nodeId === 'blue/capture');
  assert.ok(marker, 'Proof capture must have a composed action marker');
  click(`[data-testid="video-marker"][data-trace-index="${marker.traceIndex}"][data-phase="end"]`);
  const expected = (marker.endRangeMs[0] + marker.endRangeMs[1]) / 2000;
  await waitFor(
    `(() => { const v=${lightbox}.shadowRoot.querySelector('video');return !v.seeking && Math.abs(v.currentTime-${expected})<0.002; })()`,
  );
  const observation = await evaluate(`(() => {
    const v=${lightbox}.shadowRoot.querySelector('video'),r=v.getBoundingClientRect();
    const scale=Math.min(r.width/v.videoWidth,r.height/v.videoHeight),w=v.videoWidth*scale,h=v.videoHeight*scale;
    return {time:v.currentTime,paused:v.paused,x:r.x+(r.width-w)/2+w*.95,y:r.y+(r.height-h)/2+h*.6};
  })()`);
  assert.equal(observation.paused, true);
  const shot = await call('Page.captureScreenshot', {
    format: 'png',
    clip: { x: observation.x, y: observation.y, width: 2, height: 2, scale: 1 },
  });
  const rgb = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      'pipe:0',
      '-vf',
      'scale=1:1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { input: Buffer.from(shot.data, 'base64') },
  );
  assert.ok(
    rgb[2] > 170 && rgb[0] < 60 && rgb[1] < 60,
    `Marker must show the real blue frame, got ${[...rgb]}`,
  );
  const currentFrame = timeline.framesMs.findLastIndex(
    (time) => time <= observation.time * 1000 + 0.001,
  );
  const previousPresented = await observeNextPresentedFrame();
  click('[data-testid="video-previous-frame"]');
  const previous = timeline.framesMs[Math.max(0, currentFrame - 1)] / 1000;
  await waitFor(
    `(() => {const v=${lightbox}.shadowRoot.querySelector('video');return !v.seeking && Math.abs(v.currentTime-${previous})<0.002;})()`,
  );
  await verifyPresentedFrame(previousPresented, previous);
  const nextPresented = await observeNextPresentedFrame();
  click('[data-testid="video-next-frame"]');
  const next = timeline.framesMs[currentFrame] / 1000;
  await waitFor(
    `(() => {const v=${lightbox}.shadowRoot.querySelector('video');return !v.seeking && Math.abs(v.currentTime-${next})<0.002;})()`,
  );
  await verifyPresentedFrame(nextPresented, next);
  click('[data-testid="video-rate-0.25"]');
  assert.equal(await evaluate(`${lightbox}.shadowRoot.querySelector('video').playbackRate`), 0.25);
  if (process.env.FARMSLOT_RECORDING_VIEWER_SCREENSHOT) {
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      process.env.FARMSLOT_RECORDING_VIEWER_SCREENSHOT,
      Buffer.from(screenshot.data, 'base64'),
    );
  }
  const result = {
    pass: true,
    runId,
    marker: marker.nodeId,
    displayedRGB: [...rgb],
    previousFrameSeconds: previous,
    nextFrameSeconds: next,
    frameIndexFromGateway: true,
  };
  if (process.env.FARMSLOT_RECORDING_VIEWER_RESULT)
    await writeFile(process.env.FARMSLOT_RECORDING_VIEWER_RESULT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  socket.close();
  // Keep this isolated proof tab open for human inspection.
}

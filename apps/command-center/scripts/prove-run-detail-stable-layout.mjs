// Read-only real-browser recording of a live run detail across arrivals and reload.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createCdpVideoRecorder } from '../../../packages/recipe-runner/src/recording/cdp-video-recorder.ts';
import { CdpSession, listCdpTargets } from '../../../packages/recipe-runner/src/runtime/cdp.ts';

const port = Number(process.env.FARMSLOT_CDP_PORT);
const targetId = process.env.FARMSLOT_RUN_LAYOUT_TAB?.replace(/^@/, '');
const expectedRun = process.env.FARMSLOT_RUN_LAYOUT_RUN;
const output = process.env.FARMSLOT_RUN_LAYOUT_OUTPUT;
assert(port && targetId && expectedRun && output, 'Select an owned browser tab, run and output');
await mkdir(output, { recursive: true });
const target = (await listCdpTargets('127.0.0.1', port)).find((item) => item.id === targetId);
assert(target?.type === 'page' && target.webSocketDebuggerUrl);
const cdp = await CdpSession.connect(target.webSocketDebuggerUrl, { timeoutMs: 10000 });
const source = await readFile(
  new URL('./probes/run-detail-layout-read.js', import.meta.url),
  'utf8',
);
const snapshots = [],
  errors = [];
const binding = '__farmslotRunDetailLayoutSample';
const stopErrors = cdp.on('Runtime.exceptionThrown', (params) =>
  errors.push(params.exceptionDetails),
);
const stopSamples = cdp.on('Runtime.bindingCalled', (params) => {
  if (params.name === binding) snapshots.push({ phase: 'reload', ...JSON.parse(params.payload) });
});
const inspect = async () => {
  const r = await cdp.call('Runtime.evaluate', {
    expression: `new Promise(resolve => requestAnimationFrame(() => setTimeout(() =>
      resolve((() => { ${source} })()), 0)))`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert(!r.exceptionDetails, 'Geometry probe failed');
  return r.result.value;
};
let recording, script;
try {
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');
  await cdp.call('Page.bringToFront');
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const until = Date.now() + 45000;
  let first;
  do {
    first = await inspect();
    if (first.connected && first.visibility === 'visible' && first.detailId === expectedRun) break;
    await delay(50);
  } while (Date.now() < until);
  assert(
    first.connected && first.visibility === 'visible' && first.detailId === expectedRun,
    'Open the chosen current run detail in the foreground',
  );
  await cdp.call('Runtime.evaluate', {
    expression: `(() => {
      const list = document.querySelector('run-list');
      const detail = list?.shadowRoot?.querySelector('run-detail') ?? document.querySelector('run-detail');
      detail?.shadowRoot?.querySelector('.pipeline-section')?.scrollIntoView({block: 'start'});
    })()`,
  });
  const positioned = await inspect();
  assert(
    (positioned.scroll.list ?? positioned.scroll.detail ?? 0) > 1,
    'Start with the timeline visibly scrolled into view, so a reset cannot pass at zero',
  );
  await cdp.call('Runtime.addBinding', { name: binding });
  script = (
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
    if (window.top !== window) return;
    let stopped = false, last = '', at = -Infinity;
    globalThis[Symbol.for('farmslot.run-detail-layout.stop')] = () => { stopped = true; };
    const sample = () => {
      if (stopped) return;
      const value = (() => { ${source} })();
      const signature = JSON.stringify({ regions: value.regions, rows: value.detailRows });
      if (signature !== last || value.at - at >= 100) {
        globalThis.${binding}(JSON.stringify(value)); last = signature; at = value.at;
      }
      requestAnimationFrame(() => setTimeout(sample, 0));
    }; requestAnimationFrame(() => setTimeout(sample, 0));
  })()`,
    })
  ).identifier;
  recording = await createCdpVideoRecorder({ cdpPort: port }).start({
    target: { kind: 'cdp-page', host: '127.0.0.1', port, targetId },
    outputPath: path.join(output, 'run-detail-refresh.mp4'),
    nodeId: 'live-run-detail-refresh',
    record: 'full_run',
    maxFps: 15,
  });
  await recording.ready?.();
  for (const phase of ['live-arrivals', 'reload']) {
    if (phase === 'reload') {
      let stop, timer;
      const loaded = new Promise((resolve, reject) => {
        stop = cdp.on('Page.loadEventFired', resolve);
        timer = setTimeout(() => reject(new Error('Reload did not finish')), 30000);
      });
      try {
        await cdp.call('Page.reload');
        await loaded;
      } finally {
        stop();
        clearTimeout(timer);
      }
    }
    const end = Date.now() + (phase === 'reload' ? 20000 : 12000);
    do {
      snapshots.push({ phase, ...(await inspect()) });
      await delay(70);
    } while (Date.now() < end);
    const frame = await cdp.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, phase + '.png'), Buffer.from(frame.data, 'base64'));
  }
} finally {
  try {
    if (script) {
      await cdp.call('Runtime.evaluate', {
        expression: "globalThis[Symbol.for('farmslot.run-detail-layout.stop')]?.()",
      });
      await cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: script });
      await cdp.call('Runtime.removeBinding', { name: binding });
    }
  } finally {
    stopErrors();
    stopSamples();
    try {
      if (recording)
        await writeFile(
          path.join(output, 'recording.json'),
          JSON.stringify(await recording.stop(), null, 2) + '\n',
        );
      await writeFile(
        path.join(output, 'positions.json'),
        JSON.stringify({ snapshots, errors }, null, 2) + '\n',
      );
    } finally {
      cdp.close();
    }
  }
}
const movement = {};
for (const sample of snapshots.filter((value) => value.runId === expectedRun)) {
  for (const [name, rect] of Object.entries(sample.regions)) {
    const entry = (movement[name] ??= {});
    for (const key of ['x', 'y', 'width', 'height']) {
      const metric = (entry[key] ??= { min: rect[key], max: rect[key] });
      metric.min = Math.min(metric.min, rect[key]);
      metric.max = Math.max(metric.max, rect[key]);
    }
  }
}
await writeFile(path.join(output, 'movement.json'), JSON.stringify(movement, null, 2) + '\n');
// Compare what the viewer can see. A live run may add off-screen history or results;
// their raw sizes above remain in the receipt, while visible anchors must not move or vanish.
const initial = snapshots.find(
  (value) => value.phase === 'live-arrivals' && value.detailId === expectedRun,
);
assert(initial?.visibleRegions['pipeline .pipeline-svg'], 'Keep the timeline canvas in view');
const names = ['run-list', 'run-detail', 'detail .pipeline-section', 'pipeline .pipeline-svg'];
const visibleMovement = {};
for (const name of names) {
  const start = initial.visibleRegions[name];
  assert(start, `Measure initial visible ${name}`);
  const deltas = { x: 0, y: 0, width: 0, height: 0 };
  for (const sample of snapshots.filter((value) => value.detailId === expectedRun)) {
    assert.equal(sample.visibility, 'visible', 'Keep the selected page in the foreground');
    const value = sample.visibleRegions[name];
    assert(value, `Refresh removed visible ${name}`);
    for (const key of Object.keys(deltas))
      deltas[key] = Math.max(deltas[key], Math.abs(value[key] - start[key]));
  }
  visibleMovement[name] = deltas;
}
await writeFile(
  path.join(output, 'visible-movement.json'),
  JSON.stringify(visibleMovement, null, 2) + '\n',
);
assert(
  Object.values(visibleMovement).every((metrics) =>
    Object.values(metrics).every((value) => value <= 1),
  ),
  `Visible run detail moved: ${JSON.stringify(visibleMovement)}`,
);
for (const phase of ['live-arrivals', 'reload']) {
  const ids = new Set(
    snapshots
      .filter((value) => value.phase === phase && value.detailId === expectedRun)
      .map((value) => value.regions['run-detail']?.identity)
      .filter((value) => value !== undefined),
  );
  assert.equal(ids.size, 1, `Run detail remounted during ${phase}`);
}
const transientStates = new Set(
  snapshots
    .filter((value) => value.detailId === expectedRun)
    .map((value) => JSON.stringify(value.transientPresence)),
);
assert.equal(transientStates.size, 1, 'A normal refresh inserted or removed a transient notice');
await writeFile(
  path.join(output, 'no-flash.json'),
  JSON.stringify({ states: [...transientStates] }, null, 2) + '\n',
);
assert.equal(errors.length, 0, 'No runtime exceptions');
console.log(JSON.stringify({ status: 'pass', samples: snapshots.length, visibleMovement, output }));

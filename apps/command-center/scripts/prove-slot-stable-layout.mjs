// Read-only live slot recording. Uses actual reloads and browser frame sampling.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { createCdpVideoRecorder } from '../../../packages/recipe-runner/src/recording/cdp-video-recorder.ts';
import { CdpSession, listCdpTargets } from '../../../packages/recipe-runner/src/runtime/cdp.ts';

const port = Number(process.env.FARMSLOT_CDP_PORT);
const targetId = process.env.FARMSLOT_SLOT_LAYOUT_TAB?.replace(/^@/, '');
const output = process.env.FARMSLOT_SLOT_LAYOUT_OUTPUT;
const expectedSlot = process.env.FARMSLOT_SLOT_LAYOUT_SLOT;
const expectedRun = process.env.FARMSLOT_SLOT_LAYOUT_RUN;
assert(
  port && targetId && output && expectedSlot && expectedRun,
  'Select an owned tab, slot/run and output',
);
await mkdir(output, { recursive: true });
const execute = promisify(execFile);
const repository = new URL('../../../', import.meta.url).pathname;
const rpc = async (method, params) =>
  JSON.parse(
    (
      await execute(
        process.execPath,
        [
          path.join(repository, 'apps/command-center/scripts/cdp.mjs'),
          'gateway',
          method,
          JSON.stringify(params),
        ],
        { cwd: repository, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout,
  );
const { run: sourceRun } = await rpc('run.get', { runId: expectedRun, view: 'snapshot' });
assert.equal(sourceRun.slotId, expectedSlot);
await writeFile(
  path.join(output, 'source-run.json'),
  JSON.stringify(
    {
      id: sourceRun.id,
      slotId: sourceRun.slotId,
      status: sourceRun.status,
      observedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
);

const target = (await listCdpTargets('127.0.0.1', port)).find((item) => item.id === targetId);
assert(target?.type === 'page' && target.webSocketDebuggerUrl);
const session = await CdpSession.connect(target.webSocketDebuggerUrl, { timeoutMs: 10000 });
const source = await readFile(new URL('./probes/slot-layout-read.js', import.meta.url), 'utf8');
const snapshots = [];
const failures = [];
const stopErrors = session.on('Runtime.exceptionThrown', (params) =>
  failures.push(params.exceptionDetails),
);
const inspect = async () => {
  const result = await session.call(
    'Runtime.evaluate',
    {
      expression: `(async () => { ${source} })()`,
      returnByValue: true,
      awaitPromise: true,
    },
    { timeoutMs: 15000 },
  );
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
let recording;
let samplingScript;
const bindingName = '__farmslotSlotLayoutSample';
const stopSamples = session.on('Runtime.bindingCalled', (params) => {
  if (params.name === bindingName && typeof params.payload === 'string')
    snapshots.push({ phase: 'reload', captureSource: 'document', ...JSON.parse(params.payload) });
});
try {
  await session.call('Runtime.enable');
  await session.call('Page.enable');
  await session.call('Page.bringToFront');
  await session.call('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  let initial;
  const readyDeadline = Date.now() + 45000;
  do {
    initial = await inspect();
    if (initial.connected && initial.slotId === expectedSlot && initial.runId === expectedRun)
      break;
    await delay(100);
  } while (Date.now() < readyDeadline);
  assert(
    initial.connected && initial.slotId === expectedSlot && initial.runId === expectedRun,
    'Connect the selected live slot and run before recording',
  );
  // Installed before navigation: sample the first document paint, not only post-load hydration.
  await session.call('Runtime.addBinding', { name: bindingName });
  samplingScript = (
    await session.call('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
      if (window.top !== window) return;
      let stopped = false, previous = '', sentAt = -Infinity;
      globalThis[Symbol.for('farmslot.slot-layout.stop')] = () => { stopped = true; };
      const sample = () => {
        if (stopped) return;
        const value = (() => { ${source} })();
        const signature = JSON.stringify({regions: value.regions, notices: value.noticeRows});
        if (signature !== previous || value.at - sentAt >= 100) {
          globalThis.${bindingName}(JSON.stringify(value));
          previous = signature; sentAt = value.at;
        }
        requestAnimationFrame(sample);
      };
      sample();
    })()`,
    })
  ).identifier;
  const recorder = createCdpVideoRecorder({ cdpPort: port });
  recording = await recorder.start({
    target: { kind: 'cdp-page', host: '127.0.0.1', port, targetId },
    outputPath: path.join(output, 'slot-refresh.mp4'),
    nodeId: 'live-slot-refresh',
    record: 'full_run',
    maxFps: 15,
  });
  await recording.ready?.();
  for (const phase of ['live-arrivals', 'reload']) {
    if (phase === 'reload') {
      let stop;
      let timer;
      const loaded = new Promise((resolve, reject) => {
        stop = session.on('Page.loadEventFired', resolve);
        timer = setTimeout(() => reject(new Error('Reload did not finish')), 30000);
      });
      try {
        await session.call('Page.reload');
        await loaded;
      } finally {
        stop();
        clearTimeout(timer);
      }
    }
    const end = Date.now() + (phase === 'reload' ? 20000 : 12000);
    do {
      snapshots.push({ phase, captureSource: 'client', ...(await inspect()) });
      await delay(100);
    } while (Date.now() < end);
    const frame = await session.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, phase + '.png'), Buffer.from(frame.data, 'base64'));
  }
  await session.call('Runtime.evaluate', {
    expression: "globalThis[Symbol.for('farmslot.slot-layout.stop')]?.()",
  });
  await session.call('Emulation.setDeviceMetricsOverride', {
    width: 414,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const health = async () => {
    const result = await session.call('Runtime.evaluate', {
      expression: `(() => {
      const row = document.querySelector('slot-view .sv-preconditions');
      const content = row?.firstElementChild;
      const box = row?.getBoundingClientRect();
      return row && content && {x: box.x, y: box.y, width: box.width, clientHeight: row.clientHeight,
        scrollWidth: row.scrollWidth, clientWidth: row.clientWidth, scrollLeft: row.scrollLeft,
        contentHeight: content.getBoundingClientRect().height,
        scrollbarWidth: getComputedStyle(row).scrollbarWidth,
        webkitScrollbar: getComputedStyle(row, '::-webkit-scrollbar').display};
    })()`,
      returnByValue: true,
    });
    return result.result.value;
  };
  const overflow = await health();
  assert(
    overflow && overflow.scrollWidth > overflow.clientWidth,
    'Prove a genuinely overflowing health row',
  );
  assert.equal(overflow.clientHeight, 17);
  assert(
    overflow.contentHeight <= overflow.clientHeight,
    'Health text must fit without scrollbar clipping',
  );
  assert.equal(overflow.scrollbarWidth, 'none');
  assert.equal(overflow.webkitScrollbar, 'none');
  await session.call('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: overflow.x + overflow.width / 2,
    y: overflow.y + 8,
    deltaX: 2000,
    deltaY: 0,
  });
  let scrolled;
  const scrollDeadline = Date.now() + 5000;
  do {
    scrolled = await health();
    if (scrolled.scrollLeft > 0) break;
    await delay(50);
  } while (Date.now() < scrollDeadline);
  assert(
    scrolled.scrollLeft > 0,
    'The hidden scrollbar must still allow real horizontal wheel input',
  );
  const healthFrame = await session.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(
    path.join(output, 'health-overflow.png'),
    Buffer.from(healthFrame.data, 'base64'),
  );
  await writeFile(
    path.join(output, 'health-overflow.json'),
    JSON.stringify({ overflow, scrolled }, null, 2) + '\n',
  );
  await session.call('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
} finally {
  try {
    if (samplingScript) {
      await session.call('Runtime.evaluate', {
        expression: "globalThis[Symbol.for('farmslot.slot-layout.stop')]?.()",
      });
      await session.call('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: samplingScript,
      });
      await session.call('Runtime.removeBinding', { name: bindingName });
    }
  } finally {
    stopSamples();
    stopErrors();
    try {
      if (recording)
        await writeFile(
          path.join(output, 'recording.json'),
          JSON.stringify(await recording.stop(), null, 2) + '\n',
        );
      await writeFile(
        path.join(output, 'positions.json'),
        JSON.stringify({ snapshots, failures }, null, 2) + '\n',
      );
    } finally {
      session.close();
    }
  }
}
const movement = {};
for (const sample of snapshots) {
  if (!sample.regions['.sv-body']) continue;
  for (const [name, rect] of Object.entries(sample.regions)) {
    if (!rect) continue;
    const old = movement[name] ?? {
      minX: rect.x,
      maxX: rect.x,
      minY: rect.y,
      maxY: rect.y,
      minHeight: rect.height,
      maxHeight: rect.height,
      minWidth: rect.width,
      maxWidth: rect.width,
    };
    movement[name] = {
      minX: Math.min(old.minX, rect.x),
      maxX: Math.max(old.maxX, rect.x),
      minY: Math.min(old.minY, rect.y),
      maxY: Math.max(old.maxY, rect.y),
      minHeight: Math.min(old.minHeight, rect.height),
      maxHeight: Math.max(old.maxHeight, rect.height),
      minWidth: Math.min(old.minWidth, rect.width),
      maxWidth: Math.max(old.maxWidth, rect.width),
    };
  }
}
await writeFile(path.join(output, 'movement.json'), JSON.stringify(movement, null, 2) + '\n');
const required = [
  'slot-view',
  '.sv-body',
  '[data-testid="slot-load-run"]',
  '[data-testid="slot-history"]',
  '.sv-editor-row',
  '.sv-task-panel-col',
  '.sv-run-panel',
  'terminal-view',
  '.sv-review-col',
];
for (const name of required) {
  const value = movement[name];
  assert(value, `Measure ${name}`);
  assert(
    value.maxX - value.minX <= 1 &&
      value.maxY - value.minY <= 1 &&
      value.maxHeight - value.minHeight <= 1 &&
      value.maxWidth - value.minWidth <= 1,
    `Data/refresh moved ${name}: ${JSON.stringify(value)}`,
  );
}
// Authentication admits a new workspace after the saved, read-only preview.
// Geometry covers both; stateful node identity is stable within the admitted workspace.
for (const phase of ['live-arrivals', 'reload']) {
  for (const name of ['.sv-editor-row', '.sv-sidebar', 'terminal-view']) {
    const identities = new Set(
      snapshots
        .filter((sample) => sample.phase === phase && sample.connected)
        .map((sample) => sample.regions[name]?.identity)
        .filter((value) => value !== undefined),
    );
    assert.equal(identities.size, 1, `${name} remounted during ${phase}`);
  }
}
assert(
  snapshots.some((sample) => sample.phase === 'reload' && sample.documentState === 'loading'),
  'Capture the new document before load',
);
assert(
  snapshots.some((sample) => sample.captureSource === 'document' && sample.regions['.sv-body']),
  'Keep first-paint sampling through workspace hydration',
);
const fastCycles = [];
for (const phase of ['live-arrivals', 'reload']) {
  const active = new Map();
  for (const sample of snapshots.filter((value) => value.phase === phase && value.connected)) {
    for (const [name, notice] of Object.entries(sample.noticeRows ?? {})) {
      let cycle = active.get(name);
      if (cycle && cycle.scope !== notice.scope) {
        active.delete(name);
        cycle = undefined;
      }
      if (notice.pending && !notice.rawError) {
        if (!cycle) {
          cycle = {
            start: sample.at,
            scope: notice.scope,
            flashed: false,
            inheritedError: notice.role === 'alert',
          };
          active.set(name, cycle);
        }
        if (notice.visible && notice.role !== 'alert') cycle.flashed = true;
      } else if (cycle) {
        const elapsed = sample.at - cycle.start;
        if (!notice.rawError && !cycle.inheritedError && elapsed > 0 && elapsed < 1000) {
          fastCycles.push({ phase, name, elapsed, flashed: cycle.flashed });
          assert(!cycle.flashed, `A normal ${name} refresh flashed a notice in ${elapsed}ms`);
        }
        active.delete(name);
      }
      if (notice.visible) {
        assert.equal(notice.fontSize, '11px', 'Read notices must use the shared compact styling');
        if (sample.historyStyle) {
          assert.equal(
            notice.color,
            sample.historyStyle.color,
            'Read notices use the muted control colour',
          );
          assert.equal(
            notice.background,
            sample.historyStyle.background,
            'Read notices use a styled status row',
          );
        }
        assert(
          !notice.text.includes('Actions wait for a current read'),
          'No technical freshness sentence',
        );
      }
    }
    if (sample.loadRunStyle && sample.historyStyle)
      assert.deepEqual(
        sample.loadRunStyle,
        sample.historyStyle,
        'Load run must match the neighbouring History button',
      );
  }
}
await writeFile(path.join(output, 'no-flash.json'), JSON.stringify({ fastCycles }, null, 2) + '\n');
assert(fastCycles.length > 0, 'Observe an actual normal refresh cycle for the no-flash check');
assert.equal(failures.length, 0, 'No runtime exceptions during refresh');
console.log(JSON.stringify({ status: 'pass', output, samples: snapshots.length, movement }));

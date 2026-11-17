import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createCdpVideoRecorder } from '../../../packages/recipe-runner/src/recording/cdp-video-recorder.ts';
import { CdpSession, listCdpTargets } from '../../../packages/recipe-runner/src/runtime/cdp.ts';

const port = Number(process.env.FARMSLOT_CDP_PORT),
  id = process.env.FARMSLOT_SYNC_TAB?.replace(/^@/, ''),
  output = process.env.FARMSLOT_SYNC_OUTPUT,
  scene = process.env.FARMSLOT_SYNC_SCENE,
  slotId = process.env.FARMSLOT_SYNC_SLOT;
assert(port && id && output && scene && slotId, 'Select owned tab, scene, slot and output');
await mkdir(output, { recursive: true });
const target = (await listCdpTargets('127.0.0.1', port)).find((t) => t.id === id);
assert(target?.webSocketDebuggerUrl);
const c = await CdpSession.connect(target.webSocketDebuggerUrl, { timeoutMs: 20000 });
const source = await readFile(
  new URL('./probes/background-sync-measure.js', import.meta.url),
  'utf8',
);
const evaluate = async (body) => {
  const r = await c.call(
    'Runtime.evaluate',
    {
      expression: `(async()=>{const SLOT_ID=${JSON.stringify(slotId)};${body}})()`,
      awaitPromise: true,
      returnByValue: true,
    },
    { timeoutMs: 120000 },
  );
  if (r.exceptionDetails)
    throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
let recording;
const runtimeErrors = [];
const stopErrors = c.on('Runtime.exceptionThrown', (event) =>
  runtimeErrors.push(event.exceptionDetails),
);
try {
  await c.call('Runtime.enable');
  await c.call('Page.enable');
  await c.call('Page.bringToFront');
  // Arthur's PNG includes a 16px left window gutter and 12px top chrome crop.
  // A 260px sidebar occupies 234px: reproduce its 90% scale, 1111x945 page pixels.
  await c.call('Emulation.setDeviceMetricsOverride', {
    width: 1234,
    height: 1050,
    deviceScaleFactor: 0.9,
    mobile: false,
  });
  const methods =
    scene === 'runs' ? ['run.list'] : scene === 'detail' ? ['run.get'] : ['fs.list', 'git.status'];
  let initial;
  for (let n = 0; n < 900; n++) {
    initial = await evaluate(source);
    if (
      initial.connection === 'connected' &&
      initial.cacheReady &&
      initial.geometry[scene] &&
      methods.every((method) => initial.queries.some((q) => q.method === method && q.hasData))
    )
      break;
    await delay(50);
  }
  assert(
    initial.visibility === 'visible' &&
      initial.connection === 'connected' &&
      initial.geometry[scene],
  );
  await writeFile(path.join(output, 'initial.json'), JSON.stringify(initial, null, 2) + '\n');
  const frame = await c.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, 'before.png'), Buffer.from(frame.data, 'base64'));
  // Warm each real read before counting. Initial hydration is not background refresh.
  for (const group of [methods, ['tmux.worker.list']])
    await evaluate(
      `await globalThis[Symbol.for('farmslot.background-sync-measure')].cycle(${JSON.stringify(group)});`,
    );
  recording = await createCdpVideoRecorder({ cdpPort: port }).start({
    target: { kind: 'cdp-page', host: '127.0.0.1', port, targetId: id },
    outputPath: path.join(output, 'background-sync.mp4'),
    nodeId: 'background-sync',
    record: 'full_run',
    maxFps: 15,
  });
  await recording.ready?.();
  const results = [];
  for (const group of [methods, ['tmux.worker.list']])
    for (let i = 0; i < 3; i++) {
      const value = await evaluate(
        `return await globalThis[Symbol.for('farmslot.background-sync-measure')].cycle(${JSON.stringify(group)});`,
      );
      results.push({ group: group.join('+'), cycle: i + 1, ...value });
    }
  // Keep the live page recorded through a full ordinary polling interval.
  const idle = await evaluate(
    "return await globalThis[Symbol.for('farmslot.background-sync-measure')].cycle([], 12000);",
  );
  await writeFile(path.join(output, 'idle.json'), JSON.stringify(idle, null, 2) + '\n');
  assert(idle.metrics[scene].identityKept, 'Retain the mounted page during background polls');
  if (idle.metrics.pinned) {
    assert(idle.metrics.pinned.identityKept, 'Retain the pinned card');
    assert.equal(idle.metrics.pinned.elementsRemoved, 0, 'The pinned card must not flash');
    assert.equal(idle.metrics.pinned.elementsAdded, 0, 'The pinned card must not flash');
  }
  const after = await c.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, 'after-sync.png'), Buffer.from(after.data, 'base64'));
  await writeFile(path.join(output, 'counts.json'), JSON.stringify(results, null, 2) + '\n');
  await writeFile(
    path.join(output, 'runtime-errors.json'),
    JSON.stringify(runtimeErrors, null, 2) + '\n',
  );
  assert.equal(runtimeErrors.length, 0, 'No browser runtime exceptions');
  console.log(
    JSON.stringify({
      scene,
      cycles: results.map((r) => ({
        group: r.group,
        equalData: r.queries.every((q) => q.equalData),
        changedObservedQueries: r.changedObservedQueries,
        renders: Object.fromEntries(Object.entries(r.metrics).map(([k, v]) => [k, v.renders])),
        replaced: Object.fromEntries(
          Object.entries(r.metrics).map(([k, v]) => [k, v.elementsRemoved]),
        ),
      })),
    }),
  );
} finally {
  if (recording)
    await writeFile(
      path.join(output, 'recording.json'),
      JSON.stringify(await recording.stop(), null, 2) + '\n',
    );
  await evaluate("globalThis[Symbol.for('farmslot.background-sync-measure')]?.stop();");
  stopErrors();
  c.close();
}

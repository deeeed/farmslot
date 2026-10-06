'use strict';

const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');

const { createExtensionPerformanceBackend } = require('../src/performance-observer.cjs');
const { startCdpEndpoint } = require('./fixtures/cdp-endpoint.cjs');

const KIND = {
  categories: ['blink.user_timing', 'disabled-by-default-devtools.timeline.frame'],
  rendererScoped: true,
  scope: 'extension-renderer',
  nativeSource: 'chromium-cdp-frame-timings',
  javascriptTasks: true,
  frameTiming: 'draw',
};
const TARGETS = [
  { targetId: 'background', type: 'other', url: 'chrome-extension://ext/background.html' },
  { targetId: 'home', type: 'page', url: 'chrome-extension://ext/home.html' },
];

const cleanups = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function endpoint(targets) {
  let markerName = '';
  const cdp = await startCdpEndpoint((message, emit) => {
    if (message.method === 'Target.getTargets') return { targetInfos: targets };
    if (message.method === 'Target.attachToTarget') return { sessionId: 'S1' };
    if (message.method === 'Runtime.evaluate') {
      markerName = JSON.parse(message.params.expression.slice('performance.mark('.length, -1));
    }
    if (message.method === 'Tracing.end') {
      const frame = (name, ts) => ({ name, ph: 'I', pid: 7, ts, args: { frameSeqId: 1 } });
      emit('Tracing.dataCollected', {
        value: [
          { name: markerName, ph: 'I', pid: 7, ts: 1_000_000 },
          frame('BeginFrame', 1_010_000),
          frame('DrawFrame', 1_020_000),
          { ...frame('BeginFrame', 1_010_000), pid: 8 },
        ],
      });
      emit('Tracing.tracingComplete', {});
    }
    return {};
  });
  cleanups.push(cdp.close);
  return { cdp, markerName: () => markerName };
}

describe('createExtensionPerformanceBackend', () => {
  it("traces the extension UI renderer with the host's kind, platform and marker", async () => {
    const { cdp, markerName } = await endpoint(TARGETS);
    const backend = await createExtensionPerformanceBackend({
      cdpPort: cdp.port,
      extensionId: 'ext',
      uiPaths: ['/home.html', '/sidepanel.html'],
      kind: KIND,
      platform: 'extension',
      markerPrefix: 'host-clock-',
    });
    await backend.start('flow');
    const result = await backend.end('flow');
    await backend.close();

    assert.deepEqual(
      cdp.calls.map((call) => call.method),
      [
        'Target.getTargets',
        'Target.attachToTarget',
        'Tracing.start',
        'Runtime.evaluate',
        'Tracing.end',
      ],
    );
    assert.deepEqual(cdp.calls[1].params, { targetId: 'home', flatten: true });
    assert.deepEqual(cdp.calls[2].params, {
      categories: 'blink.user_timing,disabled-by-default-devtools.timeline.frame',
      transferMode: 'ReportEvents',
    });
    assert.equal(cdp.calls[3].sessionId, 'S1');
    assert.match(markerName(), /^host-clock-flow-\d+$/u);
    assert.equal(result.platform, 'extension');
    assert.equal(result.trace.scope, 'extension-renderer');
    assert.equal(result.trace.rendererProcessId, 7);
    assert.equal(result.trace.beginFrameCount, 1);
    assert.equal(result.nativeUi.kind, 'chromium-cdp-frame-timings');
    assert.equal(result.nativeUi.summary.frameCount, 1);
  });

  it('refuses without an open UI target and closes its connection', async () => {
    const { cdp } = await endpoint([TARGETS[0]]);
    await assert.rejects(
      createExtensionPerformanceBackend({
        cdpPort: cdp.port,
        extensionId: 'ext',
        uiPaths: ['/home.html'],
        kind: KIND,
        platform: 'extension',
      }),
      /requires an open extension UI target/u,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(cdp.clients(), 0);
  });
});

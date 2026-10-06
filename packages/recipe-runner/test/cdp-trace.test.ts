import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import {
  type CdpClient,
  createCdpTraceCollector,
  parseTraceCapture,
  type TraceCapture,
  type TraceEvent,
  type TraceKind,
} from '../src/runtime/cdp-trace.js';

const MOBILE_CATEGORIES = ['blink.user_timing', 'disabled-by-default-devtools.timeline.frame'];
const EXTENSION: TraceKind = {
  categories: [
    'blink.user_timing',
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame',
    'v8.execute',
  ],
  rendererScoped: true,
  scope: 'extension-renderer',
  nativeSource: 'chromium-cdp-frame-timings',
  javascriptTasks: true,
  frameTiming: 'draw',
};
const ANDROID: TraceKind = {
  categories: MOBILE_CATEGORIES,
  rendererScoped: false,
  scope: 'mobile-host',
  nativeSource: 'react-native-cdp-frame-timings',
  javascriptTasks: false,
  frameTiming: 'draw',
};
const IOS: TraceKind = { ...ANDROID, frameTiming: 'cadence' };
const sync = async () => ({ hostEpochMs: 10_000, uncertaintyMs: 1 });

const marker: TraceEvent = {
  name: 'clock',
  cat: 'blink.user_timing',
  ph: 'I',
  pid: 42,
  ts: 1_000_000,
};

function frame(sequence: number, begin: number, end: number): TraceEvent[] {
  return [
    { name: 'BeginFrame', ph: 'I', pid: 42, ts: begin, args: { frameSeqId: sequence } },
    { name: 'DrawFrame', ph: 'I', pid: 42, ts: end, args: { frameSeqId: sequence } },
  ];
}

function capture(platform: string, events: TraceEvent[]): TraceCapture {
  return {
    platform,
    events: [marker, ...events],
    markerName: 'clock',
    markerHostEpochMs: 10_000,
    markerUncertaintyMs: 2,
    dataLossOccurred: false,
    overflow: false,
    unavailableReasons: [],
    coverageGapReasons: [],
  };
}

// A CDP client that records commands; `onEnd` runs when Tracing.end is sent.
function fakeClient(
  onEnd: (handlers: Map<string, (params: Record<string, unknown>) => void>) => void,
) {
  const handlers = new Map<string, (params: Record<string, unknown>) => void>();
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const client: CdpClient = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === 'Tracing.end') onEnd(handlers);
      return {};
    },
    on(method, handler) {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    },
    close() {},
  };
  return { client, calls, handlers };
}

describe('CDP performance trace collector', () => {
  afterEach(() => mock.timers.reset());

  it('collects chunked trace events through tracingComplete', async () => {
    let markerName = '';
    const { client, calls } = fakeClient((handlers) => {
      handlers.get('Tracing.dataCollected')?.({
        value: [
          { ...marker, name: markerName },
          ...frame(1, 1_010_000, 1_020_000),
          { name: 'RunTask', ph: 'X', pid: 42, ts: 1_010_000, dur: 10_000 },
        ],
      });
      handlers.get('Tracing.tracingComplete')?.({ dataLossOccurred: false });
    });
    const backend = createCdpTraceCollector(client, {
      kind: ANDROID,
      platform: 'android',
      marker: async (name) => {
        markerName = name;
        return sync();
      },
    });

    await backend.start('flow');
    const result = await backend.end('flow');

    assert.match(markerName, /^farmslot-clock-flow-\d+$/u);
    assert.equal(result.platform, 'android');
    assert.equal(result.nativeUi.summary.frameCount, 1);
    assert.equal(result.trace.beginFrameCount, 1);
    assert.equal(result.trace.drawFrameCount, 1);
    assert.equal(result.trace.runTaskCount, 1);
    assert.equal(result.trace.totalEventCount, 4);
    assert.equal(result.trace.scope, 'mobile-host');
    assert.equal(result.javascript.summary.taskCount, 1);
    assert.equal(result.javascript.summary.longTaskCount, 0);
    assert.equal(result.javascript.summary.longestTaskMs, 10);
    assert.ok(!('averageFps' in result.javascript.summary));
    assert.equal(calls[0]?.method, 'Tracing.start');
    assert.deepEqual(calls[0]?.params, {
      categories: 'blink.user_timing,disabled-by-default-devtools.timeline.frame',
      transferMode: 'ReportEvents',
    });
    await backend.close();
  });

  it("starts tracing with the kind's categories and names the marker with the host's prefix", async () => {
    const { client, calls } = fakeClient((handlers) =>
      handlers.get('Tracing.tracingComplete')?.({}),
    );
    const names: string[] = [];
    const backend = createCdpTraceCollector(client, {
      kind: EXTENSION,
      platform: 'extension',
      markerPrefix: 'mmh-clock-',
      marker: async (name) => {
        names.push(name);
        return sync();
      },
    });

    await backend.start('extension');
    await backend.end('extension');

    const categories = String(calls[0]?.params?.categories);
    assert.ok(categories.includes('devtools.timeline'));
    assert.ok(categories.includes('v8.execute'));
    assert.match(names[0] ?? '', /^mmh-clock-extension-\d+$/u);
    await backend.close();
  });

  it('rolls back tracing when the clock marker fails', async () => {
    const { client, calls } = fakeClient((handlers) =>
      handlers.get('Tracing.tracingComplete')?.({}),
    );
    let failMarker = true;
    const backend = createCdpTraceCollector(client, {
      kind: IOS,
      platform: 'ios',
      marker: async () => {
        if (failMarker) throw new Error('marker failed');
        return sync();
      },
    });

    await assert.rejects(backend.start('first'), /marker failed/u);
    assert.deepEqual(
      calls.map((call) => call.method),
      ['Tracing.start', 'Tracing.end'],
    );
    failMarker = false;
    await backend.start('second');
    await backend.close();
  });

  it('clears collector state when tracingComplete times out', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    let completeOnEnd = false;
    const { client, calls } = fakeClient((handlers) => {
      if (completeOnEnd) handlers.get('Tracing.tracingComplete')?.({});
    });
    const backend = createCdpTraceCollector(client, { kind: IOS, platform: 'ios', marker: sync });

    await backend.start('first');
    const ending = backend.end('first');
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(30_000);
    await assert.rejects(ending, /tracingComplete/u);
    assert.deepEqual(
      calls.map((call) => call.method),
      ['Tracing.start', 'Tracing.end'],
    );
    completeOnEnd = true;
    await backend.start('second');
    await backend.close();
  });
});

describe('CDP performance trace parser', () => {
  it('derives cadence frame intervals from React Native frame events', () => {
    const result = parseTraceCapture(
      capture('ios', [
        ...frame(1, 1_010_000, 1_026_667),
        ...frame(2, 1_026_667, 1_043_334),
        ...frame(3, 1_060_001, 1_076_668),
        { name: 'RunTask', ph: 'X', pid: 42, ts: 1_020_000, dur: 20_000 },
      ]),
      IOS,
    );

    assert.equal(result.platform, 'ios');
    assert.equal(result.trace.beginFrameCount, 3);
    assert.equal(result.trace.drawFrameCount, 3);
    assert.equal(result.trace.runTaskCount, 1);
    assert.equal(result.trace.scope, 'mobile-host');
    assert.equal(result.nativeUi.status, 'complete');
    assert.equal(result.nativeUi.kind, 'react-native-cdp-frame-timings');
    assert.equal(result.nativeUi.summary.frameCount, 2);
    assert.equal(result.nativeUi.samples[0]?.completedAtEpochMs, 10_026.667);
    assert.equal(result.nativeUi.samples[0]?.durationMs, 16.667);
    assert.equal(result.javascript.status, 'complete');
    assert.equal(result.javascript.kind, 'cdp-js-runtime-tasks');
    assert.equal(result.javascript.summary.taskCount, 1);
    assert.equal(result.javascript.summary.longTaskCount, 0);
    assert.equal(result.javascript.summary.longestTaskMs, 20);
    assert.equal(
      result.rawTraceEvents?.find((event) => event.name === 'BeginFrame')?.ts,
      10_010_000,
    );
  });

  it('does not score an unclassified cadence gap as smooth', () => {
    const begins = [
      1_010_000, 1_026_667, 1_043_334, 1_060_001, 1_076_668, 1_093_335, 6_093_335, 6_110_002,
    ];
    const result = parseTraceCapture(
      capture(
        'ios',
        begins.flatMap((begin, index) => frame(index + 1, begin, begin + 10_000)),
      ),
      IOS,
    );

    assert.equal(result.nativeUi.status, 'partial');
    assert.deepEqual(result.nativeUi.coverageGapReasons, [
      'Unclassified native cadence gap prevents a complete FPS result.',
    ]);
    assert.equal(result.nativeUi.summary.cadenceGapCount, 1);
    assert.equal(result.nativeUi.summary.fpsUnavailableReason, 'unclassified_cadence_gap');
    assert.equal(result.nativeUi.summary.longestCadenceGapMs, 5_000);
    assert.ok(!('activeFps' in result.nativeUi.summary));
  });

  it('uses draw frame work duration against the 60 FPS budget', () => {
    const result = parseTraceCapture(
      capture('android', [...frame(1, 1_010_000, 1_020_000), ...frame(2, 1_030_000, 1_055_000)]),
      ANDROID,
    );

    assert.equal(result.nativeUi.status, 'complete');
    assert.equal(result.nativeUi.summary.frameCount, 2);
    assert.equal(result.nativeUi.summary.longestFrameMs, 25);
  });

  it('keeps missing markers and trace data loss honest', () => {
    const missing = parseTraceCapture(
      { ...capture('extension', []), markerName: 'missing' },
      EXTENSION,
    );
    assert.equal(missing.nativeUi.status, 'unavailable');

    const partial = parseTraceCapture(
      {
        ...capture('extension', [...frame(1, 1_010_000, 1_030_000)]),
        dataLossOccurred: true,
      },
      EXTENSION,
    );
    assert.equal(partial.nativeUi.status, 'partial');
    assert.deepEqual(partial.nativeUi.coverageGapReasons, ['CDP reported trace data loss.']);
  });

  it('scopes renderer samples to the process that emitted the clock marker', () => {
    const other = frame(2, 1_040_000, 1_060_000).map((event) => ({ ...event, pid: 99 }));
    const result = parseTraceCapture(
      capture('extension', [...frame(1, 1_010_000, 1_030_000), ...other]),
      EXTENSION,
    );

    assert.equal(result.trace.beginFrameCount, 1);
    assert.equal(result.trace.drawFrameCount, 1);
    assert.equal(result.trace.rendererProcessId, 42);
    assert.equal(result.trace.scope, 'extension-renderer');
    assert.equal(result.nativeUi.summary.frameCount, 1);
    assert.deepEqual(
      result.rawTraceEvents?.map((event) => [event.name, event.pid]),
      [
        ['clock', 42],
        ['BeginFrame', 42],
        ['DrawFrame', 42],
      ],
    );
  });

  it('fails closed when a renderer-scoped marker has no pid', () => {
    const result = parseTraceCapture(
      {
        ...capture('extension', []),
        events: [{ ...marker, pid: undefined }, ...frame(1, 1_010_000, 1_030_000)],
      },
      EXTENSION,
    );

    assert.equal(result.trace.scope, 'unresolved');
    assert.equal(result.javascript.status, 'unavailable');
    assert.equal(result.nativeUi.status, 'unavailable');
    assert.ok(!('rawTraceEvents' in result));
  });
});

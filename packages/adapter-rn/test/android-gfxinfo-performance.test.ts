import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { CdpClient, TraceKind } from '@farmslot/recipe-runner/runtime/cdp-trace';

import {
  androidClockSync,
  androidFrameSample,
  buildAndroidFrameTraceEvents,
  createAndroidGfxinfoPerformanceBackend,
  parseFrameStats,
} from '../src/android-gfxinfo-performance.js';
import { createReactNativeTracePerformanceBackend } from '../src/performance-observer.js';

const HEADER =
  'Flags,FrameTimelineVsyncId,IntendedVsync,Vsync,InputEventId,HandleInputStart,AnimationStart,PerformTraversalsStart,DrawStart,FrameDeadline,FrameStartTime,FrameInterval,SyncQueued,SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,';

function framestats(rows: number, firstId = 1): string {
  const lines = Array.from({ length: rows }, (_, index) => {
    const vsync = 1_050_000_000 + (firstId + index) * 11_111_111;
    return `0,${firstId + index},${vsync},${vsync},0,0,0,0,0,${vsync + 22_000_000},0,11111111,${vsync + 3_000_000},0,0,0,${vsync + 8_000_000},`;
  });
  return [
    'Uptime: 1000 Realtime: 2000',
    '---PROFILEDATA---',
    HEADER,
    ...lines,
    '---PROFILEDATA---',
  ].join('\n');
}

// A fake adb: `reset` succeeds, and framestats calls print `responses` in turn
// (the last one repeats); a response of null exits 1.
async function fakeAdb(responses: Array<string | null>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'adapter-rn-gfxinfo-'));
  await Promise.all(
    responses.map((response, index) =>
      response === null ? undefined : writeFile(path.join(dir, `out-${index}.txt`), response),
    ),
  );
  const script = path.join(dir, 'adb');
  await writeFile(
    script,
    [
      '#!/bin/sh',
      `dir="${dir}"`,
      'case "$*" in *framestats*) ;; *) exit 0;; esac',
      'n=$(cat "$dir/count" 2>/dev/null || echo 0); echo $((n + 1)) > "$dir/count"',
      `last=${responses.length - 1}; [ "$n" -gt "$last" ] && n=$last`,
      '[ -f "$dir/out-$n.txt" ] || exit 1',
      'cat "$dir/out-$n.txt"',
      '',
    ].join('\n'),
  );
  await chmod(script, 0o755);
  return { adbPath: script, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const fixtureUrl = new URL('./fixtures/android-gfxinfo-framestats.txt', import.meta.url);

describe('Android gfxinfo performance', () => {
  it('parses current and legacy framestats columns by header name', async () => {
    const parsed = parseFrameStats(await readFile(fixtureUrl, 'utf8'));

    assert.equal(parsed.bufferCapacityReached, false);
    assert.equal(parsed.frames.length, 2);
    assert.deepEqual(
      parsed.frames.map((frame) => frame.frameIntervalNs),
      [11_095_762, 11_095_762],
    );
    assert.deepEqual(
      parsed.frames.map((frame) => frame.completedNs),
      [1_841_116_558_008_269, 1_841_116_568_008_269],
    );
  });

  it('fails explicitly when the required header is unknown', () => {
    assert.throws(
      () => parseFrameStats('---PROFILEDATA---\nFlags,Vsync\n0,1\n'),
      /missing IntendedVsync, FrameCompleted/u,
    );
  });

  it('maps device uptime to the midpoint of the host request', () => {
    assert.deepEqual(androidClockSync({ hostEpochMs: 10_010, uncertaintyMs: 10 }, 2_000), {
      hostEpochAtDeviceUptimeMs: 8_010,
      uncertaintyMs: 10,
    });
  });

  it('keeps raw over-budget evidence aligned with its classification', async () => {
    const parsed = parseFrameStats(await readFile(fixtureUrl, 'utf8'));
    const rows = parsed.frames.map((frame, index) => ({
      ...frame,
      deadlineNs: index === 0 ? frame.intendedVsyncNs + 5_000_000 : 0,
    }));
    const events = buildAndroidFrameTraceEvents(
      rows,
      { hostEpochAtDeviceUptimeMs: 1_000, uncertaintyMs: 1 },
      16.667,
    );
    const first = events.find(
      (event) => event.name === 'DrawFrame' && event.args?.frameSeqId === '574526901',
    );
    const second = events.find(
      (event) => event.name === 'DrawFrame' && event.args?.frameSeqId === '574526902',
    );

    assert.equal(first?.args?.frameDeadlineMissed, true);
    assert.equal(first?.args?.overBudget, true);
    assert.equal(first?.args?.overBudgetClassification, 'frame-deadline');
    assert.equal(second?.args?.overBudgetClassification, 'refresh-budget');
    assert.equal(second?.args && 'frameDeadlineMissed' in second.args, false);
    assert.ok((first?.ts ?? 0) > 1_000_000);
  });

  it('marks frames that handled input and their UI-thread time', async () => {
    const output = (await readFile(fixtureUrl, 'utf8')).replace(
      '0,574526901,1841116546248077,1841116546248077,0,',
      '0,574526901,1841116546248077,1841116546248077,77,',
    );
    const [touched, plain] = parseFrameStats(output).frames;
    assert.ok(touched && plain);
    const clock = { hostEpochAtDeviceUptimeMs: 0, uncertaintyMs: 0 };
    const touchedSample = androidFrameSample(touched, clock, undefined);
    assert.equal(touchedSample.input, true);
    assert.equal(touchedSample.uiThreadMs, (1841116554974171 - 1841116546248077) / 1_000_000);
    assert.equal(androidFrameSample(plain, clock, undefined).input, undefined);
  });

  it('flags a device whose framestats has no InputEventId column', () => {
    const legacy = '---PROFILEDATA---\nFlags,IntendedVsync,Vsync,FrameCompleted\n0,10,10,20\n';
    assert.equal(parseFrameStats(legacy).inputEventColumn, false);
    assert.equal(parseFrameStats(framestats(2)).inputEventColumn, true);
  });

  it('records a failed poll as a coverage gap', async () => {
    const adb = await fakeAdb([framestats(1), null]);
    try {
      const backend = createAndroidGfxinfoPerformanceBackend({
        serial: 'emulator-5554',
        packageId: 'com.example',
        adbPath: adb.adbPath,
      });
      await backend.start('w');
      const result = await backend.end('w');
      assert.equal(result.nativeUi.status, 'unavailable');
      assert.match(result.nativeUi.coverageGapReasons.join(';'), /poll failed/u);
    } finally {
      await adb.cleanup();
    }
  });

  it('records frames gfxinfo may have overwritten between polls as a coverage gap', async () => {
    const adb = await fakeAdb([framestats(1), framestats(120, 10)]);
    try {
      const backend = createAndroidGfxinfoPerformanceBackend({
        serial: 'emulator-5554',
        packageId: 'com.example',
        adbPath: adb.adbPath,
      });
      await backend.start('w');
      const result = await backend.end('w');
      assert.equal(result.nativeUi.status, 'partial');
      assert.match(result.nativeUi.coverageGapReasons.join(';'), /overwritten/u);
    } finally {
      await adb.cleanup();
    }
  });

  it('marks the React Native trace with performance.mark under the host prefix', async () => {
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const handlers = new Map<string, (params: Record<string, unknown>) => void>();
    let markerName = '';
    const client: CdpClient = {
      async send(method, params) {
        sent.push({ method, ...(params ? { params } : {}) });
        if (method === 'Runtime.evaluate') {
          markerName = JSON.parse(String(params?.expression).slice('performance.mark('.length, -1));
        }
        if (method === 'Tracing.end') {
          handlers.get('Tracing.dataCollected')?.({
            value: [{ name: markerName, ph: 'I', pid: 1, ts: 1_000_000 }],
          });
          handlers.get('Tracing.tracingComplete')?.({});
        }
        return {};
      },
      on(method, handler) {
        handlers.set(method, handler);
        return () => handlers.delete(method);
      },
      close() {},
    };
    const kind: TraceKind = {
      categories: ['blink.user_timing'],
      rendererScoped: false,
      scope: 'mobile-host',
      nativeSource: 'react-native-cdp-frame-timings',
      javascriptTasks: false,
      frameTiming: 'cadence',
    };
    const backend = createReactNativeTracePerformanceBackend(client, {
      kind,
      platform: 'ios',
      markerPrefix: 'host-clock-',
    });
    await backend.start('w');
    const result = await backend.end('w');
    assert.match(markerName, /^host-clock-w-\d+$/u);
    assert.deepEqual(
      sent.map((call) => call.method),
      ['Tracing.start', 'Runtime.evaluate', 'Tracing.end'],
    );
    assert.equal(result.platform, 'ios');
  });

  it('logs each device read it has to skip', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'adapter-rn-gfxinfo-'));
    const adbPath = path.join(dir, 'adb');
    await writeFile(adbPath, '#!/bin/sh\necho "device offline" >&2\nexit 1\n');
    await chmod(adbPath, 0o755);
    const warnings: string[] = [];
    try {
      const backend = createAndroidGfxinfoPerformanceBackend({
        serial: 'emulator-5554',
        packageId: 'com.example',
        adbPath,
        logger: { warn: (message: string) => warnings.push(message) },
      });
      assert.deepEqual(await backend.describe?.(), {
        serial: 'emulator-5554',
        packageId: 'com.example',
      });
      assert.equal(warnings.length, 3);
      assert.ok(
        warnings.some((warning) => /skipped adb shell dumpsys package com\.example/u.test(warning)),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('requires a serial and a package id', () => {
    assert.throws(
      () => createAndroidGfxinfoPerformanceBackend({ serial: ' ', packageId: 'com.example' }),
      /adb serial/u,
    );
    assert.throws(
      () => createAndroidGfxinfoPerformanceBackend({ serial: 'emulator-5554', packageId: '' }),
      /package id/u,
    );
  });
});

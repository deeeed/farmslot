import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  androidClockSync,
  androidFrameSample,
  buildAndroidFrameTraceEvents,
  createAndroidGfxinfoPerformanceBackend,
  parseFrameStats,
} from '../src/android-gfxinfo-performance.js';

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
    assert.deepEqual(androidClockSync(10_000, 10_020, 2_000), {
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

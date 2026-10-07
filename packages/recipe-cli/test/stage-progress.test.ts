import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import {
  createStageReporter,
  formatElapsed,
  JsonStreamWriter,
  stageProgressText,
} from '../src/harness/index.js';

function reporter(options: { stallMs?: number } = {}) {
  const lines: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const stages = createStageReporter({
    write: (line) => lines.push(line),
    event: (fields) => events.push(fields),
    ...options,
  });
  return { stages, lines, events };
}

// One second at a time, as a real clock moves: a heartbeat that reschedules
// itself must see the time it fired at.
function advance(ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000)
    mock.timers.tick(Math.min(1_000, ms - elapsed));
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
});
afterEach(() => {
  mock.timers.reset();
  delete process.env.RECIPE_STAGE_STALL_NOTICE_MS;
});

describe('stage progress', () => {
  test('formats elapsed time as 20s, 1m42s and 1h03m', () => {
    assert.equal(formatElapsed(0), '0s');
    assert.equal(formatElapsed(20_400), '20s');
    assert.equal(formatElapsed(60_000), '1m00s');
    assert.equal(formatElapsed(102_000), '1m42s');
    assert.equal(formatElapsed(3_780_000), '1h03m');
  });

  test('renders what a stage waits for, how far it is, and the screen', () => {
    assert.equal(
      stageProgressText({
        message: 'bundling',
        percent: 61.3,
        current: 4210,
        total: 6900,
        unit: 'modules',
      }),
      'bundling 61% (4,210/6,900 modules)',
    );
    assert.equal(
      stageProgressText({ waitingFor: 'unlock', screen: '#onboarding/welcome' }),
      'waiting for unlock, page is #onboarding/welcome',
    );
    assert.equal(stageProgressText({}), '');
  });

  test('prints start, progress and done lines with the elapsed time', () => {
    const { stages, lines, events } = reporter();
    const stage = stages.stage('metro', { index: 2, total: 5 });
    advance(4_000);
    stage.progress({
      message: 'bundling',
      percent: 61,
      current: 4210,
      total: 6900,
      unit: 'modules',
    });
    // The same payload again is not a new line.
    stage.progress({
      message: 'bundling',
      percent: 61.4,
      current: 4210,
      total: 6900,
      unit: 'modules',
    });
    advance(98_000);
    stage.done('bundle ready');
    assert.deepEqual(lines, [
      '[2/5] metro: started, 0s',
      '[2/5] metro: bundling 61% (4,210/6,900 modules), 4s',
      '[2/5] metro: bundling 61% (4,210/6,900 modules), 19s',
      '[2/5] metro: bundling 61% (4,210/6,900 modules), 34s',
      '[2/5] metro: bundling 61% (4,210/6,900 modules), 49s',
      '[2/5] metro: no progress for 1m00s, still bundling 61% (4,210/6,900 modules), 1m04s',
      '[2/5] metro: no progress for 1m15s, still bundling 61% (4,210/6,900 modules), 1m19s',
      '[2/5] metro: no progress for 1m30s, still bundling 61% (4,210/6,900 modules), 1m34s',
      '[2/5] metro: done, bundle ready, 1m42s',
    ]);
    assert.deepEqual(events[0], {
      stage: 'metro',
      index: 2,
      total: 5,
      status: 'start',
      elapsedMs: 0,
    });
    assert.deepEqual(events[1], {
      stage: 'metro',
      index: 2,
      total: 5,
      status: 'progress',
      elapsedMs: 4_000,
      message: 'bundling',
      percent: 61,
      current: 4210,
      totalCount: 6900,
      unit: 'modules',
    });
    assert.equal(events[5]?.stalledMs, 60_000);
    assert.deepEqual(events.at(-1), {
      stage: 'metro',
      index: 2,
      total: 5,
      status: 'done',
      elapsedMs: 102_000,
      message: 'bundle ready',
    });
  });

  test('a heartbeat at least every 15 s, a stall notice that never fails, cleared by progress', () => {
    const { stages, lines, events } = reporter();
    const stage = stages.stage('wallet', { index: 4, total: 5 });
    advance(5_000);
    stage.progress({ waitingFor: 'unlock', screen: '#onboarding/welcome' });
    advance(75_000);
    assert.deepEqual(lines.slice(1), [
      '[4/5] wallet: waiting for unlock, page is #onboarding/welcome, 5s',
      '[4/5] wallet: waiting for unlock, page is #onboarding/welcome, 20s',
      '[4/5] wallet: waiting for unlock, page is #onboarding/welcome, 35s',
      '[4/5] wallet: waiting for unlock, page is #onboarding/welcome, 50s',
      '[4/5] wallet: no progress for 1m00s, still on #onboarding/welcome, 1m05s',
      '[4/5] wallet: no progress for 1m15s, still on #onboarding/welcome, 1m20s',
    ]);
    assert.equal(events.at(-1)?.status, 'progress');
    assert.equal(events.at(-1)?.stalledMs, 75_000);
    // The payload changes: the next heartbeat is plain progress again.
    stage.progress({ waitingFor: 'unlock', screen: '#unlock' });
    advance(15_000);
    assert.deepEqual(lines.slice(-2), [
      '[4/5] wallet: waiting for unlock, page is #unlock, 1m20s',
      '[4/5] wallet: waiting for unlock, page is #unlock, 1m35s',
    ]);
    assert.equal(events.at(-1)?.stalledMs, undefined);
    stage.failed('still locked');
    assert.equal(lines.at(-1), '[4/5] wallet: failed, still locked, 1m35s');
    assert.equal(events.at(-1)?.status, 'failed');
  });

  test('the stall threshold comes from RECIPE_STAGE_STALL_NOTICE_MS', () => {
    process.env.RECIPE_STAGE_STALL_NOTICE_MS = '30000';
    const { stages, lines } = reporter();
    stages.stage('fixtures', { index: 1, total: 1 });
    advance(30_000);
    assert.deepEqual(lines, [
      '[1/1] fixtures: started, 0s',
      '[1/1] fixtures: running, 15s',
      '[1/1] fixtures: no progress for 30s, 30s',
    ]);
  });

  test('a child command’s stage lines nest under the parent and stand in for its heartbeat', () => {
    const { stages, lines } = reporter();
    const stage = stages.stage('launch --verify', { index: 3, total: 5 });
    advance(10_000);
    stage.forward('[2/5] metro: bundling 61% (4,210/6,900 modules), 1m42s');
    // The child speaks within a heartbeat: the parent stays quiet.
    advance(14_000);
    stage.forward('[2/5] metro: no progress for 1m00s, still bundling 61%, 2m42s');
    // The child goes quiet: the parent speaks a heartbeat after its last line.
    advance(15_000);
    assert.deepEqual(lines, [
      '[3/5] launch --verify: started, 0s',
      '[3/5] launch --verify › [2/5] metro: bundling 61% (4,210/6,900 modules), 1m42s',
      '[3/5] launch --verify › [2/5] metro: no progress for 1m00s, still bundling 61%, 2m42s',
      '[3/5] launch --verify: running, 39s',
    ]);
    for (const line of lines) assert.match(line, /\[(\d+)\/(\d+)\]\s*(.+)$/u);
  });

  test('ending stages clears their timers so the process can exit', () => {
    const { stages, lines } = reporter();
    const done = stages.stage('doctor --fix', { index: 1, total: 3 });
    stages.stage('status', { index: 2, total: 3 });
    done.done();
    stages.close('failed', 'prepare stopped');
    const count = lines.length;
    advance(120_000);
    assert.equal(lines.length, count);
    assert.deepEqual(lines.slice(-2), [
      '[1/3] doctor --fix: done, 0s',
      '[2/3] status: failed, prepare stopped, 0s',
    ]);
  });

  test('--json-stream carries a stage event and a stage left open ends with the command', () => {
    const out: string[] = [];
    const err: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => err.push(chunk) > 0) as typeof process.stderr.write;
    try {
      const output = { write: (line: string) => out.push(line) > 0 };
      const stream = new JsonStreamWriter(
        'launch',
        true,
        output as Pick<NodeJS.WriteStream, 'write'>,
      );
      const stage = stream.stage('browser', { index: 1, total: 2 });
      stage.progress({ message: 'starting the browser' });
      stream.error({ code: 'LAUNCH_FAILED', message: 'Chrome binary not found' });
      stream.complete('fail', 1);
    } finally {
      process.stderr.write = write;
    }
    const events = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      events.map((event) => [event.event, event.status]),
      [
        ['stage', 'start'],
        ['stage', 'progress'],
        ['error', undefined],
        ['stage', 'failed'],
        ['complete', 'fail'],
      ],
    );
    assert.equal(events[3]?.message, 'Chrome binary not found');
    assert.deepEqual(err, [
      '[1/2] browser: started, 0s\n',
      '[1/2] browser: starting the browser, 0s\n',
      '[1/2] browser: failed, Chrome binary not found, 0s\n',
    ]);
  });
});

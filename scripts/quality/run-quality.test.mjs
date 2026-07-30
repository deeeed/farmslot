import assert from 'node:assert/strict';
import test from 'node:test';

import {
  qualitySummaryLines,
  qualityTimingArtifact,
  runQualitySteps,
  STEPS,
} from './run-quality.mjs';

/** Clock that advances by a scripted amount on each measured step. */
function fakeClock(durations) {
  let current = 0;
  const pending = [...durations];
  let started = false;
  return () => {
    if (!started) {
      started = true;
      return current;
    }
    started = false;
    current += pending.shift() ?? 0;
    return current;
  };
}

function fakeSpawn(statuses) {
  const pending = [...statuses];
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args].join(' '));
    return { status: pending.shift() ?? 0 };
  };
  return { spawn, calls };
}

const SAMPLE_STEPS = [
  ['fast step', ['yarn', 'fast']],
  ['slow step', ['yarn', 'slow']],
  ['middle step', ['yarn', 'middle']],
];

test('every step records an elapsed duration on success', () => {
  const { spawn, calls } = fakeSpawn([0, 0, 0]);
  const lines = [];
  const { records, failure } = runQualitySteps(SAMPLE_STEPS, {
    spawn,
    now: fakeClock([100, 5000, 900]),
    log: (line) => lines.push(line),
  });

  assert.equal(failure, null);
  assert.deepEqual(calls, ['yarn fast', 'yarn slow', 'yarn middle']);
  assert.deepEqual(
    records.map((record) => [record.label, record.ms, record.status]),
    [
      ['fast step', 100, 0],
      ['slow step', 5000, 0],
      ['middle step', 900, 0],
    ],
  );
  assert.ok(lines.includes('[quality] done step="fast step" status=ok ms=100 (100ms)'));
  assert.ok(lines.includes('[quality] done step="slow step" status=ok ms=5000 (5.0s)'));
});

test('summary ranks the slowest steps and reports totals', () => {
  const { spawn } = fakeSpawn([0, 0, 0]);
  const { records, failure } = runQualitySteps(SAMPLE_STEPS, {
    spawn,
    now: fakeClock([100, 5000, 900]),
    log: () => {},
  });

  const summary = qualitySummaryLines(records, failure);
  assert.equal(summary[0], '\n[quality] summary steps=3 ok=3 failed=0 total_ms=6000 total=6.0s');
  assert.deepEqual(summary.slice(1), [
    '[quality] slowest:',
    '[quality]   1. slow step ms=5000 (5.0s)',
    '[quality]   2. middle step ms=900 (900ms)',
    '[quality]   3. fast step ms=100 (100ms)',
  ]);
});

test('a failing step stops the run and is named in the summary output', () => {
  const { spawn, calls } = fakeSpawn([0, 2]);
  const { records, failure } = runQualitySteps(SAMPLE_STEPS, {
    spawn,
    now: fakeClock([100, 5000]),
    log: () => {},
  });

  assert.deepEqual(failure, { label: 'slow step', status: 2 });
  assert.deepEqual(calls, ['yarn fast', 'yarn slow'], 'steps after the failure must not run');
  assert.equal(records.length, 2);

  const summary = qualitySummaryLines(records, failure);
  assert.equal(summary[0], '\n[quality] summary steps=2 ok=1 failed=1 total_ms=5100 total=5.1s');
  assert.equal(summary[1], '[quality] failed step="slow step" status=2');
  assert.ok(summary.includes('[quality]   1. slow step ms=5000 (5.0s)'));
});

test('timing artifact is machine-readable for success and failure', () => {
  const ok = runQualitySteps(SAMPLE_STEPS, {
    spawn: fakeSpawn([0, 0, 0]).spawn,
    now: fakeClock([100, 5000, 900]),
    log: () => {},
  });
  const okArtifact = qualityTimingArtifact(ok.records, ok.failure);
  assert.equal(okArtifact.kind, 'quality-steps');
  assert.equal(okArtifact.status, 'ok');
  assert.equal(okArtifact.failedStep, null);
  assert.equal(okArtifact.totalMs, 6000);
  assert.deepEqual(okArtifact.steps[1], {
    label: 'slow step',
    command: 'yarn slow',
    ms: 5000,
    status: 'ok',
  });
  assert.deepEqual(okArtifact.slowest[0], { label: 'slow step', ms: 5000 });
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(okArtifact)));

  const failed = runQualitySteps(SAMPLE_STEPS, {
    spawn: fakeSpawn([0, 3]).spawn,
    now: fakeClock([100, 5000]),
    log: () => {},
  });
  const failArtifact = qualityTimingArtifact(failed.records, failed.failure);
  assert.equal(failArtifact.status, 'fail');
  assert.equal(failArtifact.failedStep, 'slow step');
  assert.equal(failArtifact.steps.at(-1).status, 'fail');
});

test('slowest ranking is deterministic when durations tie', () => {
  const { spawn } = fakeSpawn([0, 0, 0]);
  const { records, failure } = runQualitySteps(
    [
      ['zebra', ['yarn', 'zebra']],
      ['alpha', ['yarn', 'alpha']],
      ['mango', ['yarn', 'mango']],
    ],
    { spawn, now: fakeClock([500, 500, 500]), log: () => {} },
  );
  assert.deepEqual(
    qualityTimingArtifact(records, failure).slowest.map((entry) => entry.label),
    ['alpha', 'mango', 'zebra'],
  );
});

test('a spawn error surfaces instead of being recorded as a failed step', () => {
  const boom = new Error('spawn ENOENT');
  assert.throws(
    () =>
      runQualitySteps(SAMPLE_STEPS, {
        spawn: () => ({ error: boom }),
        now: fakeClock([10]),
        log: () => {},
      }),
    /spawn ENOENT/,
  );
});

test('canonical STEPS stay uniquely labelled and executable', () => {
  const labels = STEPS.map(([label]) => label);
  assert.equal(new Set(labels).size, labels.length, 'duplicate step labels break timing reports');
  for (const [label, command] of STEPS) {
    assert.equal(typeof label, 'string');
    assert.ok(label.length > 0);
    assert.ok(Array.isArray(command) && command.length > 0, `${label} needs a command`);
  }
});

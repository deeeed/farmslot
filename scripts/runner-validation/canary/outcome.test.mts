import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyKnownFailures,
  type CheckResult,
  type KnownFailure,
  reviewDriftExcuses,
} from './outcome.mjs';
import { report, verdict } from './report.mjs';

const check = (overrides: Partial<CheckResult>): CheckResult => ({
  case: 'worker-survives',
  variant: 'dispatch',
  target: 'isolated',
  status: 'fail',
  model: 'scripted',
  modelCalls: 0,
  differences: [],
  observations: [],
  ...overrides,
});

const entry: KnownFailure = {
  case: 'worker-survives',
  variant: 'dispatch',
  signature: 'tmux stop sent: .*/exit',
  differences: ['^tmux stop sent: .*/exit'],
  ledger: 'F331',
};

test('a failure is known only when it has the signature and no other difference', () => {
  const known = check({ differences: ['tmux stop sent: send-keys -t %2 -l /exit'] });
  assert.equal(applyKnownFailures(known, [entry]).status, 'known');
  const unrelated = check({
    differences: ['tmux stop sent: send-keys -t %2 -l /exit', 'step 3: expected prepare:done'],
  });
  const applied = applyKnownFailures(unrelated, [entry]);
  assert.equal(applied.status, 'fail');
  assert.match(applied.observations.join(), /fails differently from its known entry \(F331\)/);
  assert.equal(
    applyKnownFailures(check({ differences: ['something else'] }), [entry]).status,
    'fail',
  );
});

test('a passing check with a known entry fails the canary until the entry goes', () => {
  assert.equal(applyKnownFailures(check({ status: 'pass' }), [entry]).status, 'xpass');
});

test('loop 2 issues excuse a reviewed run only when the restarts did their part', () => {
  const excused = {
    loop2: 'issues',
    fixLanded: true,
    procedural: [],
    relaunched: false,
    retriesExhausted: true,
  };
  assert.equal(reviewDriftExcuses(excused), true);
  assert.equal(reviewDriftExcuses({ ...excused, loop2: 'pass' }), false);
  assert.equal(reviewDriftExcuses({ ...excused, fixLanded: false }), false);
  assert.equal(reviewDriftExcuses({ ...excused, procedural: ['a hold was missed'] }), false);
  assert.equal(reviewDriftExcuses({ ...excused, relaunched: true }), false);
  assert.equal(reviewDriftExcuses({ ...excused, retriesExhausted: false }), false);
});

test('a canary that ran no check could not run', () => {
  assert.deepEqual(verdict([], undefined), {
    ok: false,
    exitCode: 2,
    summary: 'could not run: no check ran',
  });
});

test('a failed cleanup blocks an otherwise passing canary', () => {
  const passing = [check({ status: 'pass' })];
  assert.equal(verdict(passing, undefined).ok, true);
  const failed = verdict(passing, undefined, ['gateway: stop timed out\nmore']);
  assert.deepEqual([failed.ok, failed.exitCode], [false, 1]);
  assert.match(failed.summary, /1 cleanup failed \(gateway: stop timed out\)$/);
});

test('a failed canary sets the deploy hold, and never replaces one already there', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'canary-hold-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const holdFile = path.join(dir, 'HOLD');
  const failing = {
    profile: 'canary',
    head: 'abcdef012345',
    startedAt: new Date(),
    resultsFile: path.join(dir, 'results.json'),
    holdFile,
    checks: [check({})],
    cleanupErrors: [],
    evidence: dir,
    extra: {},
  };
  await report(failing);
  assert.match(readFileSync(holdFile, 'utf8'), /^Canary .*canary failed at abcdef01/);
  writeFileSync(holdFile, 'the lead holds this\n');
  await report(failing);
  assert.equal(readFileSync(holdFile, 'utf8'), 'the lead holds this\n');
  rmSync(holdFile);
  await report({ ...failing, checks: [check({ status: 'pass' })] });
  assert.equal(existsSync(holdFile), false);
});

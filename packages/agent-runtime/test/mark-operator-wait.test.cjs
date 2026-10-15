const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const helper = path.resolve(__dirname, '../scripts/mark-checklist-step.cjs');

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'operator-mark-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checklist = path.join(dir, 'CHECKLIST.md');
  const signal = path.join(dir, 'SIGNAL.json');
  writeFileSync(checklist, '# Approach\n\n- [ ] Confirm approach\n- [ ] Execute\n');
  writeFileSync(
    path.join(dir, 'checklist-target.json'),
    JSON.stringify({ checklist: 'CHECKLIST.md' }),
  );
  const env = { ...process.env, FARMSLOT_SIGNAL_ATTEMPT_ID: 'owned-attempt' };
  const mark = (...args) =>
    spawnSync(process.execPath, [helper, dir, ...args], { env, encoding: 'utf8' });
  const started = mark('start');
  assert.equal(started.status, 0, started.stderr);
  return {
    dir,
    checklist,
    signal,
    mark,
    env,
    read: () => JSON.parse(readFileSync(signal, 'utf8')),
  };
}

test('wait and resume preserve the attempt, checklist and repeated-wait timestamp', (t) => {
  const f = fixture(t);
  const before = readFileSync(f.checklist, 'utf8');
  let result = f.mark('wait', '--who', 'operator', '--reason', 'Review approach');
  assert.equal(result.status, 0, result.stderr);
  const waiting = f.read();
  assert.equal(waiting.status, 'running');
  assert.equal(waiting.attemptId, 'owned-attempt');
  assert.equal(waiting.waitingForOperator.who, 'operator');
  assert.equal(waiting.checklistTiming.events.length, 0);
  assert.equal(readFileSync(f.checklist, 'utf8'), before);
  const bytes = readFileSync(f.signal, 'utf8');
  result = f.mark('wait', '--who', 'operator', '--reason', 'Review approach');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.signal, 'utf8'), bytes);
  result = f.mark('resume');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.read().waitingForOperator, undefined);
  assert.equal(f.read().attemptId, 'owned-attempt');
  assert.equal(f.read().operatorWaitIntervals[0].since, waiting.waitingForOperator.since);
  assert.equal(readFileSync(f.checklist, 'utf8'), before);
  const resumed = readFileSync(f.signal, 'utf8');
  result = f.mark('resume');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.signal, 'utf8'), resumed);
});

test('normal marks clear waiting and a new launch drops the previous attempt intervals', (t) => {
  const f = fixture(t);
  assert.equal(f.mark('wait', '--who', 'operator', '--reason', 'Approach').status, 0);
  let result = f.mark('1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.read().waitingForOperator, undefined);
  assert.equal(f.read().operatorWaitIntervals.length, 1);
  assert.equal(f.read().checklistTiming.events.length, 1);
  assert.equal(f.mark('wait', '--who', 'operator', '--reason', 'Continue').status, 0);
  result = spawnSync(process.execPath, [helper, f.dir, 'start'], {
    env: { ...f.env, FARMSLOT_SIGNAL_ATTEMPT_ID: 'replacement-attempt' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.read().attemptId, 'replacement-attempt');
  assert.equal(f.read().waitingForOperator, undefined);
  assert.equal(f.read().operatorWaitIntervals, undefined);
});

test('foreign attempts and settled signals cannot enter operator waiting', (t) => {
  const f = fixture(t);
  const before = readFileSync(f.signal, 'utf8');
  const foreign = spawnSync(
    process.execPath,
    [helper, f.dir, 'wait', '--who', 'operator', '--reason', 'Approach'],
    {
      env: { ...f.env, FARMSLOT_SIGNAL_ATTEMPT_ID: 'foreign-attempt' },
      encoding: 'utf8',
    },
  );
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /different worker attempt/);
  assert.equal(readFileSync(f.signal, 'utf8'), before);
  writeFileSync(f.signal, JSON.stringify({ ...f.read(), status: 'blocked' }));
  const settled = readFileSync(f.signal, 'utf8');
  assert.notEqual(f.mark('wait', '--who', 'operator', '--reason', 'Approach').status, 0);
  assert.equal(readFileSync(f.signal, 'utf8'), settled);
});

test('child progress closes parent waiting and child completion preserves all wait intervals', (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.dir, 'child.md'), '# Child\n\n- [ ] Review\n');
  let result = f.mark('sub', 'start', 'review', '--step', '1', '--from', 'child.md');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.mark('wait', '--who', 'operator', '--reason', 'Review approach').status, 0);
  const first = f.read().waitingForOperator;
  result = f.mark('sub', 'review', '1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.read().waitingForOperator, undefined);
  assert.equal(f.read().operatorWaitIntervals[0].since, first.since);
  assert.equal(f.read().checklistTiming.events.length, 0);
  const closed = f.read().operatorWaitIntervals[0];
  assert.equal(f.mark('wait', '--who', 'operator', '--reason', 'Approve child result').status, 0);
  const second = f.read().waitingForOperator;
  result = f.mark('sub', 'review', 'complete');
  assert.equal(result.status, 0, result.stderr);
  const signal = f.read();
  assert.equal(signal.waitingForOperator, undefined);
  assert.equal(signal.attemptId, 'owned-attempt');
  assert.equal(signal.operatorWaitIntervals.length, 2);
  assert.deepEqual(signal.operatorWaitIntervals[0], closed);
  assert.equal(signal.operatorWaitIntervals[1].since, second.since);
  assert.equal(signal.checklistTiming.events.length, 1);
  assert.equal(f.mark('2').status, 0);
  assert.deepEqual(f.read().operatorWaitIntervals, signal.operatorWaitIntervals);
});

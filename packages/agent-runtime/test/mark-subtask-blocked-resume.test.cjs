const {
  makeTask,
  assert,
  mark,
  childSignal,
  assertChildStatusAllowed,
  parentSignal,
  existsSync,
  path,
} = require('./mark-subtask.test-support.cjs');

// ---------------------------------------------------------------------------
// 2. blocked → resume, and the child's freedom from the flow terminal contract.
{
  const dir = makeTask();
  assert.equal(mark(dir, 'start').status, 0);
  // A child on step 2 claims the work reached it, so step 1 is done first
  // (ADR-064 Amendment 7).
  assert.equal(mark(dir, '1').status, 0);
  assert.equal(
    mark(dir, 'sub', 'start', 'perps-review', '--step', '2', '--from', 'skill.md').status,
    0,
  );

  let refused = mark(dir, 'sub', 'perps-review', 'blocked');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /sub blocked requires --reason/);

  const blocked = mark(dir, 'sub', 'perps-review', 'blocked', '--reason', 'skill needs the diff');
  assert.equal(blocked.status, 0, blocked.stderr);
  let child = childSignal(dir, 'perps-review');
  assert.equal(child.status, 'blocked');
  assert.equal(child.outcome, 'partial');
  assert.equal(child.disposition, 'blocked');
  assert.equal(child.reason, 'skill needs the diff');
  assertChildStatusAllowed(child);
  let parent = parentSignal(dir);
  assert.equal(parent.status, 'blocked');
  assert.equal(parent.outcome, 'partial');
  assert.equal(parent.disposition, 'blocked');
  assert.equal(parent.reason, 'subtask perps-review: skill needs the diff');
  assert.equal(parent.step, '2. Review the diff against the review skill');

  // A blocked child keeps ownership: it is terminal for the run, not settled.
  refused = mark(dir, '2');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /step 2 is owned by subtask perps-review/);
  // The parent may still report blocked itself.
  const parentBlocked = mark(dir, 'blocked', '--reason', 'waiting on the child');
  assert.equal(parentBlocked.status, 0, parentBlocked.stderr);

  // Resuming the child restores running on both signals.
  const resumed = mark(dir, 'sub', 'perps-review', '1');
  assert.equal(resumed.status, 0, resumed.stderr);
  child = childSignal(dir, 'perps-review');
  assert.equal(child.status, 'running');
  assert.equal(child.reason, undefined, 'the blocked reason does not survive the resume');
  parent = parentSignal(dir);
  assert.equal(parent.status, 'running');
  assert.equal(parent.reason, undefined);
  assert.equal(parent.step, '2. Review the diff against the review skill');

  // A child has NO flow terminal contract: no learnings.md, no pr-description.md,
  // no artifact-contract run — completing the child still succeeds.
  assert.ok(!existsSync(path.join(dir, 'artifacts', 'learnings.md')));
  const completed = mark(dir, 'sub', 'perps-review', 'complete', '--mark-last');
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(childSignal(dir, 'perps-review').status, 'complete');
  assert.equal(childSignal(dir, 'perps-review').evidence, undefined);
}

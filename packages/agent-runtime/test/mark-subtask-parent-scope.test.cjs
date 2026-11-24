// A parent's terminal gates cover its own child units only (ADR-060: a parent's
// contract governs its own children). Run 961d55d3: a reviewer stopped mid-unit
// left `perps-review` running on REVIEW.<context>.md, and the worker's
// `mark complete` was refused on it.
const {
  makeTask,
  writeFileSync,
  path,
  mark,
  spawnSync,
  contractCheck,
  assert,
} = require('./mark-subtask.test-support.cjs');
const { completingParentSignal } = require('../scripts/subtask-unit.cjs');

const REVIEW = ['# Reviewer', '', '- [ ] **1. Review the diff**', '- [ ] **2. Report**', ''].join(
  '\n',
);

/** A task with the worker's artifacts and a reviewer checklist per id. */
function taskWithReviewers(...reviewers) {
  const dir = makeTask();
  writeFileSync(path.join(dir, 'artifacts', 'learnings.md'), '- Learned.\n');
  writeFileSync(path.join(dir, 'artifacts', 'pr-description.md'), '# PR\n\nBody.\n');
  for (const id of reviewers) writeFileSync(path.join(dir, `REVIEW.${id}.md`), REVIEW);
  return dir;
}

function startUnit(dir, id, step, checklist) {
  const started = mark(
    dir,
    'sub',
    'start',
    id,
    '--step',
    String(step),
    '--from',
    'inline:- [ ] **1. read**\n- [ ] **2. check**\n',
    ...(checklist ? ['--checklist', checklist] : []),
  );
  assert.equal(started.status, 0, started.stderr);
}

function workerComplete(dir) {
  for (const step of ['1', '2']) assert.equal(mark(dir, step).status, 0);
  return mark(dir, 'complete', '--mark-last');
}

// A stopped reviewer's open unit does not refuse the worker's completion.
{
  const dir = taskWithReviewers('rev-1');
  startUnit(dir, 'perps-review', 1, 'REVIEW.rev-1.md');
  const completed = workerComplete(dir);
  assert.equal(completed.status, 0, completed.stderr);
}

// The worker's own open unit still refuses it.
{
  const dir = taskWithReviewers('rev-1');
  startUnit(dir, 'perps-review', 1, 'REVIEW.rev-1.md');
  for (const step of ['1', '2']) assert.equal(mark(dir, step).status, 0);
  startUnit(dir, 'ship-check', 3);
  const refused = mark(dir, 'complete', '--mark-last');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /cannot complete while a subtask is open: ship-check \(running\)/);
  assert.doesNotMatch(refused.stderr, /perps-review/);
}

// Parallel reviewer lanes share the task directory: A's terminal gate ignores B's unit,
// and B's own gate still refuses on it.
{
  const dir = taskWithReviewers('rev-a', 'rev-b');
  startUnit(dir, 'review-a', 1, 'REVIEW.rev-a.md');
  startUnit(dir, 'review-b', 1, 'REVIEW.rev-b.md');
  assert.equal(mark(dir, 'sub', 'review-a', 'complete', '--mark-last').status, 1);
  assert.equal(mark(dir, 'sub', 'review-a', '1').status, 0);
  assert.equal(mark(dir, 'sub', 'review-a', 'complete', '--mark-last').status, 0);
  const contract = (signal, checklist) =>
    spawnSync(
      process.execPath,
      [
        contractCheck,
        dir,
        '--terminal',
        'complete',
        '--proof-checklist',
        checklist,
        '--proof-signal',
        signal,
      ],
      { encoding: 'utf8' },
    );
  const a = contract('REVIEW.rev-a-SIGNAL.json', 'REVIEW.rev-a.md');
  assert.doesNotMatch(a.stderr, /subtask review-b/);
  const b = contract('REVIEW.rev-b-SIGNAL.json', 'REVIEW.rev-b.md');
  assert.match(b.stderr, /subtask review-b is not settled \(status running\)/);
}

// The contract script keys on the signal being completed, not the manifest: while a
// reviewer's role is active the manifest names its checklist, and the worker's
// validation passes only --proof-signal SIGNAL.json.
{
  const dir = taskWithReviewers('rev-1');
  startUnit(dir, 'perps-review', 1, 'REVIEW.rev-1.md');
  writeFileSync(
    path.join(dir, 'checklist-target.json'),
    `${JSON.stringify({ checklist: 'REVIEW.rev-1.md' }, null, 2)}\n`,
  );
  const worker = spawnSync(
    process.execPath,
    [contractCheck, dir, '--terminal', 'complete', '--proof-signal', 'SIGNAL.json'],
    { encoding: 'utf8' },
  );
  assert.doesNotMatch(worker.stderr, /subtask perps-review/);
  // Without a completing signal the gate cannot scope, and every open child counts.
  const unscoped = spawnSync(process.execPath, [contractCheck, dir], { encoding: 'utf8' });
  assert.match(unscoped.stderr, /subtask perps-review is not settled/);
}

// A completion into a signal its checklist would not write keeps the unscoped check.
assert.equal(completingParentSignal('CHECKLIST.md', 'SIGNAL.json'), 'SIGNAL.json');
assert.equal(completingParentSignal('TASK.md', 'SIGNAL.json'), 'SIGNAL.json');
assert.equal(completingParentSignal(undefined, 'SIGNAL.json'), 'SIGNAL.json');
assert.equal(completingParentSignal('REVIEW.rev-1.md', 'custom.json'), undefined);
assert.equal(completingParentSignal('CHECKLIST.md', undefined), undefined);
{
  const dir = taskWithReviewers('rev-1');
  startUnit(dir, 'perps-review', 1, 'REVIEW.rev-1.md');
  for (const step of ['1', '2']) assert.equal(mark(dir, step).status, 0);
  const refused = mark(
    dir,
    '--checklist',
    'CHECKLIST.md',
    '--signal',
    'OTHER.json',
    'complete',
    '--mark-last',
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /cannot complete while a subtask is open: perps-review/);
}

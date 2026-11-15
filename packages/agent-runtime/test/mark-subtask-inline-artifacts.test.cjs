const {
  makeTask,
  assert,
  mark,
  index,
  sha256,
  spawnSync,
  contractCheck,
} = require('./mark-subtask.test-support.cjs');

// ---------------------------------------------------------------------------
// 4. Inline sources, and the artifact contract check on an open child.
{
  const dir = makeTask();
  assert.equal(mark(dir, 'start').status, 0);
  // Steps are claimed in order (ADR-064 Amendment 7), and registering a child on
  // step 3 claims the work reached it, so the rows before it are done first.
  assert.equal(mark(dir, '1').status, 0);
  assert.equal(mark(dir, '2').status, 0);
  const started = mark(
    dir,
    'sub',
    'start',
    'ship-check',
    '--step',
    '3',
    '--from',
    'inline:- [ ] **1. verify the build**\n',
  );
  assert.equal(started.status, 0, started.stderr);
  const unit = index(dir).units[0];
  assert.equal(unit.source.kind, 'inline');
  assert.equal(unit.source.ref, undefined, 'inline sources record a digest, not a ref');
  assert.equal(unit.source.sha256, sha256('- [ ] **1. verify the build**\n'));

  const openCheck = spawnSync(process.execPath, [contractCheck, dir], { encoding: 'utf8' });
  assert.equal(openCheck.status, 1, openCheck.stdout);
  assert.match(openCheck.stderr, /subtask ship-check is not settled \(status running\)/);

  assert.equal(mark(dir, 'sub', 'ship-check', 'complete', '--mark-last').status, 0);
  const settledCheck = spawnSync(process.execPath, [contractCheck, dir], { encoding: 'utf8' });
  assert.equal(settledCheck.status, 0, settledCheck.stderr);
  assert.match(settledCheck.stdout, /TASK_ARTIFACT_CONTRACT_PASS/);
}

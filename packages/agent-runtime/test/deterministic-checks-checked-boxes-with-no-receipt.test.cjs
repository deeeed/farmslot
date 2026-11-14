const {
  test,
  fixture,
  path,
  fs,
  assert,
  deterministicChecks,
} = require('./deterministic-checks.test-support.cjs');

test('checked boxes with no receipt remain blocked; source edits invalidate a pass', (t) => {
  const { root, dir, invoke } = fixture(t);
  const file = path.join(dir, 'CHECKLIST.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('[ ]', '[x]'));
  assert.match(deterministicChecks.issues(dir)[0], /receipt is missing/);
  assert.equal(invoke().status, 0);
  fs.writeFileSync(path.join(root, 'app.js'), 'export const value = 2;\n');
  assert.equal(deterministicChecks.read(dir)[0].status, 'stale');
  assert.equal(invoke().status, 0);
  assert.equal(deterministicChecks.read(dir)[0].status, 'passed');
});

test('on a complete signal, mark reruns the check for the current tree and keeps the box and signal', (t) => {
  const { root, dir, invoke } = fixture(t);
  const signal = path.join(dir, 'SIGNAL.json');
  const completed = JSON.stringify({ status: 'complete', attemptId: 'completed-attempt' });
  fs.writeFileSync(signal, completed);
  const checklist = fs.readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8');
  assert.equal(invoke().status, 0);
  const [first] = deterministicChecks.read(dir);
  fs.writeFileSync(path.join(root, 'app.js'), 'export const value = 2;\n');
  assert.equal(deterministicChecks.read(dir)[0].status, 'stale');
  const result = invoke();
  assert.equal(result.status, 0, result.stderr);
  const [check] = deterministicChecks.read(dir);
  assert.equal(check.status, 'passed');
  assert.notEqual(check.inputHash, first.inputHash);
  assert.equal(fs.readFileSync(signal, 'utf8'), completed);
  assert.equal(fs.readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8'), checklist);
  assert.match(result.stdout, /validated deterministic step 1 for the current tree/);
});

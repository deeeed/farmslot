const {
  test,
  fixture,
  deterministicChecks,
  assert,
  fs,
  path,
} = require('./deterministic-checks.test-support.cjs');

test('mark executes the command, persists exit/log, and only then completes the step', (t) => {
  const { dir, invoke } = fixture(t);
  const before = deterministicChecks.read(dir);
  assert.equal(before[0].status, 'missing');
  const result = invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8'), /\[x\]/);
  const [check] = deterministicChecks.read(dir);
  assert.equal(check.status, 'passed');
  assert.equal(check.exitCode, 0);
  assert.match(fs.readFileSync(path.join(dir, check.logPath), 'utf8'), /local check passed/);
});

test('unchanged checked inputs reuse the passing receipt and log without executing again', (t) => {
  const { dir } = fixture(t, 'printf run >> .task/proof/check-count');
  assert.equal(deterministicChecks.execute(dir, 'CHECKLIST.md', 1), true);
  const receipt = path.join(dir, 'artifacts/deterministic-checks/CHECKLIST.md/1.json');
  const before = fs.readFileSync(receipt, 'utf8');
  const check = JSON.parse(before);
  const log = fs.readFileSync(path.join(dir, check.logPath), 'utf8');
  assert.equal(deterministicChecks.execute(dir, 'CHECKLIST.md', 1), true);
  assert.equal(fs.readFileSync(path.join(dir, 'check-count'), 'utf8'), 'run');
  assert.equal(fs.readFileSync(receipt, 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(dir, check.logPath), 'utf8'), log);
});

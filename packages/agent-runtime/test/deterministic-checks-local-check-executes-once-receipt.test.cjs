const {
  test,
  fixture,
  fs,
  path,
  deterministicChecks,
  resolveWorkerTerminalContract,
  assert,
} = require('./deterministic-checks.test-support.cjs');

test('local_check executes once and its receipt becomes stale after source changes', (t) => {
  const { root, dir } = fixture(t);
  const checklist = '- [ ] CI [DETERMINISTIC: ci.local_check]\n';
  fs.writeFileSync(path.join(dir, 'CHECKLIST.md'), checklist);
  const contract = deterministicChecks.freeze(
    resolveWorkerTerminalContract(null, 'dev'),
    checklist,
    'CHECKLIST.md',
    { 'ci.local_check': 'printf run >> .task/proof/check-count' },
  );
  fs.writeFileSync(
    path.join(dir, 'inputs/worker-terminal-contract.json'),
    JSON.stringify(contract),
  );
  assert.equal(deterministicChecks.execute(dir, 'CHECKLIST.md', 1), true);
  assert.equal(deterministicChecks.execute(dir, 'CHECKLIST.md', 1), true);
  assert.equal(fs.readFileSync(path.join(dir, 'check-count'), 'utf8'), 'run');
  fs.appendFileSync(path.join(root, 'app.js'), '// changed\n');
  assert.equal(deterministicChecks.read(dir)[0].status, 'stale');
});

test('local_check cannot hide another required deterministic check', (t) => {
  const { dir } = fixture(t);
  const input = path.join(dir, 'inputs/worker-terminal-contract.json');
  const contract = JSON.parse(fs.readFileSync(input));
  contract.deterministicChecks.push({
    checklist: 'CHECKLIST.md',
    stepNumber: 2,
    reference: 'ci.local_check',
    command: 'exit 91',
  });
  fs.writeFileSync(input, JSON.stringify(contract));
  const result = deterministicChecks.evaluate(dir, 'CHECKLIST.md');
  assert.equal(result.checks.length, 2);
  assert.deepEqual(
    result.checks.map((check) => check.reference),
    ['checks.unit', 'ci.local_check'],
  );
  assert.ok(result.issues.every((issue) => /receipt is missing/.test(issue)));
});

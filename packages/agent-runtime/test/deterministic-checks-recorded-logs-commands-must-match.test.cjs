const {
  test,
  fixture,
  assert,
  deterministicChecks,
  fs,
  path,
  resolveWorkerTerminalContract,
  spawnSync,
} = require('./deterministic-checks.test-support.cjs');

test('recorded logs and commands must match; deleting the declaration does not remove its gate', (t) => {
  const { dir, invoke } = fixture(t);
  assert.equal(invoke().status, 0);
  const [check] = deterministicChecks.read(dir);
  fs.appendFileSync(path.join(dir, check.logPath), 'changed\n');
  assert.equal(deterministicChecks.read(dir)[0].status, 'failed');
  fs.writeFileSync(path.join(dir, 'CHECKLIST.md'), '## Checklist\n');
  assert.equal(deterministicChecks.read(dir)[0].status, 'failed');
});

test('declaring an unknown or malformed command fails initialization', () => {
  const contract = resolveWorkerTerminalContract(null, 'dev');
  assert.throws(
    () =>
      deterministicChecks.freeze(
        contract,
        '- [ ] CI [DETERMINISTIC: checks.unit]',
        'CHECKLIST.md',
        {},
      ),
    /requires a configured command/,
  );
  assert.throws(
    () => deterministicChecks.freeze(contract, '- [ ] CI [DETERMINISTIC: ]', 'CHECKLIST.md', {}),
    /Invalid deterministic declaration/,
  );
});

test('committing the checked content preserves a pass, including file deletion', (t) => {
  const { root, dir, invoke } = fixture(t);
  const git = (args) => spawnSync('git', args, { cwd: root });
  assert.equal(git(['add', 'app.js']).status, 0);
  assert.equal(
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--no-gpg-sign',
      '-qm',
      'Initial content',
    ]).status,
    0,
  );
  fs.unlinkSync(path.join(root, 'app.js'));
  assert.equal(invoke().status, 0);
  assert.equal(git(['add', '-u']).status, 0);
  assert.equal(
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--no-gpg-sign',
      '-qm',
      'Remove content',
    ]).status,
    0,
  );
  assert.equal(deterministicChecks.read(dir)[0].status, 'passed');
});

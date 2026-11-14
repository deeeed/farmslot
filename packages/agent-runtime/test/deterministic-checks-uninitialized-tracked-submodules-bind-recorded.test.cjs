const {
  test,
  fixture,
  git,
  assert,
  deterministicChecks,
  fs,
  path,
} = require('./deterministic-checks.test-support.cjs');

test('uninitialized tracked submodules bind the recorded commit, including absent directories', (t) => {
  const { root, dir, invoke } = fixture(t);
  const modulePath = 'vendor/sdk with spaces';
  const first = '1'.repeat(40);
  git(root, ['update-index', '--add', '--cacheinfo', `160000,${first},${modulePath}`]);
  assert.equal(invoke().status, 0);
  assert.equal(deterministicChecks.read(dir)[0].status, 'passed');
  fs.mkdirSync(path.join(root, modulePath), { recursive: true });
  assert.equal(deterministicChecks.read(dir)[0].status, 'passed');
  git(root, ['update-index', '--cacheinfo', `160000,${'2'.repeat(40)},${modulePath}`]);
  assert.equal(deterministicChecks.read(dir)[0].status, 'stale');
  assert.equal(invoke().status, 0);
  assert.equal(deterministicChecks.read(dir)[0].status, 'passed');
});

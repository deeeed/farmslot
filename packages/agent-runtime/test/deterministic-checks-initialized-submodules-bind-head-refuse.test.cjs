const {
  test,
  fixture,
  path,
  fs,
  git,
  commit,
  assert,
  deterministicChecks,
} = require('./deterministic-checks.test-support.cjs');

test('initialized submodules bind HEAD and refuse dirty work the parent cannot publish', (t) => {
  const { root, dir, invoke } = fixture(t);
  const modulePath = 'vendor/sdk';
  const moduleRoot = path.join(root, modulePath);
  fs.mkdirSync(moduleRoot, { recursive: true });
  git(moduleRoot, ['init', '-q', '-b', 'main']);
  const file = path.join(moduleRoot, 'sdk.js');
  fs.writeFileSync(file, 'export const value = 1;\n');
  const first = commit(moduleRoot, 'Initial SDK');
  git(root, ['update-index', '--add', '--cacheinfo', `160000,${first},${modulePath}`]);
  assert.equal(invoke().status, 0);
  assert.equal(deterministicChecks.read(dir)[0].status, 'passed');
  fs.writeFileSync(file, 'export const value = 2;\n');
  assert.throws(() => deterministicChecks.read(dir), /Submodule vendor\/sdk has uncommitted work/);
  const refused = invoke();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /commit its changes, then rerun CI parity/);
  const second = commit(moduleRoot, 'Update SDK');
  assert.equal(deterministicChecks.read(dir)[0].status, 'stale');
  assert.equal(invoke().status, 0);
  // Staging the checked gitlink does not invalidate its receipt.
  git(root, ['update-index', '--cacheinfo', `160000,${second},${modulePath}`]);
  assert.equal(deterministicChecks.read(dir)[0].status, 'passed');
});

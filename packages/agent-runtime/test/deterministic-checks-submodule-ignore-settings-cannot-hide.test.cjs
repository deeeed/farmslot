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

test('submodule ignore settings cannot hide unpublished nested source', (t) => {
  const { root, dir, invoke } = fixture(t);
  const moduleRoot = path.join(root, 'vendor/sdk');
  const nestedRoot = path.join(moduleRoot, 'deps/nested');
  fs.mkdirSync(nestedRoot, { recursive: true });
  git(nestedRoot, ['init', '-q', '-b', 'main']);
  const file = path.join(nestedRoot, 'dependency.js');
  fs.writeFileSync(file, 'export const value = 1;\n');
  commit(nestedRoot, 'Initial dependency');
  git(moduleRoot, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(
    path.join(moduleRoot, '.gitmodules'),
    '[submodule "nested"]\n\tpath = deps/nested\n\turl = https://example.invalid/nested.git\n\tignore = all\n',
  );
  const head = commit(moduleRoot, 'Initial SDK');
  git(root, ['update-index', '--add', '--cacheinfo', `160000,${head},vendor/sdk`]);
  assert.equal(invoke().status, 0);
  fs.writeFileSync(file, 'export const value = 2;\n');
  assert.equal(git(moduleRoot, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  assert.throws(() => deterministicChecks.read(dir), /Submodule vendor\/sdk has uncommitted work/);
});

test('a command failure records the exit code and leaves its checkbox incomplete', (t) => {
  const { dir, invoke } = fixture(t, 'printf "quality failure\\n"; exit 7');
  const result = invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exit 7/);
  assert.match(fs.readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8'), /\[ \]/);
  assert.equal(deterministicChecks.read(dir)[0].exitCode, 7);
  assert.equal(deterministicChecks.read(dir)[0].status, 'failed');
});

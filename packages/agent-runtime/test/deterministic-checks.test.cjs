const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  deterministicChecks,
  resolveWorkerTerminalContract,
} = require('../scripts/worker-terminal-contract.cjs');

const mark = path.resolve(__dirname, '../scripts/mark-checklist-step.cjs');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(cwd, message) {
  git(cwd, ['add', '.']);
  git(cwd, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--no-gpg-sign',
    '-qm',
    message,
  ]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function fixture(t, command = 'printf "local check passed\\n"') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deterministic-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root }).status, 0);
  fs.writeFileSync(path.join(root, 'app.js'), 'export const value = 1;\n');
  const dir = path.join(root, '.task', 'proof');
  fs.mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  const checklist = '## Checklist\n- [ ] CI parity [DETERMINISTIC: ci.local_check]\n';
  fs.writeFileSync(path.join(dir, 'CHECKLIST.md'), checklist);
  const contract = deterministicChecks.freeze(
    resolveWorkerTerminalContract(null, 'dev'),
    checklist,
    'CHECKLIST.md',
    { 'ci.local_check': command },
  );
  fs.writeFileSync(
    path.join(dir, 'inputs', 'worker-terminal-contract.json'),
    JSON.stringify(contract),
  );
  const invoke = () =>
    spawnSync(process.execPath, [mark, dir, '1'], { cwd: root, encoding: 'utf8' });
  return { root, dir, invoke };
}

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
        '- [ ] CI [DETERMINISTIC: ci.local_check]',
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

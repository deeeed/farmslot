const assert = require('node:assert/strict');

const fs = require('node:fs');

const os = require('node:os');

const path = require('node:path');

const { spawnSync } = require('node:child_process');

const test = require('node:test');

const { initGitFixture } = require('./git-fixtures.cjs');

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
  initGitFixture(root);
  assert.equal(fs.readFileSync(path.join(root, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(root, 'app.js'), 'export const value = 1;\n');
  const dir = path.join(root, '.task', 'proof');
  fs.mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  const checklist = '## Checklist\n- [ ] CI parity [DETERMINISTIC: checks.unit]\n';
  fs.writeFileSync(path.join(dir, 'CHECKLIST.md'), checklist);
  const contract = deterministicChecks.freeze(
    resolveWorkerTerminalContract(null, 'dev'),
    checklist,
    'CHECKLIST.md',
    { 'checks.unit': command },
  );
  fs.writeFileSync(
    path.join(dir, 'inputs', 'worker-terminal-contract.json'),
    JSON.stringify(contract),
  );
  const invoke = () =>
    spawnSync(process.execPath, [mark, dir, '1'], { cwd: root, encoding: 'utf8' });
  return { root, dir, invoke };
}

function registerLocalCheckReceipt(variant) {
  const frozen = variant;
  test(`local_check requires a passing receipt${frozen ? ' in a retained contract' : ''}`, (t) => {
    const { dir } = fixture(t);
    const checklist = '- [x] CI [DETERMINISTIC: ci.local_check]\n';
    fs.writeFileSync(path.join(dir, 'CHECKLIST.md'), checklist);
    const contract = deterministicChecks.freeze(
      resolveWorkerTerminalContract(null, 'dev'),
      checklist,
      'CHECKLIST.md',
      { 'ci.local_check': 'exit 91' },
    );
    if (!frozen) delete contract.deterministicChecks;
    fs.writeFileSync(
      path.join(dir, 'inputs/worker-terminal-contract.json'),
      JSON.stringify(contract),
    );
    assert.equal(
      deterministicChecks.declarations(checklist, 'CHECKLIST.md')[0].reference,
      'ci.local_check',
    );
    assert.throws(
      () => deterministicChecks.freeze({}, checklist, 'CHECKLIST.md', {}),
      /requires a configured command/,
    );
    assert.equal(deterministicChecks.evaluate(dir, 'CHECKLIST.md').checks.length, 1);
    assert.match(
      deterministicChecks.issues(dir)[0],
      frozen ? /receipt is missing/ : /missing from the frozen task contract/,
    );
    assert.throws(
      () => deterministicChecks.execute(dir, 'CHECKLIST.md', 1),
      frozen ? /exit 91/ : /frozen command/,
    );
  });
}

module.exports = {
  assert,
  fs,
  os,
  path,
  spawnSync,
  test,
  initGitFixture,
  deterministicChecks,
  resolveWorkerTerminalContract,
  mark,
  git,
  commit,
  fixture,
  registerLocalCheckReceipt,
};

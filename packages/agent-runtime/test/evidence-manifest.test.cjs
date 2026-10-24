const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { validateEvidenceManifest } = require('../scripts/evidence-manifest.cjs');
const { resolveWorkerTerminalContract } = require('../scripts/worker-terminal-contract.cjs');

const cli = path.resolve(__dirname, '../bin/farmslot-agent.mjs');
const checker = path.resolve(__dirname, '../scripts/check-task-artifact-contract.mjs');
const invalid = { preferred_mode: 'state', videos: [] };
const expected = [
  'manifest.preferred_mode: expected "screenshots" or "video"',
  'manifest.videos: expected object',
];

function fixture(t, manifest = invalid, flow = 'dev') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-fast-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'artifacts'));
  fs.mkdirSync(path.join(dir, 'inputs'));
  fs.writeFileSync(path.join(dir, 'CHECKLIST.md'), `# Worker: ${flow}\n\n- [ ] Record evidence\n`);
  fs.writeFileSync(
    path.join(dir, 'inputs/worker-terminal-contract.json'),
    JSON.stringify(resolveWorkerTerminalContract(null, flow)),
  );
  if (manifest !== null)
    fs.writeFileSync(path.join(dir, 'artifacts/evidence-manifest.json'), JSON.stringify(manifest));
  const run = (...args) =>
    spawnSync(process.execPath, [cli, 'mark', dir, ...args], { encoding: 'utf8' });
  return { dir, run };
}

function assertIssues(result) {
  assert.notEqual(result.status, 0);
  for (const issue of expected) assert.ok(result.stderr.includes(issue), result.stderr);
  assert.doesNotMatch(result.stderr, /TypeError/);
}

function snapshot(dir) {
  return ['CHECKLIST.md', 'SIGNAL.json'].map((file) => {
    const target = path.join(dir, file);
    return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  });
}

test('TAT-4259 manifest returns both authoritative field issues', () => {
  assert.deepEqual(validateEvidenceManifest(invalid), expected);
  assert.deepEqual(
    validateEvidenceManifest({ preferred_mode: 'video', videos: { after: 'after.mp4' } }),
    [],
  );
  assert.deepEqual(validateEvidenceManifest({ before_state_capture: [] }), [
    'manifest.before_state_capture: expected object',
  ]);
});

test('worker CLI refuses progress and complete before changing checklist or signal', (t) => {
  const { dir, run } = fixture(t);
  assert.equal(run('start').status, 0);
  const before = snapshot(dir);
  for (const args of [['1'], ['complete', '--mark-last']]) {
    assertIssues(run(...args));
    assert.deepEqual(snapshot(dir), before);
  }
});

test('valid or absent manifests allow early progress, malformed JSON names the file', (t) => {
  for (const manifest of [null, { preferred_mode: 'screenshots', standalone: [] }]) {
    const { run } = fixture(t, manifest);
    const result = run('1');
    assert.equal(result.status, 0, result.stderr);
  }
  const { dir, run } = fixture(t);
  fs.writeFileSync(path.join(dir, 'artifacts/evidence-manifest.json'), '{');
  const before = snapshot(dir);
  const result = run('1');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifacts\/evidence-manifest.json: invalid JSON:/);
  assert.deepEqual(snapshot(dir), before);
});

test('invalid worker evidence does not prevent reviewer marks', (t) => {
  const { run } = fixture(t, invalid, 'review');
  const result = run('1');
  assert.equal(result.status, 0, result.stderr);
});

for (const control of ['wait', 'resume', 'blocked']) {
  test(`invalid evidence does not prevent operator ${control}`, (t) => {
    const { run } = fixture(t);
    const commands =
      control === 'blocked'
        ? [['blocked', '--reason', 'Manifest needs repair']]
        : [['start'], ['wait', '--who', 'operator', '--reason', 'Repairing manifest']];
    if (control === 'resume') commands.push(['resume']);
    for (const args of commands) {
      const result = run(...args);
      assert.equal(result.status, 0, result.stderr);
    }
  });
}

test('selected recipe manifest is validated as well as root declarations', (t) => {
  const { dir, run } = fixture(t, { version: 1 });
  fs.mkdirSync(path.join(dir, 'artifacts/recipe-runs/current'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'artifacts/latest-valid-recipe-run.json'),
    JSON.stringify({ version: 1, relativeArtifactRoot: 'recipe-runs/current' }),
  );
  fs.writeFileSync(
    path.join(dir, 'artifacts/recipe-runs/current/evidence-manifest.json'),
    JSON.stringify(invalid),
  );
  const before = snapshot(dir);
  const result = run('1');
  assertIssues(result);
  assert.match(result.stderr, /recipe-runs\/current\/evidence-manifest.json/);
  assert.deepEqual(snapshot(dir), before);
});

test('artifact checker reports the same manifest issues without crashing on malformed containers', (t) => {
  const { dir } = fixture(t);
  assertIssues(spawnSync(process.execPath, [checker, dir], { encoding: 'utf8' }));
  fs.writeFileSync(
    path.join(dir, 'artifacts/evidence-manifest.json'),
    JSON.stringify({ before_after_pairs: {}, standalone: {} }),
  );
  const result = spawnSync(process.execPath, [checker, dir], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest.before_after_pairs: expected array/);
  assert.match(result.stderr, /manifest.standalone: expected array/);
  assert.doesNotMatch(result.stderr, /TypeError/);
});

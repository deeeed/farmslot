const assert = require('node:assert/strict');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { CHECKLIST_TARGET_MANIFEST } = require('../scripts/checklist-target.cjs');
const { resolveWorkerTerminalContract } = require('../scripts/worker-terminal-contract.cjs');

const helper = path.join(__dirname, '..', 'scripts', 'mark-checklist-step.cjs');
// An unreadable evidence manifest is refused before any terminal-contract check.
const early = ['evidence-manifest.json'];
const hint = /This autonomous run has no operator.*mark blocked --reason/s;

function refusedCompletion(
  t,
  mode,
  checklist = '# Worker: dev\n\n- [x] Implement\n',
  artifacts = [],
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-autonomous-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    path.join(dir, CHECKLIST_TARGET_MANIFEST),
    `${JSON.stringify({ checklist: 'CHECKLIST.md' })}\n`,
  );
  writeFileSync(path.join(dir, 'CHECKLIST.md'), checklist);
  mkdirSync(path.join(dir, 'inputs'));
  mkdirSync(path.join(dir, 'artifacts'));
  for (const name of artifacts) writeFileSync(path.join(dir, 'artifacts', name), 'fixture\n');
  // Unless supplied, the required report is missing, so the terminal contract refuses completion.
  writeFileSync(
    path.join(dir, 'inputs/worker-terminal-contract.json'),
    JSON.stringify({ ...resolveWorkerTerminalContract(null, 'dev'), mode }),
  );
  const result = spawnSync(process.execPath, [helper, dir, 'complete', '--mark-last'], {
    encoding: 'utf8',
  });
  return { dir, result };
}

test('a refused completion in an autonomous run tells the worker to end it as blocked', (t) => {
  const { dir, result } = refusedCompletion(t, 'autonomous');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, hint);
  assert.ok(result.stderr.includes(path.join(dir, 'mark')));
  const signal = path.join(dir, 'SIGNAL.json');
  assert.ok(!existsSync(signal) || JSON.parse(readFileSync(signal, 'utf8')).status !== 'complete');
});

test('a refused completion with an operator prints no blocked hint', (t) => {
  const { result } = refusedCompletion(t, 'interactive');
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, hint);
});

test('a completion refused early, at its evidence manifest, still gets the blocked hint', (t) => {
  const { result } = refusedCompletion(t, 'autonomous', undefined, early);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid evidence manifest/);
  assert.match(result.stderr, hint);
});

test('an interactive completion refused early prints no blocked hint', (t) => {
  const { result } = refusedCompletion(t, 'interactive', undefined, early);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, hint);
});

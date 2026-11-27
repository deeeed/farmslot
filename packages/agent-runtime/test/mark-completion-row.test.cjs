const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { CHECKLIST_TARGET_MANIFEST } = require('../scripts/checklist-target.cjs');

const helper = path.join(__dirname, '..', 'scripts', 'mark-checklist-step.cjs');

/**
 * A review-fix round. `finalRow(mark)` writes its last row from the task's mark
 * path; by default the row tells the worker to run `mark complete --mark-last`.
 */
function fixRound(
  t,
  {
    finalRow = (mark) => ['- [ ] 2. Complete the task', `  \`${mark} complete --mark-last\`.`],
    report = true,
  } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-completion-row-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    path.join(dir, CHECKLIST_TARGET_MANIFEST),
    `${JSON.stringify({ checklist: 'REVIEW-FIX.md', signal: 'REVIEW-FIX-SIGNAL.json' })}\n`,
  );
  writeFileSync(
    path.join(dir, 'REVIEW-FIX.md'),
    [
      '# Review fix',
      '',
      '- [ ] 1. Fix each reported issue',
      '  Fix the issues.',
      ...finalRow(path.join(dir, 'mark')),
      '',
    ].join('\n'),
  );
  mkdirSync(path.join(dir, 'artifacts'));
  writeFileSync(path.join(dir, 'artifacts', 'learnings.md'), '- Nothing relevant.\n');
  if (report) writeFileSync(path.join(dir, 'artifacts', 'report.md'), '# Report\n\nFixed.\n');
  return dir;
}

function mark(dir, ...args) {
  return spawnSync(process.execPath, [helper, dir, ...args], { encoding: 'utf8' });
}

function signal(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'REVIEW-FIX-SIGNAL.json'), 'utf8'));
}

function checklist(dir) {
  return readFileSync(path.join(dir, 'REVIEW-FIX.md'), 'utf8');
}

test('marking the completion row completes the signal, as complete --mark-last does', (t) => {
  const dir = fixRound(t);
  let result = mark(dir, '1');
  assert.equal(result.status, 0, result.stderr);
  result = mark(dir, '2');
  assert.equal(result.status, 0, result.stderr);
  assert.match(checklist(dir), /- \[x\] 2\. Complete the task/);
  const after = signal(dir);
  assert.equal(after.status, 'complete');
  assert.equal(after.outcome, 'success');
  assert.equal(after.step, '2. Complete the task');
});

test('re-marking a ticked completion row on a running signal completes it', (t) => {
  // Run ee26591f fix round 2: every box ticked, the signal still running.
  const dir = fixRound(t);
  writeFileSync(path.join(dir, 'REVIEW-FIX.md'), checklist(dir).replaceAll('- [ ]', '- [x]'));
  writeFileSync(
    path.join(dir, 'REVIEW-FIX-SIGNAL.json'),
    `${JSON.stringify({ step: '2. Complete the task', status: 'running' })}\n`,
  );
  const result = mark(dir, '2');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(signal(dir).status, 'complete');
});

test('a refused completion keeps the signal running until the row is marked again', (t) => {
  const dir = fixRound(t, { report: false });
  assert.equal(mark(dir, '1').status, 0);
  let result = mark(dir, '2');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing required worker report/);
  assert.equal(signal(dir).status, 'running');

  writeFileSync(path.join(dir, 'artifacts', 'report.md'), '# Report\n\nFixed.\n');
  result = mark(dir, '2');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(signal(dir).status, 'complete');
});

// The shipped templates' other completion rows: the command on the row's own
// line (worker/fix-bug.md), and the role form with --checklist/--signal after a
// blank line in a fence (worker/review-fix.md, worker/ci-fix.md).
for (const [form, finalRow] of [
  [
    'on the row line',
    (mark) => [
      `- [ ] **2. Write completion signal** — run: \`${mark} complete --mark-last\` (validates the report)`,
      '      **Do NOT `/exit`.** Stay alive and idle.',
    ],
  ],
  [
    'with --checklist and --signal',
    (mark) => [
      '- [ ] **2. Write REVIEW-FIX-SIGNAL.json:**',
      '',
      '  ```bash',
      `  ${mark} --checklist REVIEW-FIX.md --signal REVIEW-FIX-SIGNAL.json complete --mark-last`,
      '  ```',
    ],
  ],
]) {
  test(`marking a completion row that gives the command ${form} completes the signal`, (t) => {
    const dir = fixRound(t, { finalRow });
    assert.equal(mark(dir, '1').status, 0);
    const result = mark(dir, '2');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(signal(dir).status, 'complete');
  });
}

for (const [kind, finalRow] of [
  ['no completion command', () => ['- [ ] 2. Push the branch']],
  [
    'only prose about completing',
    () => ['- [ ] 2. Push the branch', '  Do not mark complete while merge conflicts remain.'],
  ],
]) {
  test(`a final row with ${kind} is only ticked`, (t) => {
    const dir = fixRound(t, { finalRow });
    assert.equal(mark(dir, '1').status, 0);
    const result = mark(dir, '2');
    assert.equal(result.status, 0, result.stderr);
    assert.match(checklist(dir), /- \[x\] 2\. Push the branch/);
    assert.equal(signal(dir).status, 'running');
  });
}

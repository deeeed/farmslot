#!/usr/bin/env node
// `mark sub` — child checklist units (ADR-060). Every refusal listed under
// "Child checklist units" in docs/reference/agent-runtime.md is asserted here,
// plus the parent signal effects: a child owns its parent step until it is
// settled, its completion ticks the parent box with a normal parent timing
// event, and a blocked child blocks the parent signal with the child reason.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const engine = path.join(root, 'scripts', 'mark-checklist-step.cjs');
const contractCheck = path.join(root, 'scripts', 'check-task-artifact-contract.mjs');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const PARENT_CHECKLIST = [
  '# Worker: dev — DEMO-1',
  '',
  '## Checklist',
  '',
  '- [ ] **1. Prepare the branch**',
  '- [ ] **2. Self-review the diff against the review skill** — follow the child unit',
  '- [ ] **3. Ship it**',
  '',
].join('\n');

const SKILL_SOURCE = [
  '---',
  'name: review-skill',
  'description: A checklist-shaped skill.',
  '---',
  '# Review skill',
  '',
  '## Rules',
  '',
  '- [ ] informational box in a skipped section',
  '',
  '## Review',
  '',
  '- [ ] **1. Read the diff under {{TASK_DIR}}**',
  '- [ ] **2. Check the {{FLOW}} patterns**',
  '',
].join('\n');

function makeTask({ checklist = PARENT_CHECKLIST } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-sub-'));
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  writeFileSync(path.join(dir, 'CHECKLIST.md'), checklist);
  writeFileSync(
    path.join(dir, 'inputs', 'handoff.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        attemptId: 'handoff-attempt',
        surface: 'test',
        project: 'demo',
        domain: '',
        flow: 'dev',
        task: { title: 'Demo', sourceKind: 'text', ticket: 'DEMO-1' },
        taskDocument: 'TASK.md',
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(path.join(dir, 'skill.md'), SKILL_SOURCE);
  return dir;
}

function mark(dir, ...args) {
  return spawnSync(process.execPath, [engine, dir, ...args], { encoding: 'utf8' });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function parentSignal(dir) {
  return readJson(path.join(dir, 'SIGNAL.json'));
}

/**
 * ADR-060: a child signal never carries `failed`. Work that cannot finish is
 * `blocked` with a reason, so the operator uses the existing blocked-run
 * actions. Enforced on every read below, which is how every child signal write
 * in this file is observed — a new verb cannot skip the guard.
 */
function assertChildStatusAllowed(signal) {
  assert.ok(
    ['running', 'blocked', 'complete', 'done'].includes(signal.status),
    `a child signal status must be running|blocked|complete|done, never failed (got ${signal.status})`,
  );
}

function childSignal(dir, id) {
  const signal = readJson(path.join(dir, 'subtasks', `${id}-SIGNAL.json`));
  assertChildStatusAllowed(signal);
  return signal;
}

function index(dir) {
  return readJson(path.join(dir, 'subtasks', 'index.json'));
}

// ---------------------------------------------------------------------------
// 1. Registration: materialization, digests, index, child signal.
{
  const dir = makeTask();
  assert.equal(mark(dir, 'start').status, 0);
  assert.equal(mark(dir, '1').status, 0);
  const attemptId = parentSignal(dir).attemptId;
  assert.ok(attemptId, 'mark start generates the attempt id the child inherits');

  const started = mark(dir, 'sub', 'start', 'perps-review', '--step', '2', '--from', 'skill.md');
  assert.equal(started.status, 0, started.stderr);

  const childMarkdown = readFileSync(path.join(dir, 'subtasks', 'perps-review.md'), 'utf8');
  assert.ok(!childMarkdown.startsWith('---'), 'frontmatter is stripped from the child checklist');
  assert.match(
    childMarkdown,
    new RegExp(`Read the diff under ${dir.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&')}`),
  );
  assert.match(childMarkdown, /Check the dev patterns/);

  const registry = index(dir);
  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.units.length, 1);
  const unit = registry.units[0];
  assert.deepEqual(unit.parent, { checklist: 'CHECKLIST.md', stepNumber: 2 });
  assert.equal(unit.checklist, 'subtasks/perps-review.md');
  assert.equal(unit.signal, 'subtasks/perps-review-SIGNAL.json');
  assert.equal(unit.source.kind, 'skill');
  assert.equal(unit.source.ref, 'skill.md');
  // Source digest is the file BEFORE rendering; rendered digest is what was written.
  assert.equal(unit.source.sha256, sha256(SKILL_SOURCE));
  assert.equal(unit.source.renderedSha256, sha256(childMarkdown));
  assert.ok(unit.registeredAt);

  const signal = childSignal(dir, 'perps-review');
  assert.equal(signal.role, 'subtask');
  assert.equal(signal.contextId, 'perps-review');
  assert.equal(signal.attemptId, attemptId, 'the child shares the parent attempt');
  assert.deepEqual(signal.parent, { checklist: 'CHECKLIST.md', stepNumber: 2 });
  assert.equal(signal.status, 'running');
  assert.equal(signal.checklistTiming.source, 'subtasks/perps-review.md');
  assert.deepEqual(signal.checklistTiming.events, []);

  // The skipped "Rules" section is not a step: two steps, not three.
  const status = mark(dir, 'sub', 'perps-review', 'status');
  assert.equal(status.status, 0, status.stderr);
  const projection = JSON.parse(status.stdout);
  assert.equal(projection.totalSteps, 2);
  assert.equal(projection.completedSteps, 0);
  assert.equal(projection.settled, false);
  assert.equal(projection.status, 'running');
  assert.deepEqual(projection.parent, { checklist: 'CHECKLIST.md', stepNumber: 2 });
  assert.equal(projection.currentStep, '1. Read the diff under ' + dir);
  assert.equal(projection.lastEventAt, null);

  // Refusal: one child per step for the life of the task dir.
  let refused = mark(dir, 'sub', 'start', 'second', '--step', '2', '--from', 'skill.md');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /step 2 already owned by subtask perps-review/);
  // Refusal: one id per task dir.
  refused = mark(dir, 'sub', 'start', 'perps-review', '--step', '3', '--from', 'skill.md');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /subtask perps-review already exists/);

  // Refusal: the parent cannot mark a step its child owns.
  refused = mark(dir, '2');
  assert.equal(refused.status, 1);
  assert.match(
    refused.stderr,
    /step 2 is owned by subtask perps-review; finish it with \.\/mark sub perps-review complete/,
  );
  assert.match(readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8'), /- \[ \] \*\*2\./);

  // Refusal: a parent terminal command while a child is open.
  writeFileSync(path.join(dir, 'artifacts', 'learnings.md'), '- Learned.\n');
  writeFileSync(path.join(dir, 'artifacts', 'pr-description.md'), '# PR\n\nBody.\n');
  refused = mark(dir, 'complete', '--mark-last');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /cannot complete while a subtask is open: perps-review \(running\)/);
  refused = mark(dir, 'no-change', '--reason', 'nothing', '--mark-last');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /cannot no-change while a subtask is open/);

  // Child steps: box ticked, event appended, status stays running.
  const stepped = mark(dir, 'sub', 'perps-review', '1');
  assert.equal(stepped.status, 0, stepped.stderr);
  assert.match(
    readFileSync(path.join(dir, 'subtasks', 'perps-review.md'), 'utf8'),
    /- \[x\] \*\*1\. Read the diff/,
  );
  let child = childSignal(dir, 'perps-review');
  assert.equal(child.status, 'running');
  assert.equal(child.checklistTiming.events.length, 1);
  assert.equal(child.checklistTiming.events[0].stepNumber, 1);
  assert.equal(child.checklistTiming.events[0].label, `1. Read the diff under ${dir}`);

  // A missing child step is a refusal, not a silent no-op.
  refused = mark(dir, 'sub', 'perps-review', '9');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /subtask perps-review has no step 9/);

  // Refusal: complete without --mark-last while a child box is open.
  refused = mark(dir, 'sub', 'perps-review', 'complete');
  assert.equal(refused.status, 1);
  assert.match(
    refused.stderr,
    /subtask perps-review checklist incomplete — 1 step\(s\) still \[ \]/,
  );
  assert.equal(childSignal(dir, 'perps-review').status, 'running');

  // Refusal: --report must exist and be non-empty.
  refused = mark(
    dir,
    'sub',
    'perps-review',
    'complete',
    '--mark-last',
    '--report',
    'artifacts/review.md',
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /missing required artifact: artifacts\/review\.md/);
  writeFileSync(path.join(dir, 'artifacts', 'review.md'), '   \n');
  refused = mark(
    dir,
    'sub',
    'perps-review',
    'complete',
    '--mark-last',
    '--report',
    'artifacts/review.md',
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /artifacts\/review\.md exists but is empty/);
  writeFileSync(path.join(dir, 'artifacts', 'review.md'), '# Review\n\nOne finding.\n');

  // Child complete: child terminal signal, parent box ticked, parent timing event.
  const completed = mark(
    dir,
    'sub',
    'perps-review',
    'complete',
    '--mark-last',
    '--report',
    'artifacts/review.md',
  );
  assert.equal(completed.status, 0, completed.stderr);
  child = childSignal(dir, 'perps-review');
  assert.equal(child.status, 'complete');
  assert.equal(child.outcome, 'success');
  assert.equal(child.disposition, 'fixed');
  assert.equal(child.evidence.reportPath, 'artifacts/review.md');
  assert.equal(child.checklistTiming.events.length, 2);
  assert.match(
    readFileSync(path.join(dir, 'subtasks', 'perps-review.md'), 'utf8'),
    /- \[x\] \*\*2\. Check the dev patterns/,
  );

  const parentChecklist = readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8');
  assert.match(parentChecklist, /- \[x\] \*\*2\. Self-review/);
  assert.match(parentChecklist, /- \[ \] \*\*3\. Ship it/);
  const parent = parentSignal(dir);
  assert.equal(parent.status, 'running');
  // The parent event is exactly what a normal parent mark writes: the step
  // NAME (bold lead, instruction tail dropped), so deriveChecklistStepDurations
  // needs no change.
  const parentEvent = parent.checklistTiming.events.find((event) => event.stepNumber === 2);
  assert.ok(parentEvent, 'child completion appends the parent timing event');
  assert.equal(parentEvent.label, '2. Self-review the diff against the review skill');
  assert.equal(parent.step, '2. Self-review the diff against the review skill');

  // A later parent mark of that step is a true no-op: exit 0 and the signal file
  // is byte-identical, timestamp included. Re-marking a finished step is not
  // progress, so it must not look like a fresh write to anything watching.
  const signalBeforeReMark = readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8');
  const reMark = mark(dir, '2');
  assert.equal(reMark.status, 0, reMark.stderr);
  assert.equal(
    readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8'),
    signalBeforeReMark,
    're-marking an already-recorded step must not rewrite SIGNAL.json',
  );
  assert.equal(
    parentSignal(dir).checklistTiming.events.filter((event) => event.stepNumber === 2).length,
    1,
  );

  // A settled child still owns its step: no replacement child, ever.
  refused = mark(dir, 'sub', 'start', 'replacement', '--step', '2', '--from', 'skill.md');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /step 2 already owned by subtask perps-review/);

  // With every child settled the parent terminal path runs as usual.
  const parentComplete = mark(dir, 'complete', '--mark-last');
  assert.equal(parentComplete.status, 0, parentComplete.stderr);
  assert.equal(parentSignal(dir).status, 'complete');
}

// ---------------------------------------------------------------------------
// 2. blocked → resume, and the child's freedom from the flow terminal contract.
{
  const dir = makeTask();
  assert.equal(mark(dir, 'start').status, 0);
  assert.equal(
    mark(dir, 'sub', 'start', 'perps-review', '--step', '2', '--from', 'skill.md').status,
    0,
  );

  let refused = mark(dir, 'sub', 'perps-review', 'blocked');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /sub blocked requires --reason/);

  const blocked = mark(dir, 'sub', 'perps-review', 'blocked', '--reason', 'skill needs the diff');
  assert.equal(blocked.status, 0, blocked.stderr);
  let child = childSignal(dir, 'perps-review');
  assert.equal(child.status, 'blocked');
  assert.equal(child.outcome, 'partial');
  assert.equal(child.disposition, 'blocked');
  assert.equal(child.reason, 'skill needs the diff');
  assertChildStatusAllowed(child);
  let parent = parentSignal(dir);
  assert.equal(parent.status, 'blocked');
  assert.equal(parent.outcome, 'partial');
  assert.equal(parent.disposition, 'blocked');
  assert.equal(parent.reason, 'subtask perps-review: skill needs the diff');
  assert.equal(parent.step, '2. Self-review the diff against the review skill');

  // A blocked child keeps ownership: it is terminal for the run, not settled.
  refused = mark(dir, '2');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /step 2 is owned by subtask perps-review/);
  // The parent may still report blocked itself.
  const parentBlocked = mark(dir, 'blocked', '--reason', 'waiting on the child');
  assert.equal(parentBlocked.status, 0, parentBlocked.stderr);

  // Resuming the child restores running on both signals.
  const resumed = mark(dir, 'sub', 'perps-review', '1');
  assert.equal(resumed.status, 0, resumed.stderr);
  child = childSignal(dir, 'perps-review');
  assert.equal(child.status, 'running');
  assert.equal(child.reason, undefined, 'the blocked reason does not survive the resume');
  parent = parentSignal(dir);
  assert.equal(parent.status, 'running');
  assert.equal(parent.reason, undefined);
  assert.equal(parent.step, '2. Self-review the diff against the review skill');

  // A child has NO flow terminal contract: no learnings.md, no pr-description.md,
  // no artifact-contract run — completing the child still succeeds.
  assert.ok(!existsSync(path.join(dir, 'artifacts', 'learnings.md')));
  const completed = mark(dir, 'sub', 'perps-review', 'complete', '--mark-last');
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(childSignal(dir, 'perps-review').status, 'complete');
  assert.equal(childSignal(dir, 'perps-review').evidence, undefined);
}

// ---------------------------------------------------------------------------
// 3. Registration refusals that never write a unit.
{
  const dir = makeTask({
    checklist: ['# Worker: dev', '', '- [x] **1. Already done**', '- [ ] **2. Open**', ''].join(
      '\n',
    ),
  });
  const cases = [
    {
      args: ['sub', 'start', 'on-checked', '--step', '1', '--from', 'skill.md'],
      code: 1,
      match: /step 1 is already checked/,
    },
    {
      args: ['sub', 'start', 'no-steps', '--step', '2', '--from', 'inline:# nothing here'],
      code: 1,
      match: /a child unit must have at least one step/,
    },
    {
      args: [
        'sub',
        'start',
        'skewed',
        '--step',
        '2',
        '--from',
        'inline:- [ ] **1. one**\n- [ ] **1a. inserted**\n',
      ],
      code: 1,
      match: /position 2 is labeled "1a"/,
    },
    {
      args: ['sub', 'start', 'Bad_Id', '--step', '2', '--from', 'inline:- [ ] one'],
      code: 1,
      match: /invalid subtask id 'Bad_Id'/,
    },
    {
      args: ['sub', 'start', 'catalog', '--step', '2', '--from', 'template:dev/autonomous'],
      code: 1,
      match: /--from template:dev\/autonomous is not supported by mark/,
    },
    {
      args: ['sub', 'start', 'missing-source', '--step', '2', '--from', 'no/such/file.md'],
      code: 1,
      match: /--from source not found/,
    },
    {
      args: ['sub', 'start', 'no-step-flag', '--from', 'skill.md'],
      code: 2,
      match: /sub start requires --step N/,
    },
    {
      args: ['sub', 'start', 'no-source', '--step', '2'],
      code: 2,
      match: /sub start requires --from/,
    },
    {
      args: ['sub', 'start', 'out-of-range', '--step', '9', '--from', 'skill.md'],
      code: 1,
      match: /checklist step 9 not found in CHECKLIST\.md/,
    },
    {
      args: ['sub', 'unknown-id', 'status'],
      code: 1,
      match: /unknown subtask unknown-id/,
    },
  ];
  for (const { args, code, match } of cases) {
    const result = mark(dir, ...args);
    assert.equal(result.status, code, `${args.join(' ')} → ${result.stderr}${result.stdout}`);
    assert.match(result.stderr, match);
  }
  assert.ok(
    !existsSync(path.join(dir, 'subtasks')),
    'a refused registration writes nothing under subtasks/',
  );

  // An unknown placeholder is a refusal, never a rendered {{TOKEN}}.
  writeFileSync(path.join(dir, 'bad.md'), '- [ ] Read {{NOPE}}\n');
  const refused = mark(dir, 'sub', 'start', 'bad-vars', '--step', '2', '--from', 'bad.md');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /placeholder\(s\) with no expansion value: \{\{NOPE\}\}/);
  // …and --var supplies it.
  const ok = mark(
    dir,
    'sub',
    'start',
    'bad-vars',
    '--step',
    '2',
    '--from',
    'bad.md',
    '--var',
    'NOPE=the docs',
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(
    readFileSync(path.join(dir, 'subtasks', 'bad-vars.md'), 'utf8'),
    '- [ ] Read the docs\n',
  );
  assert.equal(index(dir).units[0].source.kind, 'skill');
}

// ---------------------------------------------------------------------------
// 4. Inline sources, and the artifact contract check on an open child.
{
  const dir = makeTask();
  assert.equal(mark(dir, 'start').status, 0);
  const started = mark(
    dir,
    'sub',
    'start',
    'ship-check',
    '--step',
    '3',
    '--from',
    'inline:- [ ] **1. verify the build**\n',
  );
  assert.equal(started.status, 0, started.stderr);
  const unit = index(dir).units[0];
  assert.equal(unit.source.kind, 'inline');
  assert.equal(unit.source.ref, undefined, 'inline sources record a digest, not a ref');
  assert.equal(unit.source.sha256, sha256('- [ ] **1. verify the build**\n'));

  const openCheck = spawnSync(process.execPath, [contractCheck, dir], { encoding: 'utf8' });
  assert.equal(openCheck.status, 1, openCheck.stdout);
  assert.match(openCheck.stderr, /subtask ship-check is not settled \(status running\)/);

  assert.equal(mark(dir, 'sub', 'ship-check', 'complete', '--mark-last').status, 0);
  const settledCheck = spawnSync(process.execPath, [contractCheck, dir], { encoding: 'utf8' });
  assert.equal(settledCheck.status, 0, settledCheck.stderr);
  assert.match(settledCheck.stdout, /TASK_ARTIFACT_CONTRACT_PASS/);
}

// ---------------------------------------------------------------------------
// 5. A child on a role checklist keeps its own pair; the manifest is untouched.
{
  const dir = makeTask();
  writeFileSync(
    path.join(dir, 'SELF-REVIEW.md'),
    ['# Worker: Self-review', '', '- [ ] **1. Review the domain patterns**', ''].join('\n'),
  );
  writeFileSync(
    path.join(dir, 'checklist-target.json'),
    `${JSON.stringify({ checklist: 'SELF-REVIEW.md' }, null, 2)}\n`,
  );
  const started = mark(
    dir,
    'sub',
    'start',
    'domain-review',
    '--step',
    '1',
    '--from',
    'inline:- [ ] **1. read the library**\n',
  );
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(index(dir).units[0].parent, { checklist: 'SELF-REVIEW.md', stepNumber: 1 });
  assert.equal(childSignal(dir, 'domain-review').parent.checklist, 'SELF-REVIEW.md');

  assert.equal(mark(dir, 'sub', 'domain-review', 'complete', '--mark-last').status, 0);
  // The role signal, not SIGNAL.json, carries the parent effect.
  const roleSignal = readJson(path.join(dir, 'SELF-REVIEW-SIGNAL.json'));
  assert.equal(roleSignal.status, 'running');
  assert.equal(roleSignal.checklistTiming.source, 'SELF-REVIEW.md');
  assert.equal(roleSignal.checklistTiming.events[0].label, '1. Review the domain patterns');
  assert.ok(!existsSync(path.join(dir, 'SIGNAL.json')), 'the worker signal is untouched');
  assert.equal(
    readJson(path.join(dir, 'checklist-target.json')).checklist,
    'SELF-REVIEW.md',
    'a child unit never rewrites the manifest',
  );
}

process.stdout.write('mark sub (child checklist unit) tests: ok\n');

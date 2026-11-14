const {
  makeTask,
  assert,
  mark,
  parentSignal,
  readFileSync,
  path,
  index,
  sha256,
  SKILL_SOURCE,
  childSignal,
  writeFileSync,
} = require('./mark-subtask.test-support.cjs');

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
  assert.match(parentChecklist, /- \[x\] \*\*2\. Review/);
  assert.match(parentChecklist, /- \[ \] \*\*3\. Ship it/);
  const parent = parentSignal(dir);
  assert.equal(parent.status, 'running');
  // The parent event is exactly what a normal parent mark writes: the step
  // NAME (bold lead, instruction tail dropped), so deriveChecklistStepDurations
  // needs no change.
  const parentEvent = parent.checklistTiming.events.find((event) => event.stepNumber === 2);
  assert.ok(parentEvent, 'child completion appends the parent timing event');
  assert.equal(parentEvent.label, '2. Review the diff against the review skill');
  assert.equal(parent.step, '2. Review the diff against the review skill');

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

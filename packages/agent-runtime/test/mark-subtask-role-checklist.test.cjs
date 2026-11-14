const {
  makeTask,
  writeFileSync,
  path,
  mark,
  assert,
  index,
  childSignal,
  readJson,
  existsSync,
} = require('./mark-subtask.test-support.cjs');

// ---------------------------------------------------------------------------
// 5. A child on a role checklist keeps its own pair; the manifest is untouched.
{
  const dir = makeTask();
  writeFileSync(
    path.join(dir, 'REVIEW.md'),
    ['# Worker: Review', '', '- [ ] **1. Review the domain patterns**', ''].join('\n'),
  );
  writeFileSync(
    path.join(dir, 'checklist-target.json'),
    `${JSON.stringify({ checklist: 'REVIEW.md' }, null, 2)}\n`,
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
  assert.deepEqual(index(dir).units[0].parent, { checklist: 'REVIEW.md', stepNumber: 1 });
  assert.equal(childSignal(dir, 'domain-review').parent.checklist, 'REVIEW.md');

  assert.equal(mark(dir, 'sub', 'domain-review', 'complete', '--mark-last').status, 0);
  // The role signal, not SIGNAL.json, carries the parent effect.
  const roleSignal = readJson(path.join(dir, 'REVIEW-SIGNAL.json'));
  assert.equal(roleSignal.status, 'running');
  assert.equal(roleSignal.checklistTiming.source, 'REVIEW.md');
  assert.equal(roleSignal.checklistTiming.events[0].label, '1. Review the domain patterns');
  assert.ok(!existsSync(path.join(dir, 'SIGNAL.json')), 'the worker signal is untouched');
  assert.equal(
    readJson(path.join(dir, 'checklist-target.json')).checklist,
    'REVIEW.md',
    'a child unit never rewrites the manifest',
  );
}

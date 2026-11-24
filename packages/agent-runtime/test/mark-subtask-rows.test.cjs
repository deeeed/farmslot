// `mark sub <id> <rows>` and `sub <id> complete --rows <rows>`: several child rows in one call.
// Run 961d55d3 marked 37 rows one call at a time.
const {
  makeTask,
  readFileSync,
  path,
  mark,
  assert,
  childSignal,
  writeFileSync,
} = require('./mark-subtask.test-support.cjs');

const ROWS = Array.from({ length: 9 }, (_, i) => `- [ ] **${i + 1}. row ${i + 1}**`).join('\n');

function unitTask() {
  const dir = makeTask();
  const started = mark(dir, 'sub', 'start', 'rows', '--step', '1', '--from', `inline:${ROWS}\n`);
  assert.equal(started.status, 0, started.stderr);
  return dir;
}

const checklist = (dir) => readFileSync(path.join(dir, 'subtasks', 'rows.md'), 'utf8');
const ticked = (dir) =>
  [...checklist(dir).matchAll(/- \[x\] \*\*(\d+)\./g)].map((match) => Number(match[1]));
const events = (dir) =>
  childSignal(dir, 'rows').checklistTiming.events.map((event) => event.stepNumber);

// A range and a mixed list tick their rows with one event each, in one signal write.
{
  const dir = unitTask();
  const marked = mark(dir, 'sub', 'rows', '2-4');
  assert.equal(marked.status, 0, marked.stderr);
  assert.match(marked.stdout, /marked subtask rows rows 2-4 \(3 rows\)/);
  assert.deepEqual(ticked(dir), [2, 3, 4]);
  assert.deepEqual(events(dir), [2, 3, 4]);
  const stamps = new Set(childSignal(dir, 'rows').checklistTiming.events.map((e) => e.checkedAt));
  assert.equal(stamps.size, 1, 'rows marked in one call share one checkedAt');
  assert.equal(mark(dir, 'sub', 'rows', '1,5-6').status, 0);
  assert.deepEqual(ticked(dir), [1, 2, 3, 4, 5, 6]);
  // An already-ticked row in a list is accepted and keeps its event, as a single mark does.
  assert.equal(mark(dir, 'sub', 'rows', '6-7').status, 0);
  assert.deepEqual(events(dir), [2, 3, 4, 1, 5, 6, 7]);
  // A single row keeps today's message.
  const single = mark(dir, 'sub', 'rows', '8');
  assert.match(single.stdout, /marked subtask rows 8: 8\. row 8/);
}

// Every malformed or out-of-range list is refused with nothing written.
{
  const dir = unitTask();
  const before = checklist(dir);
  const signalBefore = readFileSync(path.join(dir, 'subtasks', 'rows-SIGNAL.json'), 'utf8');
  for (const [args, pattern, code] of [
    [['5-3'], /reversed range 5-3/, 2],
    [['2,3,2'], /row 2 is named twice/, 2],
    [['2-4,3'], /row 3 is named twice/, 2],
    [['0'], /subtask rows start at 1/, 2],
    [['2,,3'], /subtask rows are one token/, 2],
    [['2, 3'], /subtask rows are one token/, 2],
    [['1-12'], /subtask rows has no step 12/, 1],
    [['2', '3'], /takes one row token; name several rows as 2,3,4 or 2-4/, 2],
    [['status', 'x'], /sub <id> status takes no arguments/, 2],
  ]) {
    const refused = mark(dir, 'sub', 'rows', ...args);
    assert.equal(refused.status, code, `${args.join(' ')}: ${refused.stderr}`);
    assert.match(refused.stderr, pattern);
  }
  assert.equal(checklist(dir), before);
  assert.equal(readFileSync(path.join(dir, 'subtasks', 'rows-SIGNAL.json'), 'utf8'), signalBefore);
}

// complete --rows ticks the named final rows and completes in one call; a refusal writes nothing.
{
  const dir = unitTask();
  assert.equal(mark(dir, 'sub', 'rows', '1-5').status, 0);
  const before = checklist(dir);
  let refused = mark(dir, 'sub', 'rows', 'complete', '--rows', '6-8');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /checklist incomplete — 1 step\(s\) still \[ \] \(9:/);
  refused = mark(dir, 'sub', 'rows', 'complete', '--rows', '6-9', '--mark-last');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--rows already names the final rows; drop --mark-last/);
  refused = mark(dir, 'sub', 'rows', 'complete', '--rows', '6-9', '--report', 'artifacts/r.md');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /missing required artifact: artifacts\/r\.md/);
  assert.equal(checklist(dir), before, 'refused calls tick nothing');
  writeFileSync(path.join(dir, 'artifacts', 'r.md'), '# Report\n');
  const done = mark(dir, 'sub', 'rows', 'complete', '--rows', '6-9', '--report', 'artifacts/r.md');
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(ticked(dir), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(childSignal(dir, 'rows').status, 'complete');
  assert.deepEqual(events(dir), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.match(readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8'), /- \[x\] \*\*1\./);
}

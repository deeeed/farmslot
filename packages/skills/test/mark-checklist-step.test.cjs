const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'scripts', 'mark-checklist-step.cjs');
const dir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-'));
const task = path.join(dir, 'CHECKLIST.md');
const signal = path.join(dir, 'SIGNAL.json');

writeFileSync(
  task,
  ['# Checklist', '', '- [ ] First gate', '- [ ] **Second gate** — validate'].join('\n'),
);

let result = spawnSync(process.execPath, [helper, task, signal, '1'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
assert.match(readFileSync(task, 'utf8'), /- \[x\] First gate/);
let parsed = JSON.parse(readFileSync(signal, 'utf8'));
assert.equal(parsed.status, 'running');
assert.equal(parsed.checklistTiming.events.length, 1);
assert.equal(parsed.checklistTiming.events[0].stepNumber, 1);
assert.equal(parsed.checklistTiming.events[0].label, 'First gate');

result = spawnSync(
  process.execPath,
  [helper, task, signal, '2', '--status', 'complete', '--outcome', 'success'],
  { encoding: 'utf8' },
);
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(signal, 'utf8'));
assert.equal(parsed.status, 'complete');
assert.equal(parsed.outcome, 'success');
assert.equal(parsed.checklistTiming.events.length, 2);
assert.equal(parsed.checklistTiming.events[1].stepNumber, 2);
assert.equal(parsed.checklistTiming.events[1].label, 'Second gate validate');


result = spawnSync(process.execPath, [helper, task, signal, '1', '--status', 'complet'], {
  encoding: 'utf8',
});
assert.equal(result.status, 2);


result = spawnSync(process.execPath, [helper, task, signal, '--help'], { encoding: 'utf8' });
assert.equal(result.status, 0);
assert.match(result.stdout, /Use the visible 1-based checklist step number/);

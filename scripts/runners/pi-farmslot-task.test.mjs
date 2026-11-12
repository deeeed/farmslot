import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  deliverTaskOnce,
  farmslotStatusLine,
  readFarmslotSignal,
  readTaskMarkdown,
  runFarmslotMark,
  taskDir,
} from './pi-farmslot-task.mjs';

const require = createRequire(import.meta.url);
const runtimeScripts = path.resolve(import.meta.dirname, '../../packages/agent-runtime/scripts');
const { CHECKLIST_TARGET_MANIFEST, terminalContractInputForChecklist } = require(
  path.join(runtimeScripts, 'checklist-target.cjs'),
);
const { resolveWorkerTerminalContract } = require(
  path.join(runtimeScripts, 'worker-terminal-contract.cjs'),
);

function realMarkFixture(t, checklist = 'CHECKLIST.md') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mark-complete-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'inputs'));
  fs.mkdirSync(path.join(dir, 'artifacts'));
  const task = path.join(dir, 'TASK.md');
  fs.writeFileSync(task, '# Static review task\n');
  fs.writeFileSync(path.join(dir, CHECKLIST_TARGET_MANIFEST), JSON.stringify({ checklist }));
  fs.writeFileSync(path.join(dir, checklist), '- [x] Review the code\n- [ ] Finish the review\n');
  fs.writeFileSync(
    path.join(dir, terminalContractInputForChecklist(checklist)),
    JSON.stringify(
      resolveWorkerTerminalContract(null, checklist === 'REVIEW.md' ? 'review' : 'review-pr'),
    ),
  );
  fs.writeFileSync(path.join(dir, 'artifacts', 'learnings.md'), '- No additional learning.\n');
  fs.writeFileSync(path.join(dir, 'artifacts', 'review.md'), '# Review\n\nNo findings.\n');
  fs.writeFileSync(path.join(dir, 'artifacts', 'line-comments.json'), '[]\n');
  fs.writeFileSync(path.join(dir, 'artifacts', 'review-feedback.md'), '# Review\n\nPASS\n');
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(
    path.join(dir, 'mark'),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(runtimeScripts, 'mark-checklist-step.cjs'))} ${quote(dir)} "$@"\n`,
    { mode: 0o755 },
  );
  const env = { FARMSLOT_TASK_FILE: task };
  runFarmslotMark('start', env);
  return { dir, env, checklist: path.join(dir, checklist) };
}

for (const action of ['complete', 'COMPLETE']) {
  test(`${action} closes the final row through the real task marker`, (t) => {
    const fixture = realMarkFixture(t);
    runFarmslotMark(action, fixture.env);
    assert.match(fs.readFileSync(fixture.checklist, 'utf8'), /- \[x\] Finish the review/);
    const signal = readFarmslotSignal(fixture.env).body;
    assert.equal(signal.status, 'complete');
    assert.equal(signal.outcome, 'success');
  });
}

test('complete refuses earlier open rows without changing the running signal or checklist', (t) => {
  const fixture = realMarkFixture(t);
  fs.writeFileSync(fixture.checklist, '- [ ] Review the code\n- [ ] Finish the review\n');
  const checklistBefore = fs.readFileSync(fixture.checklist, 'utf8');
  const signalPath = path.join(fixture.dir, 'SIGNAL.json');
  const signalBefore = fs.readFileSync(signalPath, 'utf8');
  assert.throws(() => runFarmslotMark('complete', fixture.env), /checklist incomplete/);
  assert.equal(fs.readFileSync(fixture.checklist, 'utf8'), checklistBefore);
  assert.equal(fs.readFileSync(signalPath, 'utf8'), signalBefore);
});

test('complete honors the selected review checklist and signal', (t) => {
  const fixture = realMarkFixture(t, 'REVIEW.md');
  const workerChecklist = path.join(fixture.dir, 'CHECKLIST.md');
  const workerBefore = '- [ ] Worker task remains open\n';
  fs.writeFileSync(workerChecklist, workerBefore);
  runFarmslotMark('complete', fixture.env);
  assert.match(fs.readFileSync(fixture.checklist, 'utf8'), /- \[x\] Finish the review/);
  assert.equal(fs.readFileSync(workerChecklist, 'utf8'), workerBefore);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(fixture.dir, 'REVIEW-SIGNAL.json'), 'utf8')).status,
    'complete',
  );
  assert.equal(fs.existsSync(path.join(fixture.dir, 'SIGNAL.json')), false);
});

test('task delivery is isolated across sessions and tasks sharing a slot', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delivery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const worker = path.join(dir, 'TASK.md');
  const reviewer = path.join(dir, 'SELF-REVIEW.rev-pi.md');
  fs.writeFileSync(worker, 'worker task');
  fs.writeFileSync(reviewer, 'review task');
  fs.writeFileSync(path.join(dir, 'task-delivered'), 'old slot-wide marker');
  const delivered = [];
  const options = {
    obsDir: dir,
    sessionId: 'worker-session',
    sendUserMessage: async (text) => {
      delivered.push(text);
    },
    env: { FARMSLOT_TASK_FILE: worker },
  };
  assert.equal(await deliverTaskOnce(options), true);
  assert.equal(await deliverTaskOnce(options), false);
  const reviewOptions = {
    ...options,
    sessionId: 'review-session',
    env: { FARMSLOT_TASK_FILE: reviewer },
  };
  assert.equal(await deliverTaskOnce(reviewOptions), true);
  assert.equal(await deliverTaskOnce(reviewOptions), false);
  // A retry of the same task in a fresh session must also receive it.
  assert.equal(await deliverTaskOnce({ ...reviewOptions, sessionId: 'retry-session' }), true);
  assert.equal(await deliverTaskOnce({ ...options, env: reviewOptions.env }), true);
  assert.deepEqual(delivered, ['worker task', 'review task', 'review task', 'review task']);
});

test('failed task submission does not prevent a retry', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delivery-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const task = path.join(dir, 'TASK.md');
  fs.writeFileSync(task, 'task');
  const options = { obsDir: dir, sessionId: 'session', env: { FARMSLOT_TASK_FILE: task } };
  await assert.rejects(deliverTaskOnce(options), /requires sendUserMessage/);
  await assert.rejects(
    deliverTaskOnce({
      ...options,
      sendUserMessage: async () => {
        throw new Error('submission failed');
      },
    }),
    /submission failed/,
  );
  assert.equal(await deliverTaskOnce({ ...options, sendUserMessage: async () => {} }), true);
});

test('farmslotStatusLine includes slot thinking and truncated run id', () => {
  assert.equal(
    farmslotStatusLine({
      FARMSLOT_SLOT_ID: 'macwork-mmedev-2',
      FARMSLOT_RUN_ID: '3b737eb2-c8fd-4119-91c3-9acb0df2c1bd',
      FARMSLOT_THINKING: 'low',
      FARMSLOT_MODEL: 'xai/grok-4.6',
    }),
    'fs macwork-mmedev-2 3b737eb2 low xai/grok-4.6',
  );
});

test('runFarmslotMark executes the task-dir mark shim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mark-'));
  const taskFile = path.join(dir, 'TASK.md');
  fs.writeFileSync(taskFile, '# task\n');
  fs.writeFileSync(path.join(dir, 'mark'), '#!/bin/sh\necho "marked $1"\n', { mode: 0o755 });
  const out = runFarmslotMark('start', { FARMSLOT_TASK_FILE: taskFile });
  assert.match(out, /marked start/);
  assert.equal(taskDir({ FARMSLOT_TASK_FILE: taskFile }), dir);
  assert.equal(readTaskMarkdown({ FARMSLOT_TASK_FILE: taskFile }), '# task\n');
});

test('readFarmslotSignal reports missing then parsed SIGNAL.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-signal-'));
  const taskFile = path.join(dir, 'TASK.md');
  fs.writeFileSync(taskFile, '# task\n');
  const missing = readFarmslotSignal({ FARMSLOT_TASK_FILE: taskFile });
  assert.equal(missing.present, false);
  fs.writeFileSync(path.join(dir, 'SIGNAL.json'), '{"status":"blocked"}\n');
  const present = readFarmslotSignal({ FARMSLOT_TASK_FILE: taskFile });
  assert.equal(present.present, true);
  assert.equal(present.body.status, 'blocked');
});

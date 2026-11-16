// Real run and task-progress reads, followed by the run-page view, before checkbox 1.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const output = process.env.FARMSLOT_ACK_PROOF_OUTPUT;
const runId = process.env.FARMSLOT_ACK_PROOF_RUN_ID;
const tab = process.env.FARMSLOT_ACK_PROOF_TAB;
assert(
  output && runId && tab,
  'Select an explicit gateway profile, real run, owned tab and output',
);
const source = fileURLToPath(new URL('../../../', import.meta.url));
const execute = promisify(execFile);
const cdp = async (...args) =>
  JSON.parse(
    (
      await execute(
        process.execPath,
        [path.join(source, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { timeout: 40000, maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout,
  );
const read = () =>
  cdp(
    'eval',
    tab,
    '--file',
    path.join(source, 'apps/command-center/scripts/probes/worker-acknowledgement-read.js'),
  );
const readSource = async () => {
  const { run } = await cdp('gateway', 'run.get', JSON.stringify({ runId, view: 'snapshot' }));
  const progress = await cdp(
    'gateway',
    'task.progress',
    JSON.stringify({ runId, slotId: run.slotId ?? '' }),
  );
  assert.equal(progress.structured?.completedSteps, 0, 'Capture before checkbox 1');
  assert(progress.structured.totalSteps > 0, 'Read a real worker checklist');
  return { run, progress };
};
await cdp('focus', tab);
const before = await readSource();
const end = Date.now() + 30000;
let dom;
do {
  dom = await read();
  if (dom.runId === runId && dom.acknowledgedAt) break;
  await delay(100);
} while (Date.now() < end);
assert(dom.connected && dom.runId === runId && !dom.modalOpen);
if (!dom.panelOpen)
  await cdp(
    'click',
    tab,
    'run-detail >>> run-pipeline >>> [data-panel="run-step-progress"] button',
  );
await cdp('click', tab, 'run-detail >>> run-pipeline >>> run-checklist-progress >>> time');
dom = await read();
const signal = before.run.agentContexts?.find(
  (context) =>
    context.attemptStartedAt === dom.acknowledgedAt &&
    context.signalAttemptId &&
    context.lastSignalAt,
);
assert(signal, 'The displayed timestamp must belong to an observed signal attempt');
assert(Number.isFinite(Date.parse(signal.attemptStartedAt)));
assert(Date.parse(signal.lastSignalAt) >= Date.parse(signal.attemptStartedAt));
const expected =
  'Worker acknowledged ' +
  new Date(signal.attemptStartedAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
assert.equal(dom.text, expected);
assert.equal(dom.completed, 0);
assert.equal(dom.counts, `0/${before.progress.structured.totalSteps}`);
assert(dom.visible, 'The acknowledgement must be fully on screen');
await mkdir(output, { recursive: true });
await cdp('screenshot', tab, path.join(output, 'worker-acknowledged.png'));
const after = await readSource();
const final = await read();
assert.equal(final.completed, 0, 'Screenshot must precede checkbox 1');
assert.equal(final.acknowledgedAt, dom.acknowledgedAt);
assert(
  after.run.agentContexts?.some(
    (context) =>
      context.id === signal.id &&
      context.signalAttemptId === signal.signalAttemptId &&
      context.attemptStartedAt === dom.acknowledgedAt,
  ),
);
const result = {
  status: 'pass',
  source: 'Real authenticated run/task-progress reads and connected browser, no UI injection',
  runId,
  contextId: signal.id,
  signalAttemptId: signal.signalAttemptId,
  acknowledgedAt: signal.attemptStartedAt,
  completedBefore: 0,
  completedAfter: 0,
  dom: final,
};
await writeFile(path.join(output, 'proof.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));

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
const phase = process.env.FARMSLOT_ACK_PROOF_PHASE ?? 'worker';
assert(['worker', 'review'].includes(phase));
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
  if (phase === 'worker') {
    assert.equal(progress.structured?.completedSteps, 0, 'Capture before checkbox 1');
    assert(progress.structured.totalSteps > 0, 'Read a real worker checklist');
  }
  return { run, progress };
};
await cdp('focus', tab);
const before = await readSource();
if (phase === 'review') {
  assert.equal(before.run.status, 'reviewing');
  const context = before.run.agentContexts?.find(
    (entry) => entry.role === 'review' && entry.signalAttemptId,
  );
  assert(context && context.status === 'working');
  assert(
    Date.parse(context.lastSignalAt) > Date.parse(context.attemptStartedAt),
    'A pre-bound review retains its launch clock after the real marker',
  );
  let view;
  const end = Date.now() + 30000;
  do {
    view = await read();
    if (
      view.runId === runId &&
      view.signalContexts.some(
        (entry) => entry.id === context.id && entry.lastSignalAt === context.lastSignalAt,
      )
    )
      break;
    await delay(100);
  } while (Date.now() < end);
  assert(view.connected && view.runId === runId && !view.modalOpen);
  assert(
    view.signalContexts.some(
      (entry) => entry.id === context.id && entry.lastSignalAt === context.lastSignalAt,
    ),
    'Observe the real accepted reviewer signal in the browser',
  );
  assert.equal(
    view.acknowledgedAt,
    undefined,
    'A review launch clock must not be labelled worker acknowledgement',
  );
  await mkdir(output, { recursive: true });
  await cdp('screenshot', tab, path.join(output, 'review-clock-not-acknowledged.png'));
  assert.equal((await read()).acknowledgedAt, undefined);
  const after = await readSource();
  assert(
    after.run.agentContexts.some(
      (entry) => entry.id === context.id && entry.attemptStartedAt === context.attemptStartedAt,
    ),
  );
  await writeFile(
    path.join(output, 'proof.json'),
    JSON.stringify(
      {
        status: 'pass',
        phase,
        runId,
        contextId: context.id,
        launchedAt: context.attemptStartedAt,
        actualSignalAt: context.lastSignalAt,
        dom: view,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ status: 'pass', phase, runId }));
  process.exit(0);
}
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

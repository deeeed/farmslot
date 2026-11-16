// Read-only real RPC/browser proof of parent and recorded child progress.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const output = process.env.FARMSLOT_CHILD_PROOF_OUTPUT;
const runId = process.env.FARMSLOT_CHILD_PROOF_RUN_ID;
const tab = process.env.FARMSLOT_CHILD_PROOF_TAB;
assert(
  output && runId && tab,
  'Select an authenticated gateway profile, run, owned tab and output',
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
    path.join(source, 'apps/command-center/scripts/probes/active-child-progress-read.js'),
  );
const readSource = async () => {
  const { run } = await cdp('gateway', 'run.get', JSON.stringify({ runId, view: 'snapshot' }));
  const task = await cdp(
    'gateway',
    'task.progress',
    JSON.stringify({ runId, slotId: run.slotId ?? '' }),
  );
  const parent = task.structured;
  const step = parent?.phases
    .flatMap((phase) => phase.steps)
    .find((entry) => entry.status === 'running');
  assert(parent && step?.subtask, 'Select a real current parent with recorded child progress');
  const unit = step.subtask;
  assert(unit.progress.totalSteps > 0);
  assert(
    unit.progress.completedSteps > 0 && unit.progress.completedSteps < unit.progress.totalSteps,
    'Prove an in-progress child with actual marks',
  );
  return { run, parent, unit };
};
await cdp('focus', tab);
// Rerun this same recipe after stopping the owned fixture, or making its
// checklist unreadable. These checks read actual connection/read state only.
const expectedReadState = process.env.FARMSLOT_CHILD_PROOF_EXPECT_READ_STATE;
if (expectedReadState) {
  assert(['saved', 'error'].includes(expectedReadState));
  let dom;
  const end = Date.now() + 30000;
  do {
    dom = await read();
    if (
      expectedReadState === 'saved'
        ? !dom.connected && dom.childStep === 'Saved child progress'
        : dom.connected && dom.readNotice === 'Could not read progress' && dom.childBars === 0
    )
      break;
    await delay(100);
  } while (Date.now() < end);
  assert.equal(dom.runId, runId);
  if (expectedReadState === 'saved') {
    assert(!dom.connected);
    assert.equal(dom.childStep, 'Saved child progress');
    assert.equal(dom.childBars, 1);
  } else {
    assert(dom.connected);
    assert.equal(dom.readNotice, 'Could not read progress');
    assert.equal(dom.childBars, 0);
  }
  await mkdir(output, { recursive: true });
  await cdp(
    'screenshot',
    tab,
    path.join(output, `child-progress-${expectedReadState}.png`),
    '--width',
    '1100',
    '--height',
    '900',
  );
  await writeFile(
    path.join(output, `proof-${expectedReadState}.json`),
    JSON.stringify({ status: 'pass', runId, expectedReadState, dom }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ status: 'pass', runId, expectedReadState }));
  process.exit(0);
}
const before = await readSource();
let dom;
const end = Date.now() + 30000;
do {
  dom = await read();
  if (dom.connected && dom.runId === runId && !dom.modalOpen) break;
  await delay(100);
} while (Date.now() < end);
assert(dom.connected && dom.runId === runId && !dom.modalOpen);
if (!dom.panelOpen)
  await cdp(
    'click',
    tab,
    'run-detail >>> run-pipeline >>> [data-panel="run-step-progress"] button',
  );
await mkdir(output, { recursive: true });
const captures = [];
for (const [name, width] of [
  ['wide', 1100],
  ['narrow', 380],
]) {
  await cdp('viewport', tab, String(width), '900');
  await cdp(
    'click',
    tab,
    'run-detail >>> run-pipeline >>> run-checklist-progress >>> [data-testid="checklist-child-progress"] .counts',
  );
  dom = await read();
  assert.equal(dom.parentCounts, `${before.parent.completedSteps}/${before.parent.totalSteps}`);
  assert.equal(
    dom.childCounts,
    `${before.unit.progress.completedSteps}/${before.unit.progress.totalSteps}`,
  );
  assert.equal(dom.childStep, before.unit.progress.currentStep);
  assert.equal(dom.childBars, 1, 'One child level only');
  assert(dom.visible && dom.fits, 'The child strip must be visible without clipping');
  const screenshot = await cdp(
    'screenshot',
    tab,
    path.join(output, `child-progress-${name}.png`),
    '--width',
    String(width),
    '--height',
    '900',
  );
  assert.equal(
    screenshot.width,
    width,
    'Capture the requested CSS width, including below the browser window minimum',
  );
  captures.push({ name, width, dom, screenshot });
}
await cdp('viewport', tab, '1100', '900');
const after = await readSource();
assert.equal(
  after.parent.completedSteps,
  before.parent.completedSteps,
  'The parent changed during capture',
);
assert.equal(after.unit.id, before.unit.id);
assert.equal(
  after.unit.progress.completedSteps,
  before.unit.progress.completedSteps,
  'The child changed during capture',
);
const result = {
  status: 'pass',
  source: 'Real authenticated run/task-progress RPC and connected browser, no UI injection',
  runId,
  unitId: before.unit.id,
  parentCounts: `${before.parent.completedSteps}/${before.parent.totalSteps}`,
  childCounts: `${before.unit.progress.completedSteps}/${before.unit.progress.totalSteps}`,
  captures,
};
await writeFile(path.join(output, 'proof.json'), JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({ status: 'pass', runId, parent: result.parentCounts, child: result.childCounts }),
);

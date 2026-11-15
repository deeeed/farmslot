// Read-only living proof against an explicitly selected real run and connected browser tab.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const output = process.env.FARMSLOT_AC_PROOF_OUTPUT;
const runId = process.env.FARMSLOT_AC_PROOF_RUN_ID;
const target = process.env.FARMSLOT_AC_PROOF_TAB;
const phase = process.env.FARMSLOT_AC_PROOF_PHASE ?? 'task';
assert(output && runId && target, 'Select output, run UUID and owned CDP tab');
assert(['pre-task', 'task', 'pre-worker', 'read-failure'].includes(phase));
const execute = promisify(execFile);
const cdp = async (...args) =>
  JSON.parse(
    (
      await execute(
        process.execPath,
        [path.join(source, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { cwd: source, timeout: 40000 },
      )
    ).stdout,
  );
await cdp('focus', target);
const result = await cdp('gateway', 'run.get', JSON.stringify({ runId, view: 'snapshot' }));
const run = result.run;
assert.equal(run.id, runId);
let dom = await cdp(
  'eval',
  target,
  '--file',
  path.join(source, 'apps/command-center/scripts/probes/acceptance-panel-read.js'),
);
assert(dom.connected, 'Browser must use the real connected gateway');
assert(!dom.modalOpen, 'Dismiss the announcement before capturing readable criteria');
if (dom.panelOpen === false || phase === 'read-failure') {
  if (dom.panelOpen)
    await cdp(
      'click',
      target,
      'run-detail >>> run-pipeline >>> [data-panel="run-acceptance"] button',
    );
  await cdp(
    'click',
    target,
    'run-detail >>> run-pipeline >>> [data-panel="run-acceptance"] button',
  );
  dom = await cdp(
    'eval',
    target,
    '--file',
    path.join(source, 'apps/command-center/scripts/probes/acceptance-panel-read.js'),
  );
}

assert.equal(dom.runId, runId);
assert(!dom.tally?.includes('0/0'), 'An absent ledger must not imply zero acceptance criteria');
assert(
  dom.rows.every((row) => !row.nestedTextDisclosure),
  'Criterion text must be readable at one level',
);
if (phase === 'pre-task') {
  assert(
    !run.taskFile &&
      ['pending', 'running'].includes(run.steps.find((step) => step.name === 'write-task')?.status),
  );
  assert.equal(dom.errors.length, 0);
  assert(
    dom.preparing || dom.rows.length,
    'Show registered criteria or a quiet task preparation state',
  );
} else if (phase === 'pre-worker') {
  assert.equal(run.status, 'preparing', 'The live run left Preparing before capture');
  assert.equal(dom.status, 'preparing', 'The live run left Preparing before capture');
  assert.equal(
    dom.ledgerReadCode,
    'RESOURCE_OBSERVATION_UNSUPPORTED',
    'The live no-watch state ended before capture',
  );
  assert.equal(dom.hasProgressData, false, 'The live no-watch state ended before capture');
  assert.equal(dom.errors.length, 0);
} else if (phase === 'read-failure') {
  assert(dom.ledgerDataError, 'Require a real ledger read failure from the backend');
  assert(dom.errors.length > 0);
  assert(
    dom.errors.some((text) => text.includes(dom.ledgerDataError)),
    'The displayed error must be the actual ledger read failure',
  );
  assert(
    dom.errorStyles.some(({ color, visible }) => {
      const rgb = color.match(/\d+/g)?.map(Number);
      return visible && rgb && rgb[0] > rgb[1] + 40 && rgb[0] > rgb[2] + 40;
    }),
    'A real read failure must remain visibly red',
  );
} else {
  assert(run.taskFile, 'Task source must exist');
  assert(dom.rows.length > 0, 'Read actual criteria after task creation');
}
await mkdir(output, { recursive: true });
await cdp('screenshot', target, path.join(output, `${phase}.png`));

if (phase === 'pre-worker') {
  const after = await cdp(
    'eval',
    target,
    '--file',
    path.join(source, 'apps/command-center/scripts/probes/acceptance-panel-read.js'),
  );
  assert.equal(after.status, 'preparing', 'The screenshot must still show live preparation');
  assert.equal(after.errors.length, 0);
}

if (phase === 'read-failure') {
  const after = await cdp(
    'eval',
    target,
    '--file',
    path.join(source, 'apps/command-center/scripts/probes/acceptance-panel-read.js'),
  );
  assert.equal(after.ledgerDataError, dom.ledgerDataError);
  assert(
    after.errors.some((text) => text.includes(dom.ledgerDataError)),
    'The screenshot must show the actual ledger read failure',
  );
}
await writeFile(
  path.join(output, `${phase}.json`),
  JSON.stringify(
    {
      status: 'pass',
      source: 'Authenticated run.get and connected Command Center DOM',
      runId,
      phase,
      dom,
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify({ status: 'pass', runId, phase, rows: dom.rows.length }));

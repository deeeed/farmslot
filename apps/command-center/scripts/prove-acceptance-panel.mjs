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
assert(['pre-task', 'task'].includes(phase));
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
const result = await cdp('gateway', 'run.get', JSON.stringify({ runId, view: 'snapshot' }));
const run = result.run;
assert.equal(run.id, runId);
const dom = await cdp(
  'eval',
  target,
  '--file',
  path.join(source, 'apps/command-center/scripts/probes/acceptance-panel-read.js'),
);
assert(dom.connected, 'Browser must use the real connected gateway');
assert(!dom.modalOpen, 'Dismiss the announcement before capturing readable criteria');
assert.equal(dom.runId, runId);
assert(!dom.text?.includes('0/0'), 'An absent ledger must not imply zero acceptance criteria');
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
} else {
  assert(run.taskFile, 'Task source must exist');
  assert(dom.rows.length > 0, 'Read actual criteria after task creation');
}
await mkdir(output, { recursive: true });
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
await cdp('screenshot', target, path.join(output, `${phase}.png`));
console.log(JSON.stringify({ status: 'pass', runId, phase, rows: dom.rows.length }));

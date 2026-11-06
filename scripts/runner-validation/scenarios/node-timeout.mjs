import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
export async function runScenario(c) {
  await c.start({
    scripted: { mode: 'scenario', scenario: 'late-ack', stepDelayMs: 1 },
    flowType: 'pr-complete',
    mode: 'autonomous',
    devInteractiveProfile: undefined,
    ticketOrPr: 'fixture/recovery#101',
    prNumber: 101,
  });
  await c.wait(
    'ci-watch starts',
    (run) => run.steps.find((step) => step.name === 'ci-watch')?.status === 'running',
  );
  const arm = path.join(c.stack.holds, 'node-timeout');
  await writeFile(arm, 'drop one head request');
  await c.wait('node RPC actually times out', () => existsSync(arm + '.timeout.json'));
  const timeout = JSON.parse(await readFile(arm + '.timeout.json', 'utf8'));
  assert.match(timeout.message, /timeout after 20ms/);
  const run = await c.get();
  assert.ok(run.prNumber);
  await c.replay('ci-watch');
  await c.wait(
    'ci-watch replay starts',
    (run) => run.steps.find((step) => step.name === 'ci-watch')?.status === 'running',
  );
  await c.wait(
    'replayed ci-watch polls successfully',
    (run) => Number(run.steps.find((step) => step.name === 'ci-watch')?.outputs?.pollCount) > 0,
  );
}

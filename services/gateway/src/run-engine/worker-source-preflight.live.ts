// Manual source-owner regression: two real loader processes exceed the default five-second test budget.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { retainTaskExecution } from '../../../../packages/agent-runtime/src/task-init/execution-provenance.js';

import { expected, probe, root } from './worker-source-preflight.test-support.js';

test('actual retained-template byte drift refuses without changing a source selection', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'worker-source-preflight-'));
  const previousHome = process.env.FARMSLOT_HOME;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.FARMSLOT_HOME = path.join(temp, 'home');
  t.after(() => {
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
    rmSync(temp, { recursive: true, force: true });
  });
  const distribution = path.join(temp, 'distribution');
  const template = path.join(temp, 'template');
  const taskDir = path.join(temp, 'task');
  for (const directory of [distribution, template, taskDir]) mkdirSync(directory);
  writeFileSync(
    path.join(distribution, 'package.json'),
    JSON.stringify({ name: '@farmslot/cli', version: '1.0.0' }),
  );
  const executable = path.join(distribution, 'entry.cjs');
  writeFileSync(executable, 'process.exit(0);\n');
  writeFileSync(path.join(template, 'worker.md'), 'Approved selected template\n');
  const receipt = retainTaskExecution(taskDir, {
    executable,
    packageRoot: distribution,
    distributionRoot: distribution,
    bindingIdentity: null,
    inputs: [template],
  });
  const value = await expected();
  value.taskDir = taskDir;
  // Exercise the real source verifier without rebuilding shared dist under readers.
  const runtime = path.join(temp, 'runtime');
  mkdirSync(path.join(runtime, 'dist'), { recursive: true });
  writeFileSync(path.join(runtime, 'package.json'), '{"type":"module"}');
  const verifier = pathToFileURL(
    path.join(root, 'packages/agent-runtime/src/task-init/execution-provenance.ts'),
  ).href;
  writeFileSync(
    path.join(runtime, 'dist/index.js'),
    `export { verifyTaskExecutionProvenance } from ${JSON.stringify(verifier)};`,
  );
  value.runtimeScript = path.join(runtime, 'scripts/task-init-cli.mjs');
  process.env.NODE_OPTIONS =
    `${previousNodeOptions ?? ''} --import ${import.meta.resolve('tsx')}`.trim();
  const original = await probe(value);
  assert.equal(original.status, 'verified', original.detail);
  const retained = receipt.retainedInputs.find((entry) => entry.source.endsWith('/template'));
  assert.ok(retained);
  const file = path.join(retained.path, 'worker.md');
  chmodSync(file, 0o644);
  writeFileSync(file, 'Wrong selected template bytes\n');
  const result = await probe(value);
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /TASK_INPUT_CHANGED/);
});

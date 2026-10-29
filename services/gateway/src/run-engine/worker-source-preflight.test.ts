import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runLaunchPreflight } from './worker-preflight.js';
import { expected, probe } from './worker-source-preflight.test-support.js';

test('selected CLI package mismatch warns without retrying or refusing launch', async () => {
  const value = await expected();
  value.cliVersion = '0.0.0-fixture';
  const result = await probe(value);
  assert.equal(result.status, 'unverified');
  assert.equal(result.retry, false);
  assert.match(result.detail, /Package version warning/);
  assert.match(result.detail, /CLI resolved .*expected 0.0.0-fixture/);
  await runLaunchPreflight([{ name: 'code', inspect: async () => result }], {
    assertCurrent() {},
    record() {},
    wait: async () => assert.fail('A package-version warning must not retry'),
  });
});

test('actual protocol and wire versions are checked through the selected CLI resolver', async () => {
  const value = await expected();
  value.cliVersion = '0.0.0-fixture';
  value.wireVersion = '0.0.0-fixture';
  const result = await probe(value);
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /node wire protocol resolved .*expected 0.0.0-fixture/);
});

test('a legacy task with no retained source binding remains explicitly unverified', async () => {
  const result = await probe(await expected());
  assert.equal(result.status, 'unverified');
  assert.equal(result.retry, false);
  assert.match(result.detail, /No retained task source receipt/);
});

for (const validReceipt of [true, false]) {
  test(`protocol 0.73.2 versus 0.73.1 warns and still checks ${validReceipt ? 'valid' : 'invalid'} retained provenance`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worker-source-version-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const protocol = path.join(root, 'node_modules/@farmslot/protocol');
    const runtime = path.join(root, 'runtime');
    const taskDir = path.join(root, 'task');
    for (const dir of [protocol, path.join(runtime, 'dist'), path.join(taskDir, 'artifacts')])
      await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: '@farmslot/cli', version: '0.3.0' }),
    );
    const cli = path.join(root, 'cli.mjs');
    await writeFile(cli, '');
    await writeFile(
      path.join(protocol, 'package.json'),
      JSON.stringify({
        name: '@farmslot/protocol',
        version: '0.73.2',
        type: 'module',
        main: 'index.js',
      }),
    );
    await writeFile(path.join(protocol, 'index.js'), "export const PROTOCOL_VERSION = '0.63.0';\n");
    await writeFile(path.join(runtime, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(
      path.join(runtime, 'dist/index.js'),
      `
import { writeFileSync } from 'node:fs';
export function verifyTaskExecutionProvenance(taskDir, binding) {
  writeFileSync(taskDir + '/verified.json', JSON.stringify(binding));
  ${validReceipt ? '' : "throw Object.assign(new Error('Retained input changed'), { code: 'TASK_PROVENANCE_INVALID', exitCode: 5 });"}
}
`,
    );
    const identity = { runId: 'retained-run' };
    await writeFile(
      path.join(taskDir, 'artifacts/harness-provenance.json'),
      JSON.stringify({ bindingIdentity: identity }),
    );
    const value = await expected();
    Object.assign(value, {
      cliVersion: '0.3.0',
      protocolVersion: '0.73.1',
      wireVersion: '0.63.0',
      taskDir,
      runtimeScript: path.join(runtime, 'scripts/task-init-cli.mjs'),
    });
    const result = await probe(value, cli);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(taskDir, 'verified.json'), 'utf8')),
      identity,
    );
    assert.match(result.detail, /protocol package resolved 0.73.2; expected 0.73.1/);
    if (validReceipt) {
      assert.equal(result.status, 'unverified');
      assert.equal(result.retry, false);
      assert.match(result.detail, /retained pack\/template\/library bytes match/);
    } else {
      assert.equal(result.status, 'mismatch');
      assert.match(result.detail, /TASK_PROVENANCE_INVALID/);
    }
  });
}

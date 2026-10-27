import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PROTOCOL_VERSION } from '@farmslot/protocol';

import {
  type WorkerSourceExpectation,
  workerSourceProbeCommand,
} from './worker-source-preflight.js';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const cli = path.join(root, 'packages/cli/bin/farmslot.mjs');
async function expected(): Promise<WorkerSourceExpectation> {
  const cliPackage = JSON.parse(
    await readFile(path.join(root, 'packages/cli/package.json'), 'utf8'),
  );
  const protocolPackage = JSON.parse(
    await readFile(path.join(root, 'packages/protocol/package.json'), 'utf8'),
  );
  return {
    cliVersion: cliPackage.version,
    protocolVersion: protocolPackage.version,
    wireVersion: PROTOCOL_VERSION,
    runtimeScript: path.join(root, 'packages/agent-runtime/scripts/task-init-cli.mjs'),
    taskDir: null,
  };
}
async function probe(value: WorkerSourceExpectation) {
  const result = await execute('/bin/sh', ['-c', workerSourceProbeCommand(value)], {
    env: { ...process.env, FARMSLOT_CLI: cli },
    timeout: 4000,
  });
  return JSON.parse(result.stdout);
}

test('selected CLI package mismatch refuses and names the expected version', async () => {
  const value = await expected();
  value.cliVersion = '0.0.0-fixture';
  const result = await probe(value);
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /CLI resolved .*expected 0.0.0-fixture/);
});

test('actual protocol and wire versions are checked through the selected CLI resolver', async () => {
  const value = await expected();
  value.wireVersion = '0.0.0-fixture';
  const result = await probe(value);
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /node wire protocol resolved .*expected 0.0.0-fixture/);
});

test('a legacy task with no retained source binding remains explicitly unverified', async () => {
  const result = await probe(await expected());
  assert.equal(result.status, 'unverified');
  assert.match(result.detail, /No retained task source receipt/);
});

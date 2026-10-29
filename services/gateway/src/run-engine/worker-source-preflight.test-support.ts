import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PROTOCOL_VERSION } from '@farmslot/protocol';

import {
  type WorkerSourceExpectation,
  workerSourceProbeCommand,
} from './worker-source-preflight.js';

const execute = promisify(execFile);
export const root = fileURLToPath(new URL('../../../../', import.meta.url));
const cli = path.join(root, 'packages/cli/bin/farmslot.mjs');
export async function expected(): Promise<WorkerSourceExpectation> {
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
export async function probe(value: WorkerSourceExpectation, cliPath = cli) {
  const result = await execute('/bin/sh', ['-c', workerSourceProbeCommand(value)], {
    env: { ...process.env, FARMSLOT_CLI: cliPath },
    timeout: 4000,
  });
  return JSON.parse(result.stdout);
}

import path from 'node:path';

import type { ExecResult } from '@farmslot/protocol';

import type { SlotVars } from '../../core/config.js';
import { shellExpressionForRemotePath } from '../../core/remote-paths.js';
import { shellQuote } from '../../core/tmux.js';

export type PrepareRuntimeContextVars = Pick<
  SlotVars,
  'slotId' | 'remoteRepo' | 'projectName' | 'machine' | 'platform' | 'resourceVars'
>;

interface PrepareFixtureOperations {
  runtimeDir: string;
  supportDir: string;
  sync(): Promise<void>;
  writeContext(command: string): Promise<ExecResult>;
}

/** Runtime bindings are checkout-local, so a moved slot needs a fresh binding. */
export async function syncPrepareFixtures(
  vars: PrepareRuntimeContextVars,
  operations: PrepareFixtureOperations,
): Promise<void> {
  await operations.sync();
  const args = [
    '--project',
    vars.projectName,
    '--slot-id',
    vars.slotId,
    '--machine',
    vars.machine,
    '--runtime-owner',
    'farmslot',
    '--platform',
    vars.platform,
    '--runtime-dir',
    operations.runtimeDir,
    '--strict',
    'true',
  ];
  for (const [flag, key] of [
    ['--watcher-port', 'port'],
    ['--metro-port', 'metro_port'],
    ['--cdp-port', 'cdp_port'],
    ['--simulator', 'simulator'],
    ['--adb-serial', 'adb_serial'],
  ]) {
    if (vars.resourceVars[key]) args.push(flag, vars.resourceVars[key]);
  }
  const writer = path.posix.join(operations.supportDir, 'scripts/write-runtime-context.sh');
  const command = `bash ${shellExpressionForRemotePath(writer)} --repo ${shellExpressionForRemotePath(vars.remoteRepo)} ${args.map(shellQuote).join(' ')}`;
  const result = await operations.writeContext(command);
  if (result.exitCode !== 0) {
    throw new Error(
      `Runtime context refresh failed for ${vars.slotId}: ${result.stderr || result.stdout || result.exitCode}. Next: farmslot slot prepare ${vars.slotId}`,
    );
  }
}

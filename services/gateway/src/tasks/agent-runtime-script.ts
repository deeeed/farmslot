import { currentFarmPaths, legacyRemoteFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { reportedFarmPaths } from '@farmslot/slot-config';
import path from 'node:path';

import { type ProjectVars, type SlotVars } from '../core/config.js';
import { isLocal } from '../core/exec.js';
import { expandTemplateWithReservedLast } from '../core/hooks.js';
import { nodeExecArgv } from '../fleet/node-rpc.js';

/** Resolve remote helpers from the connected node, which may be a dev deployment. */
export async function agentRuntimeScriptForSlot(
  vars: Pick<SlotVars, 'host' | 'machine'>,
  filename: string,
): Promise<string> {
  const report = reportedFarmPaths(vars.machine);
  if (report) return path.posix.join(report.code.agentRuntimeScripts, filename);
  if (isLocal(vars.host, vars.machine))
    return path.posix.join(
      currentFarmPaths('gateway').code.checkout,
      'packages/agent-runtime/scripts',
      filename,
    );

  // Omit cwd deliberately: the node's exec handler defaults to its installation
  // directory. Resolving in the product checkout or a guessed home directory
  // can select a different deployment's runtime.
  const result = await nodeExecArgv(
    vars.machine,
    [
      'node',
      '-e',
      'process.stdout.write(require.resolve(process.argv[1]))',
      `@farmslot/agent-runtime/scripts/${filename}`,
    ],
    undefined,
    { timeout: 10_000, maxBuffer: 16 * 1024 },
  );
  const script = result.stdout.trim();
  if (result.exitCode !== 0 || !path.posix.isAbsolute(script))
    throw new Error(
      `The connected node ${vars.machine} cannot resolve its agent-runtime helper ${filename}. ` +
        `Repair that node's runtime installation; no other deployment will be used.`,
    );
  return path.posix.join(
    legacyRemoteFarmPaths({}, undefined, path.posix.dirname(script)).code.agentRuntimeScripts,
    path.posix.basename(script),
  );
}

/** Framework-relative pack commands use the connected node's installation, too. */
export async function farmslotDirectoryForSlot(
  vars: Pick<SlotVars, 'host' | 'machine'>,
): Promise<string> {
  const report = reportedFarmPaths(vars.machine);
  if (report) return report.code.node;
  if (isLocal(vars.host, vars.machine)) return currentFarmPaths('gateway').code.checkout;
  const result = await nodeExecArgv(vars.machine, ['node', '-p', 'process.cwd()'], undefined, {
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  const directory = result.stdout.trim();
  if (result.exitCode !== 0 || !path.posix.isAbsolute(directory))
    throw new Error(
      `The connected node ${vars.machine} cannot resolve its Farmslot installation directory.`,
    );
  return legacyRemoteFarmPaths({}, directory).code.node;
}

export async function renderRoleTemplate(
  template: string,
  vars: SlotVars,
  projectVars: ProjectVars | undefined,
  replacements: Record<string, string>,
): Promise<string> {
  const farmslotDir = await farmslotDirectoryForSlot(vars);
  return expandTemplateWithReservedLast(template, vars, projectVars, replacements, {
    farmslot_dir: farmslotDir,
  });
}

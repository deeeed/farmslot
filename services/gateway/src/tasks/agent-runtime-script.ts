import path from 'node:path';

import { farmslotRoot, type SlotVars } from '../core/config.js';
import { isLocal } from '../core/exec.js';
import { nodeExecArgv } from '../fleet/node-rpc.js';

/** Resolve remote helpers from the connected node, which may be a dev deployment. */
export async function agentRuntimeScriptForSlot(
  vars: Pick<SlotVars, 'host' | 'machine'>,
  filename: string,
): Promise<string> {
  if (isLocal(vars.host, vars.machine))
    return path.posix.join(farmslotRoot, 'packages/agent-runtime/scripts', filename);

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
  return script;
}

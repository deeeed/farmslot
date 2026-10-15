import path from 'node:path';

import { farmslotRoot, type SlotVars } from '../core/config.js';
import { isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
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

export async function agentRuntimeCommandsForSlot(
  vars: Pick<SlotVars, 'host' | 'machine'>,
): Promise<{ AC_CMD: string; ARTIFACT_CHECK_CMD: string }> {
  const script = await agentRuntimeScriptForSlot(vars, 'acceptance-cli.cjs');
  const entry = path.posix.join(path.posix.dirname(script), '..', 'bin', 'farmslot-agent.mjs');
  const command = `node ${shellQuote(entry)}`;
  return { AC_CMD: `${command} ac`, ARTIFACT_CHECK_CMD: `${command} artifact-check` };
}

/** Framework-relative pack commands use the connected node's installation, too. */
export async function farmslotDirectoryForSlot(
  vars: Pick<SlotVars, 'host' | 'machine'>,
): Promise<string> {
  if (isLocal(vars.host, vars.machine)) return farmslotRoot;
  const result = await nodeExecArgv(vars.machine, ['node', '-p', 'process.cwd()'], undefined, {
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  const directory = result.stdout.trim();
  if (result.exitCode !== 0 || !path.posix.isAbsolute(directory))
    throw new Error(
      `The connected node ${vars.machine} cannot resolve its Farmslot installation directory.`,
    );
  return directory;
}

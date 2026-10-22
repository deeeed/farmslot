import type { ProjectVars, RawProjectJson } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { withMachineEnv } from '../core/project-env.js';

import { wrapWorkerShellCommand } from './launch-command.js';
import type { SlotVars } from './observability-types.js';
import { getRunnerDefinition, type RunnerDefinition } from './registry.js';
import { RunnerExecutionError } from './runner-execution-error.js';

/** Read only the runner's structured verdict; never forward credential-bearing diagnostics. */
export async function assertRunnerAuthBeforeLaunch(
  vars: SlotVars,
  runner: string,
  model: string | null | undefined,
  projectJson: RawProjectJson,
  projectVars?: ProjectVars,
  runDomain?: string | null,
  dependencies: { execute?: typeof execOnSlot; definition?: RunnerDefinition } = {},
): Promise<void> {
  const definition = dependencies.definition ?? getRunnerDefinition(runner);
  if (!definition.authCheck) return;
  const command = wrapWorkerShellCommand(withMachineEnv(definition.authCheck(vars, model), vars), {
    vars,
    projectJson,
    projectVars,
    runDomain,
  });
  const result = await (dependencies.execute ?? execOnSlot)(vars, command, { timeout: 30_000 });
  let status: unknown;
  let reason: unknown;
  try {
    const payload: unknown = JSON.parse(result.stdout);
    if (typeof payload === 'object' && payload !== null) {
      if ('status' in payload) status = payload.status;
      if ('reason' in payload) reason = payload.reason;
    }
  } catch {
    // A failed or old runner can exit before emitting its JSON contract.
    status = 'unavailable';
  }
  if (result.exitCode === 0 && status === 'ready') return;
  const knownReason = [
    'provider_not_found',
    'credentials_not_configured',
    'credential_not_available',
    'invalid_state',
  ].includes(String(reason))
    ? String(reason)
    : 'auth_check_unavailable';
  throw new RunnerExecutionError(
    `Runner ${definition.id} authentication failed before dispatch: ${knownReason}. Restore the provider login, then replay dispatch.`,
  );
}

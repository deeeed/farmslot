import type { ProjectVars, RawProjectJson } from '../core/config.js';
import { EXEC_TIMEOUT_EXIT_CODE, execOnSlot } from '../core/exec.js';
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
  const check = async () => {
    const result = await (dependencies.execute ?? execOnSlot)(vars, command, {
      timeout: AUTH_CHECK_TIMEOUT_MS,
    });
    let verdict: Record<string, unknown> | undefined;
    try {
      const payload: unknown = JSON.parse(result.stdout);
      if (typeof payload === 'object' && payload !== null && !Array.isArray(payload))
        verdict = payload as Record<string, unknown>;
    } catch {
      // A failed or old runner can exit before emitting its JSON contract.
    }
    return { exitCode: result.exitCode, verdict };
  };
  const timedOut = (attempt: Awaited<ReturnType<typeof check>>) =>
    attempt.exitCode === EXEC_TIMEOUT_EXIT_CODE || attempt.verdict?.cause === 'timeout';
  // A slow provider or node network can outlast one check; only a second timeout fails dispatch.
  let attempt = await check();
  if (timedOut(attempt)) attempt = await check();
  const { exitCode, verdict } = attempt;
  if (exitCode === 0 && verdict?.status === 'ready') return;
  const reason = String(verdict?.reason);
  if (KNOWN_REASONS.includes(reason))
    throw new RunnerExecutionError(
      `Runner ${definition.id} authentication failed before dispatch: ${reason}. Restore the provider login, then replay dispatch.`,
    );
  throw new RunnerExecutionError(
    `Runner ${definition.id} authentication failed before dispatch: auth_check_unavailable (${unavailableCause(exitCode, verdict)}). Check the node and the runner, then replay dispatch.`,
  );
}

const AUTH_CHECK_TIMEOUT_MS = 30_000;
const KNOWN_REASONS = [
  'provider_not_found',
  'credentials_not_configured',
  'credential_not_available',
  'invalid_state',
];
/** Causes the runner's check may name. Its output itself is never shown: it can carry credentials. */
const RUNNER_CAUSES: Record<string, string> = {
  timeout: "the runner's own auth check timed out, twice",
  not_found: 'the runner executable was not found',
  failed: "the runner's auth check failed",
  no_verdict: "the runner's auth check gave no verdict",
};

function unavailableCause(exitCode: number, verdict: Record<string, unknown> | undefined): string {
  if (exitCode === EXEC_TIMEOUT_EXIT_CODE)
    return `the check timed out after ${AUTH_CHECK_TIMEOUT_MS / 1000} s, twice`;
  if (!verdict) return `the check exited ${exitCode} without a verdict`;
  const cause = RUNNER_CAUSES[String(verdict.cause)];
  const runnerExit = Number.isInteger(verdict.exitCode) ? ` (exit ${verdict.exitCode})` : '';
  if (cause) return `${cause}${runnerExit}`;
  if (verdict.status === 'ready') return `the check reported ready but exited ${exitCode}`;
  return ['not_ready', 'invalid'].includes(String(verdict.status))
    ? `the check reported ${verdict.status} without a known reason`
    : `the check exited ${exitCode} with an unknown verdict`;
}

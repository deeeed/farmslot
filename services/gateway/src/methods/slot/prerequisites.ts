import {
  execOnSlot,
  expandHook,
  type ProjectVars,
  type RawProjectJson,
  type SlotVars,
  withProjectMachineEnv,
} from '../../core/index.js';

import type { CheckStep } from './shared.js';

/** Read-only project requirements run before prepare changes and in slot.check. */
export async function checkProjectPrerequisites(
  vars: SlotVars,
  projectJson: RawProjectJson,
  projectVars?: ProjectVars,
  domain = vars.domain,
  execute: typeof execOnSlot = execOnSlot,
): Promise<CheckStep | null> {
  const hook = expandHook('prerequisites', projectJson, vars, projectVars);
  if (!hook) return null;
  const command = withProjectMachineEnv(hook, vars, projectJson, projectVars, domain);
  const result = await execute(vars, command, { timeout: 10_000, selectNodeSupport: false });
  return {
    name: 'prerequisites',
    status: result.exitCode === 0 ? 'pass' : 'fail',
    detail:
      (result.exitCode === 0 ? result.stdout : result.stderr || result.stdout).trim() ||
      `Project prerequisites ${result.exitCode === 0 ? 'passed' : `failed (exit ${result.exitCode})`} on ${vars.machine}`,
  };
}

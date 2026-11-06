import type { ProjectConfig, ScriptedRunnerConfig } from '@farmslot/protocol';

import { loadProjectVars, type RawProjectJson } from '../core/config.js';

export interface ResolvedScriptedCommand {
  command: string;
  timeoutMs?: number;
  cwd?: string;
}

export function scriptedScenariosEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS === '1';
}

export function assertScriptedRunnerConfig(params: {
  runner?: string | null;
  scripted?: ScriptedRunnerConfig | null;
  projectName: string;
  projectConfig?: Pick<ProjectConfig, 'scripted'> | null;
  env?: NodeJS.ProcessEnv;
}): void {
  if (params.runner !== 'scripted') {
    if (params.scripted) throw new Error("scripted config is only allowed when runner='scripted'");
    return;
  }
  const scripted = params.scripted;
  if (!scripted) throw new Error("runner='scripted' requires a scripted config");
  if (scripted.mode === 'scenario') {
    if (!scriptedScenariosEnabled(params.env)) {
      throw new Error('scripted scenario mode requires FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1');
    }
    if (
      ![
        'success',
        'failure',
        'timeout',
        'silent',
        'late-ack',
        'commit-out-of-band',
        'edit-forbidden-file',
      ].includes(scripted.scenario)
    ) {
      throw new Error(
        `Unsupported scripted scenario: ${(scripted as { scenario?: string }).scenario}`,
      );
    }
    if (
      scripted.promptScenario !== undefined &&
      !['success', 'edit-forbidden-file'].includes(scripted.promptScenario)
    )
      throw new Error('Unsupported scripted.promptScenario');
    if (
      scripted.stepDelayMs !== undefined &&
      (!Number.isInteger(scripted.stepDelayMs) || scripted.stepDelayMs < 0)
    ) {
      throw new Error('scripted.stepDelayMs must be a non-negative integer');
    }
    return;
  }
  if (scripted.mode === 'command') {
    if (!scripted.commandRef?.trim()) throw new Error('scripted.commandRef is required');
    resolveScriptedCommandFromProjectConfig(
      scripted.commandRef,
      params.projectConfig,
      params.projectName,
    );
    if (
      scripted.timeoutMs !== undefined &&
      (!Number.isInteger(scripted.timeoutMs) || scripted.timeoutMs <= 0)
    ) {
      throw new Error('scripted.timeoutMs must be a positive integer');
    }
    return;
  }
  throw new Error(`Unsupported scripted mode: ${(scripted as { mode?: string }).mode}`);
}

export function resolveScriptedCommandFromProjectConfig(
  commandRef: string,
  projectConfig: Pick<ProjectConfig, 'scripted'> | null | undefined,
  projectName: string,
): ResolvedScriptedCommand {
  const command = projectConfig?.scripted?.commands?.[commandRef];
  if (!command?.command?.trim()) {
    throw new Error(
      `scripted commandRef '${commandRef}' is not declared for project ${projectName}`,
    );
  }
  return {
    command: command.command,
    ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
    ...(command.cwd ? { cwd: command.cwd } : {}),
  };
}

export function resolveScriptedCommandFromRawProjectJson(
  commandRef: string,
  projectJson: RawProjectJson,
  projectName: string,
): ResolvedScriptedCommand {
  const raw = projectJson.scripted?.commands?.[commandRef];
  if (!raw?.command?.trim()) {
    throw new Error(
      `scripted commandRef '${commandRef}' is not declared for project ${projectName}`,
    );
  }
  const timeoutMs = raw.timeout_ms ?? raw.timeoutMs;
  return {
    command: raw.command,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(raw.cwd?.trim() ? { cwd: raw.cwd } : {}),
  };
}

/** The project command a run's scripted config names; none for another runner or a scenario. */
export function scriptedCommandForRunner(
  runner: string,
  scripted: ScriptedRunnerConfig | null | undefined,
  projectJson: RawProjectJson,
  projectName: string,
): ResolvedScriptedCommand | undefined {
  return runner === 'scripted' && scripted?.mode === 'command'
    ? resolveScriptedCommandFromRawProjectJson(scripted.commandRef, projectJson, projectName)
    : undefined;
}

/** A relaunch's scripted options: a scripted worker keeps the config dispatch launched it with. */
export async function scriptedRelaunchOptions(
  runner: string,
  run: { project: string; scripted?: ScriptedRunnerConfig | null } | null | undefined,
): Promise<{ scripted?: ScriptedRunnerConfig; scriptedCommand?: ResolvedScriptedCommand }> {
  const scripted = runner === 'scripted' ? run?.scripted : undefined;
  if (!run || !scripted) return {};
  if (scripted.mode !== 'command') return { scripted };
  const { projectJson } = await loadProjectVars(run.project);
  const scriptedCommand = scriptedCommandForRunner(runner, scripted, projectJson, run.project);
  return { scripted, ...(scriptedCommand ? { scriptedCommand } : {}) };
}

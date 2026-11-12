import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

import {
  collectPlaceholderTokens,
  type NativeWorkerSessionBinding,
  type RunnerSessionUsage,
} from '@farmslot/protocol';
import { loadLiteLlmPrices } from '@farmslot/slot-config';

import {
  loadMachinePool,
  loadProjectVars,
  loadSlotVars,
  SlotConfigError,
  type SlotVars,
} from '../core/config.js';
import {
  machineShellEnv,
  projectCommandEnvOptions,
  resolveProjectCommandEnv,
} from '../core/project-env.js';
import {
  nativeSessionUsageArgv,
  type NativeSessionUsageIdentity,
  type NativeSessionUsageRequest,
} from '../runners/native-session-usage-command.js';
import { getRunnerSessionUsageProvider } from '../runners/registry.js';

import { parseSessionUsageOutput, unavailableRunnerSessionUsage } from './session-usage-result.js';

const execute = promisify(execFile);
type NativeSessionUsageVars =
  | SlotVars
  | (Pick<SlotVars, 'remoteRepo' | 'slotId'> & Partial<Pick<SlotVars, 'projectName' | 'domain'>>);

export interface NativeAgentUsageInput {
  vars: NativeSessionUsageVars;
  runner: string;
  runnerSessionId: string | null;
  runnerSessionPath?: string | null;
  nativeSession?: NativeSessionUsageIdentity & Partial<NativeWorkerSessionBinding>;
}

export async function extractNativeAgentSessionUsage(
  input: NativeAgentUsageInput,
): Promise<RunnerSessionUsage> {
  const { runner, runnerSessionId, nativeSession, vars } = input;
  const unavailable = (error: string) =>
    unavailableRunnerSessionUsage({ runner, runnerSessionId, error });
  if (!nativeSession || !runnerSessionId)
    return unavailable('Agent session has no recorded native conversation identity');
  const provider = getRunnerSessionUsageProvider(runner);
  if (!provider) return unavailable('Agent session has no transcript accounting provider');
  const request: NativeSessionUsageRequest = {
    key: 'review',
    runner,
    provider: provider.id,
    runnerSessionId,
    cwd: vars.remoteRepo,
    slotId: vars.slotId,
    sessionPath: input.runnerSessionPath,
    nativeSession: {
      sessionId: nativeSession.sessionId,
      ownerPrincipalId: nativeSession.ownerPrincipalId,
      executionNodeId: nativeSession.executionNodeId,
      stateDirectory: nativeSession.stateDirectory,
    },
  };
  try {
    const machine =
      nativeSession.executionNodeId === 'local'
        ? os.hostname().split('.')[0]
        : nativeSession.executionNodeId;
    const poolEnv =
      'machine' in vars && vars.machine === machine && vars.machineEnv !== undefined
        ? vars.machineEnv
        : await loadMachinePool(machine)
            .then((pool) => pool.env)
            .catch((error: unknown) => {
              // Retained native sessions can outlive their pool registration. With no pool,
              // project/process pricing still applies; malformed or unreadable pools remain errors.
              if (error instanceof SlotConfigError && error.code === 'SLOT_NOT_FOUND') return {};
              throw error;
            });
    const environment = { ...process.env };
    if (vars.projectName) {
      const project = await loadProjectVars(vars.projectName);
      const domainEnvironment = vars.domain
        ? project.projectJson.command_env?.domains?.[vars.domain]
        : undefined;
      // Literal environments still work after a retained session's slot is removed.
      const needsSlotContext = Object.values(domainEnvironment?.set ?? {}).some(
        (value) => collectPlaceholderTokens(value).size > 0,
      );
      const options = needsSlotContext
        ? projectCommandEnvOptions(
            'resourceVars' in vars ? vars : await loadSlotVars(vars.slotId),
            project,
            vars.domain,
          )
        : { domain: vars.domain };
      const mutation = resolveProjectCommandEnv(project.projectJson, options);
      for (const name of mutation.unset) delete environment[name];
      Object.assign(environment, mutation.set);
    }
    Object.assign(environment, machineShellEnv({ machineEnv: poolEnv }));
    request.liteLlmPrices = [...(await loadLiteLlmPrices({ environment }))];
    const argv = nativeSessionUsageArgv([request]);
    const result =
      nativeSession.executionNodeId === 'local'
        ? await execute(process.execPath, argv.slice(1), {
            timeout: 30000,
            maxBuffer: 64 * 1024,
            env: { ...process.env, FORCE_COLOR: '0' },
            encoding: 'utf8',
          })
        : await (
            await import('../runners/native/node.js')
          ).execNativeNodeArgv(
            nativeSession.ownerPrincipalId,
            nativeSession.executionNodeId,
            argv,
            30000,
          );
    if ('exitCode' in result && result.exitCode !== 0)
      return unavailable(result.stderr || 'Agent session accounting command failed');
    const rows: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(rows) || rows.length !== 1)
      return unavailable('Invalid agent session accounting response');
    const row: unknown = rows[0];
    if (
      !row ||
      typeof row !== 'object' ||
      !('key' in row) ||
      row.key !== request.key ||
      !('runnerSessionId' in row) ||
      row.runnerSessionId !== runnerSessionId
    )
      return unavailable('Agent session accounting response identity changed');
    if ('error' in row && typeof row.error === 'string') return unavailable(row.error);
    if (
      !('sessionPath' in row) ||
      typeof row.sessionPath !== 'string' ||
      !('output' in row) ||
      typeof row.output !== 'string'
    )
      return unavailable('Agent session accounting response lacks a transcript result');
    return parseSessionUsageOutput(row.output, {
      runner,
      runnerSessionId,
      runnerSessionPath: row.sessionPath,
    });
  } catch (error) {
    // Supporting accounting must not change lifecycle outcomes when history is unavailable.
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

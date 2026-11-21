import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

import type { ChecklistMark } from '@farmslot/agent-runtime/tool-usage';
import {
  collectPlaceholderTokens,
  type NativeWorkerSessionBinding,
  type Run,
  type RunnerSessionUsage,
} from '@farmslot/protocol';
import { loadLiteLlmPrices, type SessionUsageWindow } from '@farmslot/slot-config';

import {
  loadMachinePool,
  loadProjectVars,
  loadSlotVars,
  SlotConfigError,
  type SlotVars,
} from '../core/config.js';
import {
  machineShellEnv,
  type ProjectCommandEnvOptions,
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
const LOCAL_NATIVE_RECEIPT_BYTES = 64 * 1024;

/** Retain this run's task leases; the node journal supplies accounting timestamps. */
export function nativeRunUsageWindow(
  run: Run,
  session: Pick<
    RunnerSessionUsage,
    | 'runner'
    | 'runnerSessionId'
    | 'startedAt'
    | 'completedAt'
    | 'usageLeaseIds'
    | 'pendingUsageLeaseIds'
  >,
): SessionUsageWindow {
  const starts = [
    session.startedAt,
    ...(run.sessionUsage ?? [])
      .filter(
        (row) => row.runner === session.runner && row.runnerSessionId === session.runnerSessionId,
      )
      .map((row) => row.startedAt),
  ]
    .filter((value): value is string => !!value && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const nativeLeaseIds = [
    ...new Set([
      ...(session.usageLeaseIds ?? []),
      ...(session.pendingUsageLeaseIds ?? []),
      ...(run.sessionUsage ?? [])
        .filter(
          (row) => row.runner === session.runner && row.runnerSessionId === session.runnerSessionId,
        )
        .flatMap((row) => [...(row.usageLeaseIds ?? []), ...(row.pendingUsageLeaseIds ?? [])]),
      ...(run.agentContexts ?? [])
        .filter(
          (row) => row.runner === session.runner && row.runnerSessionId === session.runnerSessionId,
        )
        .flatMap((row) => [row.nativeSession, ...(row.nativeSessionHistory ?? [])])
        .flatMap((binding) => (binding ? [binding.leaseId] : [])),
    ]),
  ];
  if (!nativeLeaseIds.length)
    throw new Error('Native run usage has no recorded task lease boundary');
  // Lifecycle timestamps remain metadata. The node replaces them with journal boundaries.
  return {
    startedAt: starts[0] ?? run.createdAt,
    completedAt: session.completedAt ?? undefined,
    nativeLeaseIds,
  };
}
type NativeSessionUsageVars =
  | SlotVars
  | (Pick<SlotVars, 'remoteRepo' | 'slotId'> & Partial<Pick<SlotVars, 'projectName' | 'domain'>>);

export interface NativeAgentUsageInput {
  vars: NativeSessionUsageVars;
  commandEnvOptions?: ProjectCommandEnvOptions;
  runner: string;
  runnerSessionId: string | null;
  runnerSessionPath?: string | null;
  nativeSession?: NativeSessionUsageIdentity & Partial<NativeWorkerSessionBinding>;
  usageWindow?: SessionUsageWindow;
  checklistMarks?: ChecklistMark[];
  parentChecklistMarks?: ChecklistMark[];
}

interface NativeAgentUsageResolution {
  usage: RunnerSessionUsage;
  usageWindow?: SessionUsageWindow;
  verifiedLeaseIds?: string[];
}

/**
 * The gateway-side environment a session's commands run with, for its LiteLLM prices: this process,
 * the project's command env and the machine's pool env. The execution node itself may hold no
 * LiteLLM credentials.
 */
export async function usageLiteLlmEnvironment(
  vars: NativeSessionUsageVars,
  machine: string,
  commandEnvOptions?: ProjectCommandEnvOptions,
): Promise<NodeJS.ProcessEnv> {
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
    const options =
      commandEnvOptions ??
      (needsSlotContext
        ? projectCommandEnvOptions(
            'resourceVars' in vars ? vars : await loadSlotVars(vars.slotId),
            project,
            vars.domain,
          )
        : { domain: vars.domain });
    const mutation = resolveProjectCommandEnv(project.projectJson, options);
    for (const name of mutation.unset) delete environment[name];
    Object.assign(environment, mutation.set);
  }
  Object.assign(environment, machineShellEnv({ machineEnv: poolEnv }));
  return environment;
}

export async function extractNativeAgentSessionUsage(
  input: NativeAgentUsageInput,
): Promise<RunnerSessionUsage> {
  return (await resolveNativeAgentSessionUsage(input)).usage;
}

/** Keep node-resolved boundaries even when the original transcript has been pruned. */
export async function resolveNativeAgentSessionUsage(
  input: NativeAgentUsageInput,
): Promise<NativeAgentUsageResolution> {
  const { runner, runnerSessionId, nativeSession, vars } = input;
  let usageWindow: SessionUsageWindow | undefined;
  let verifiedLeaseIds: string[] | undefined;
  const unavailable = (error: string): NativeAgentUsageResolution => ({
    usage: unavailableRunnerSessionUsage({ runner, runnerSessionId, error }),
    usageWindow,
    verifiedLeaseIds,
  });
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
    usageWindow: input.usageWindow,
    checklistMarks: input.checklistMarks,
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
    request.liteLlmPrices = [
      ...(await loadLiteLlmPrices({
        environment: await usageLiteLlmEnvironment(vars, machine, input.commandEnvOptions),
      })),
    ];
    const local = nativeSession.executionNodeId === 'local';
    if (local) request.parentChecklistMarks = input.parentChecklistMarks;
    const argv = nativeSessionUsageArgv(
      [request],
      undefined,
      local ? LOCAL_NATIVE_RECEIPT_BYTES : undefined,
    );
    const result = local
      ? await execute(process.execPath, argv.slice(1), {
          timeout: 30000,
          maxBuffer: LOCAL_NATIVE_RECEIPT_BYTES,
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
    let resolvedWindow: SessionUsageWindow | undefined;
    if ('usageWindow' in row && row.usageWindow !== undefined) {
      const window = row.usageWindow;
      if (
        !window ||
        typeof window !== 'object' ||
        'nativeLeaseIds' in window ||
        !('startedAt' in window) ||
        typeof window.startedAt !== 'string' ||
        !Number.isFinite(Date.parse(window.startedAt)) ||
        ('completedAt' in window &&
          (typeof window.completedAt !== 'string' ||
            !Number.isFinite(Date.parse(window.completedAt)) ||
            Date.parse(window.completedAt) < Date.parse(window.startedAt)))
      )
        return unavailable('Invalid node-resolved usage window');
      resolvedWindow = {
        startedAt: window.startedAt,
        ...('completedAt' in window && typeof window.completedAt === 'string'
          ? { completedAt: window.completedAt }
          : {}),
      };
    }
    const requestedLeases = input.usageWindow?.nativeLeaseIds;
    if (requestedLeases && resolvedWindow) {
      const coveredLeases = new Set<string>();
      const resolvedLeases = 'capturedLeaseIds' in row ? row.capturedLeaseIds : undefined;
      if (!Array.isArray(resolvedLeases) || !resolvedLeases.length)
        return unavailable('Native accounting response lacks verified task lease coverage');
      for (const lease of resolvedLeases) {
        if (typeof lease !== 'string' || !requestedLeases.includes(lease))
          return unavailable('Native accounting response names an unrequested task lease');
        coveredLeases.add(lease);
      }
      verifiedLeaseIds = [...coveredLeases];
    }
    usageWindow = resolvedWindow;
    if ('error' in row && typeof row.error === 'string') return unavailable(row.error);
    if (input.usageWindow && !usageWindow)
      return unavailable('Native accounting response lacks a resolved usage window');
    if (
      !('sessionPath' in row) ||
      typeof row.sessionPath !== 'string' ||
      !('output' in row) ||
      typeof row.output !== 'string'
    )
      return unavailable('Agent session accounting response lacks a transcript result');
    const usage = parseSessionUsageOutput(row.output, {
      runner,
      runnerSessionId,
      runnerSessionPath: row.sessionPath,
    });
    return {
      usage: {
        ...usage,
        ...(input.usageWindow ? { startedAt: input.usageWindow.startedAt } : {}),
        ...(verifiedLeaseIds ? { usageLeaseIds: verifiedLeaseIds } : {}),
        scope: input.usageWindow ? 'run-delta' : 'session-total',
      },
      usageWindow,
      verifiedLeaseIds,
    };
  } catch (error) {
    // Supporting accounting must not change lifecycle outcomes when history is unavailable.
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

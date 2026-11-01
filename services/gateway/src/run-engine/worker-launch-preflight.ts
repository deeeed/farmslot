import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  isRecord,
  Methods,
  PROTOCOL_VERSION,
  type Run,
  type SubStepRecord,
} from '@farmslot/protocol';
import { currentProjectSources } from '@farmslot/slot-config';

import {
  farmslotRoot,
  getOrchestratorTaskRoot,
  loadProjectVars,
  loadSlotVars,
  type ProjectVars,
  resolveProjectTaskDirName,
  resolveTaskRelDir,
  type SlotVars,
} from '../core/config.js';
import { EXEC_TIMEOUT_EXIT_CODE, execOnSlot } from '../core/exec.js';
import { withMachineEnv } from '../core/project-env.js';
import { readSlotRow } from '../core/state.js';
import { shellQuote } from '../core/tmux.js';
import { getNode } from '../fleet/machine-registry.js';
import { runtimeCapabilityStatus } from '../methods/runtime-capabilities.js';
import { wrapWorkerShellCommand } from '../runners/launch-command.js';
import { routeNativeExecution } from '../runners/native/node.js';
import { getRun, updateRunStep } from '../runs/store.js';
import { verifyExecutionSources } from '../sources/runtime.js';
import { agentRuntimeScriptForSlot } from '../tasks/agent-runtime-script.js';

import { isTerminalTeardownInFlight } from './terminal-teardown-registry.js';
import { inspectWorkerLaunchLeftovers } from './worker-leftovers-preflight.js';
import { type LaunchProbeResult, runLaunchPreflight } from './worker-preflight.js';
import { workerSourceProbeCommand } from './worker-source-preflight.js';
import {
  checkToolchainObservation,
  parseToolchainObservation,
  readLaunchPackPins,
  toolchainProbeCommand,
} from './worker-toolchain-preflight.js';

function probeResult(raw: string): LaunchProbeResult {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    typeof value.detail !== 'string' ||
    (value.status !== 'verified' && value.status !== 'mismatch' && value.status !== 'unverified')
  )
    return { status: 'unverified', detail: 'Probe response is unavailable or invalid.' };
  return {
    status: value.status,
    detail: value.detail,
    ...(value.retry === false ? { retry: false } : {}),
  };
}

async function packageVersion(name: string): Promise<string> {
  const value: unknown = JSON.parse(
    await readFile(path.join(farmslotRoot, 'packages', name, 'package.json'), 'utf8'),
  );
  if (!isRecord(value) || typeof value.version !== 'string')
    throw new Error(`Missing ${name} package version`);
  return value.version;
}

function workerTaskDir(run: Run | undefined, vars: SlotVars, project: ProjectVars): string | null {
  if (!run?.taskFile) return null;
  const relative = resolveTaskRelDir(
    run.taskFile,
    getOrchestratorTaskRoot(run.project, project.projectJson),
  );
  return relative === null
    ? null
    : path.posix.join(vars.remoteRepo, resolveProjectTaskDirName(project.projectJson), relative);
}

/**
 * The slot's or project's configured launch inputs changed while the launch was being checked
 * (a pool or project file rewrite). Nothing launched; a fresh attempt re-reads the inputs.
 */
export class WorkerLaunchInputsChangedError extends Error {
  override name = 'WorkerLaunchInputsChangedError';
}

export interface WorkerLaunchPreflightInput {
  runId?: string;
  vars: SlotVars;
  projectVars?: ProjectVars;
  assertCurrent?: () => void;
  record?: (name: string, detail: string, outcome: SubStepRecord['outcome']) => void;
  wrapCommand?: (command: string) => string;
  environment?: { set: Record<string, string>; unset: string[] };
}

/** Returns the same binding fence for the launch owner's final irreversible boundary. */
export async function admitWorkerLaunch(
  input: WorkerLaunchPreflightInput,
): Promise<() => Promise<void>> {
  const initial = input.runId ? getRun(input.runId) : undefined;
  const snapshot = initial
    ? structuredClone({
        slotId: initial.slotId,
        taskFile: initial.taskFile,
        activeTaskFile: initial.activeTaskFile,
        generation: initial.engineState?.generation ?? 0,
        status: initial.status,
        sourceProvenance: initial.sourceProvenance,
        sourcePlan: initial.sourcePlan,
      })
    : null;
  // Native callers resolve the checkout path before admission. Fence the configured inputs
  // against the same configured representation, while probing the actual launch path.
  const originalVars = structuredClone(await loadSlotVars(input.vars.slotId));
  const project = input.projectVars ?? (await loadProjectVars(input.vars.projectName));
  const originalConfig = structuredClone(project.projectJson);
  const assertRunCurrent = () => {
    input.assertCurrent?.();
    const current = input.runId ? getRun(input.runId) : undefined;
    if (
      snapshot &&
      (!current ||
        !isDeepStrictEqual(snapshot, {
          slotId: current.slotId,
          taskFile: current.taskFile,
          activeTaskFile: current.activeTaskFile,
          generation: current.engineState?.generation ?? 0,
          status: current.status,
          sourceProvenance: current.sourceProvenance,
          sourcePlan: current.sourcePlan,
        }))
    )
      throw new Error(
        'Worker launch preflight was superseded; retry under the current run generation.',
      );
  };
  const assertCurrent = async () => {
    assertRunCurrent();
    const vars = await loadSlotVars(input.vars.slotId);
    const latestProject = await loadProjectVars(input.vars.projectName);
    if (
      !isDeepStrictEqual(vars, originalVars) ||
      !isDeepStrictEqual(latestProject.projectJson, originalConfig)
    )
      throw new WorkerLaunchInputsChangedError(
        'Worker launch inputs changed during preflight; retry this run with its current slot/source selection.',
      );
    const slot = await readSlotRow(input.vars.slotId);
    if (slot?.current_run_id && slot.current_run_id !== input.runId)
      throw new Error(
        `Worker launch slot ${input.vars.slotId} is now owned by ${slot.current_run_id}; this attempt cannot launch.`,
      );
    assertRunCurrent();
  };
  const inShell = (command: string): string => {
    const body = `cd ${shellQuote(input.vars.remoteRepo)} && ${command}`;
    if (input.environment) {
      const env = input.environment;
      return [
        ...(env.unset.length ? [`unset ${env.unset.map(shellQuote).join(' ')}`] : []),
        ...Object.entries(env.set).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
        body,
      ].join(' && ');
    }
    if (input.wrapCommand) return input.wrapCommand(body);
    return wrapWorkerShellCommand(withMachineEnv(body, input.vars), {
      vars: input.vars,
      projectVars: project,
      projectJson: project.projectJson,
      runDomain: initial?.domain,
    });
  };
  const execute = async (command: string, signal: AbortSignal, timeout: number) => {
    const result = await execOnSlot(input.vars, inShell(command), {
      signal,
      timeout,
      selectNodeSupport: false,
    });
    if (result.exitCode === EXEC_TIMEOUT_EXIT_CODE || signal.aborted)
      return {
        status: 'unverified',
        detail: 'Execution host probe timed out.',
      } satisfies LaunchProbeResult;
    if (result.exitCode !== 0)
      return {
        status: 'unverified',
        detail: `Execution host probe exited ${result.exitCode}: ${result.stderr.trim()}`,
      } satisfies LaunchProbeResult;
    return result.stdout;
  };
  const probeDetails = new Map<string, string>();
  await runLaunchPreflight(
    [
      {
        name: 'code',
        inspect: async (signal, timeout) => {
          const node = getNode(input.vars.machine);
          if (node?.versionMatch === false)
            return {
              status: 'mismatch',
              detail: `${input.vars.machine} node wire ${node.protocolVersion}; expected ${PROTOCOL_VERSION}. Update the selected node through the supported route, then retry.`,
            };
          const sources = currentProjectSources() ?? project.sourceContext;
          if (sources) {
            try {
              await verifyExecutionSources(
                input.vars.machine,
                sources.execution ?? sources.materialization,
              );
            } catch (error) {
              if (error instanceof Error && error.message.startsWith('Source drift:'))
                return {
                  status: 'mismatch',
                  detail: `${error.message}. Repair the admitted source through its existing owner and retry this run.`,
                };
              throw error;
            }
          }
          const command = workerSourceProbeCommand({
            cliVersion: await packageVersion('cli'),
            protocolVersion: await packageVersion('protocol'),
            wireVersion: PROTOCOL_VERSION,
            runtimeScript: await agentRuntimeScriptForSlot(input.vars, 'task-init-cli.mjs'),
            taskDir: workerTaskDir(initial, input.vars, project),
          });
          const result = await execute(command, signal, timeout);
          return typeof result === 'string' ? probeResult(result) : result;
        },
      },
      {
        name: 'toolchain',
        inspect: async (signal, timeout) => {
          const pins = await readLaunchPackPins({
            fixturesDir: project.projectFixturesDir,
            bound: Boolean(currentProjectSources() ?? project.sourceContext),
          });
          const result = await execute(toolchainProbeCommand(pins ?? ''), signal, timeout);
          if (typeof result !== 'string') return result;
          const raw: unknown = JSON.parse(result);
          if (isRecord(raw) && raw.nodeMissing === true)
            return {
              status: 'mismatch',
              detail: `${input.vars.slotId} launch shell has no Node. Run the selected pack setup/check-paths and retry.`,
            };
          const observation = parseToolchainObservation(result);
          return observation
            ? checkToolchainObservation(observation, input.vars.slotId, pins !== null)
            : { status: 'unverified', detail: 'Toolchain observation is invalid.' };
        },
      },
      {
        name: 'leftovers',
        inspect: async () =>
          initial
            ? inspectWorkerLaunchLeftovers(initial, {
                cleanupInFlight: isTerminalTeardownInFlight,
                readSlot: readSlotRow,
                capabilities: (slotId, ownerRunId) =>
                  runtimeCapabilityStatus({ slotId, ownerRunId }),
                readNative: (binding) =>
                  routeNativeExecution(binding.ownerPrincipalId, Methods.NATIVE_SESSION_READ, {
                    executionNodeId: binding.executionNodeId,
                    sessionId: binding.sessionId,
                    limit: 1,
                  }),
              })
            : {
                status: 'unverified',
                detail: 'No persisted run attempt owns this launch.',
                retry: false,
              },
      },
    ],
    {
      assertCurrent,
      record: (name, result, attempts, elapsedMs) => {
        const detail = `${input.vars.slotId} ${result.status}: ${result.detail} [attempts=${attempts}, elapsed=${Math.round(elapsedMs)}ms]`;
        const probeName = `preflight-${name}`;
        probeDetails.set(probeName, detail);
        const outcome =
          result.status === 'verified' ? 'ok' : result.status === 'mismatch' ? 'failed' : 'skipped';
        input.record?.(probeName, detail, outcome);
        if (input.runId) {
          const current = getRun(input.runId);
          const active =
            current?.steps.find((step) => step.status === 'running') ??
            current?.steps.find((step) => step.name === 'dispatch');
          // Relaunches have no dispatch collector. Keep their evidence on the dispatch
          // step so completing the current review/watch step cannot replace it.
          const durable = !input.record
            ? (current?.steps.find((step) => step.name === 'dispatch') ?? active)
            : undefined;
          if (durable)
            updateRunStep(input.runId, durable.name, {
              outputs: {
                ...durable.outputs,
                subSteps: [
                  ...(Array.isArray(durable.outputs?.subSteps)
                    ? durable.outputs.subSteps
                    : []
                  ).filter((entry: unknown) => !isRecord(entry) || entry.name !== probeName),
                  { name: probeName, outcome, detail, durationMs: Math.round(elapsedMs) },
                ],
              },
            });
          if (active)
            updateRunStep(input.runId, active.name, {
              detail: [...probeDetails].map(([probe, value]) => `${probe}: ${value}`).join('\n'),
            });
        }
      },
    },
  );
  return assertCurrent;
}

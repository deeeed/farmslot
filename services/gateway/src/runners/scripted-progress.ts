import path from 'node:path';

import { isRecord, primaryRoleForFlow } from '@farmslot/protocol';

import { slotFileExists, slotReadFile, slotStat } from '../core/slot-io.js';
import { normalizeWorkerSignal, parseStrictIsoMs } from '../tasks/worker-signals.js';

import type { MonitorProgressKind } from './observability-progress.js';
import type { RunnerTaskProgressInput } from './observability-types.js';
import { type ResolvedScriptedCommand, scriptedRelaunchOptions } from './scripted-config.js';

async function declaredCommand(input: RunnerTaskProgressInput): Promise<ResolvedScriptedCommand> {
  const { scriptedCommand } = await scriptedRelaunchOptions('scripted', input.run);
  if (!scriptedCommand) throw new Error('Command mode is required');
  return scriptedCommand;
}

/** The command a scripted run declared; cwd is checked when the caller resolved it. */
export interface ScriptedCommandExpectation {
  project: string;
  commandRef: string;
  cwd?: string;
}

/**
 * Why the scripted runner's result record does not prove a successful run of the
 * expected command, or null when it does. The one judgment of that record: the
 * progress probe and the terminal contract both use it.
 */
export function scriptedCommandResultRefusal(
  result: unknown,
  expected: ScriptedCommandExpectation,
): string | null {
  if (!isRecord(result)) return 'the scripted command result is not a JSON object';
  if (result.project !== expected.project || result.commandRef !== expected.commandRef)
    return `the scripted command result is not for ${expected.project}/${expected.commandRef}`;
  if (expected.cwd !== undefined && result.cwd !== expected.cwd)
    return 'the scripted command result ran in another directory';
  if (result.timedOut !== false)
    return `scripted command '${expected.commandRef}' timed out or did not record completion`;
  if (result.signal !== null)
    return `scripted command '${expected.commandRef}' was ended by signal ${String(result.signal)}`;
  if (result.exitCode !== 0)
    return `scripted command '${expected.commandRef}' exited ${String(result.exitCode)}`;
  return null;
}

/** A terminal child result and its current monitor receipt prove command completion. */
export async function readScriptedCommandProgress(
  input: RunnerTaskProgressInput,
  command: typeof declaredCommand = declaredCommand,
): Promise<MonitorProgressKind | null> {
  const { run, context, vars } = input;
  if (run.scripted?.mode !== 'command') return null;
  const dispatch = run.steps.find((step) => step.name === 'dispatch');
  const monitor = run.steps.find((step) => step.name === 'monitor');
  const observed = normalizeWorkerSignal(monitor?.outputs?.workerSignal);
  if (
    !context ||
    (context.role !== 'primary' && context.role !== primaryRoleForFlow(run.flowType)) ||
    context.runId !== run.id ||
    context.slotId !== vars.slotId ||
    run.slotId !== vars.slotId ||
    run.project !== vars.projectName ||
    dispatch?.status !== 'done' ||
    monitor?.status !== 'done' ||
    !observed.ok ||
    !['complete', 'done'].includes(observed.signal.status) ||
    observed.signal.outcome !== 'success' ||
    observed.signal.contextId !== context.id ||
    observed.signal.role !== context.role
  )
    return 'unproven';
  // The watcher loads runner consumers; defer it until registry initialization finishes.
  const { resolveContextFilePath } = await import('../tasks/watcher.js');
  const task = resolveContextFilePath(vars.remoteRepo, context.taskFile, '');
  if (!task) return 'unproven';
  const directory = path.posix.dirname(task);
  const resultPath = path.posix.join(directory, 'artifacts/scripted-command-result.json');
  const provenancePath = path.posix.join(directory, 'artifacts/scripted-runner-provenance.json');
  const signalPath = resolveContextFilePath(
    vars.remoteRepo,
    context.signalFile,
    path.posix.join(directory, 'SIGNAL.json'),
    task,
  );
  if (
    !(
      await Promise.all(
        [resultPath, provenancePath, signalPath].map((file) => slotFileExists(vars, file)),
      )
    ).every(Boolean)
  )
    return 'unproven';
  const [rawResult, rawProvenance, rawSignal, stat, resolved] = await Promise.all([
    slotReadFile(vars, resultPath),
    slotReadFile(vars, provenancePath),
    slotReadFile(vars, signalPath),
    slotStat(vars, resultPath),
    command(input),
  ]);
  const result: unknown = JSON.parse(rawResult);
  const provenance: unknown = JSON.parse(rawProvenance);
  const signal = normalizeWorkerSignal(JSON.parse(rawSignal));
  if (!isRecord(result) || !isRecord(provenance) || !signal.ok) return 'unproven';
  const dispatchedAt = parseStrictIsoMs(dispatch.startedAt);
  const startedAt = parseStrictIsoMs(
    typeof provenance.startedAt === 'string' ? provenance.startedAt : null,
  );
  const finishedAt = parseStrictIsoMs(signal.signal.timestamp);
  const cwd = path.posix.resolve(vars.remoteRepo, resolved.cwd ?? '.');
  if (
    provenance.kind !== 'farmslot-scripted-runner' ||
    provenance.mode !== 'command' ||
    provenance.project !== run.project ||
    provenance.commandRef !== run.scripted.commandRef ||
    provenance.cwd !== cwd ||
    scriptedCommandResultRefusal(result, {
      project: run.project,
      commandRef: run.scripted.commandRef,
      cwd,
    }) !== null ||
    !stat.isFile ||
    !Number.isFinite(stat.mtimeMs) ||
    dispatchedAt === null ||
    startedAt === null ||
    finishedAt === null ||
    startedAt < dispatchedAt ||
    startedAt > finishedAt ||
    stat.mtimeMs < startedAt ||
    Math.floor(stat.mtimeMs) > finishedAt ||
    signal.signal.timestamp !== observed.signal.timestamp ||
    signal.signal.status !== observed.signal.status ||
    signal.signal.outcome !== 'success' ||
    (signal.signal.contextId !== undefined && signal.signal.contextId !== context.id) ||
    (signal.signal.role !== undefined && signal.signal.role !== context.role)
  )
    return 'unproven';
  return 'idle';
}

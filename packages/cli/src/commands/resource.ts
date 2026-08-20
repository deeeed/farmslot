import type { Command } from 'commander';

import {
  Methods,
  type ResourcePressureMachine,
  type ResourcePressureSnapshotResult,
  selectResourcePressureGroups,
} from '@farmslot/protocol';

import { bold, dim } from '../colors.js';
import { resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { withProgress } from '../progress.js';

function percent(ratio: number | undefined): string {
  return ratio == null ? '-' : `${Math.round(ratio * 100)}%`;
}

function multiple(ratio: number | undefined): string {
  return ratio == null ? '-' : `${ratio.toFixed(2)}×`;
}

function processName(executable: string): string {
  return (
    executable.match(/\/([^/]+)\.app(?:\/|$)/)?.[1] ??
    executable.split('/').at(-1) ??
    executable
  ).replace(/^\((.+)\)$/u, '$1');
}

function formatMachine(machine: ResourcePressureMachine): string[] {
  const latest = machine.history.at(-1);
  const oldest = machine.history[0];
  const sampler = machine.processAttribution.sampler;
  const classes = machine.processAttribution.classCounts;
  const lines = [
    `${bold(machine.machine)}  ${machine.severity}  history=${machine.history.length}  CPU ${percent(oldest?.pressure.cpu)}→${percent(latest?.pressure.cpu)}  memory ${percent(oldest?.pressure.memory)}→${percent(latest?.pressure.memory)}  load/core ${multiple(oldest?.pressure.load1)}→${multiple(latest?.pressure.load1)}`,
    `  processes active=${classes.active} retained=${classes.retained} stale=${classes.stale} manual=${classes.manual} system/unmapped=${classes.unknown} sampled=${machine.processAttribution.sampledProcesses}/${machine.processAttribution.totalProcesses}${machine.processAttribution.truncated ? ' (truncated)' : ''}${machine.processAttribution.omittedGroups ? `  omitted=${machine.processAttribution.omittedGroups}` : ''}`,
  ];
  if (sampler) {
    lines.push(
      dim(
        `  sampler executions=${sampler.executions} failures=${sampler.failures} skippedBusy=${sampler.skippedBusy} avoided=${sampler.skippedCadence} last=${sampler.lastDurationMs ?? '-'}ms${sampler.lastError ? ` error=${sampler.lastError}` : ''}`,
      ),
    );
  }
  for (const group of selectResourcePressureGroups(machine.processAttribution.groups, 8)) {
    lines.push(
      `  ${(group.classification === 'unknown' ? 'system' : group.classification).padEnd(8)} root=${String(group.rootPid).padEnd(6)} treeCpu=${group.cpuPercent >= 100 ? `${(group.cpuPercent / 100).toFixed(1)}c` : `${group.cpuPercent.toFixed(1)}%`} hotRss=${Math.round(group.topRssBytes / 1_048_576)}MB hot=${group.topPid}:${processName(group.topExecutable)}  ${dim(group.evidence.join(', '))}`,
    );
  }
  return lines;
}

export function formatResourcePressure(result: ResourcePressureSnapshotResult): string {
  const lines = [
    `${bold('Resource pressure')}  ${result.summary.severity}  machines=${result.summary.machines} busy=${result.summary.busySlots} cleanupCandidates=${result.summary.cleanupCandidates}`,
    ...(result.summary.omittedMachines || result.summary.omittedCleanupCandidates
      ? [
          dim(
            `Bounded response omitted machines=${result.summary.omittedMachines} cleanupCandidates=${result.summary.omittedCleanupCandidates}; narrow --machine/--machines or --project/--projects to inspect them.`,
          ),
        ]
      : []),
    '',
  ];
  for (const machine of result.machines) {
    lines.push(...formatMachine(machine), '');
  }
  return lines.join('\n').trimEnd();
}

export function registerResourceCommand(program: Command): void {
  const resource = program.command('resource').description('Resource pressure diagnostics');
  resource
    .command('pressure')
    .description('Show bounded host pressure history and process attribution')
    .option('--machine <machine>', 'Filter by machine')
    .option('--machines <machines...>', 'Filter by one or more machines')
    .option('--project <project>', 'Filter by project')
    .option('--projects <projects...>', 'Filter by one or more projects')
    .action(
      async (
        options: {
          machine?: string;
          machines?: string[];
          project?: string;
          projects?: string[];
        },
        command: Command,
      ) => {
        const { client, output } = resolveContext(command);
        const emit = createEmitter(output, command);
        const machines = [
          ...(options.machine ? [options.machine] : []),
          ...(options.machines ?? []),
        ];
        const projects = [
          ...(options.project ? [options.project] : []),
          ...(options.projects ?? []),
        ];
        try {
          const result = await withProgress(
            'Loading resource pressure',
            () =>
              client.call<ResourcePressureSnapshotResult>(Methods.RESOURCE_PRESSURE_SNAPSHOT, {
                ...(machines.length ? { machines: [...new Set(machines)] } : {}),
                ...(projects.length ? { projects: [...new Set(projects)] } : {}),
              }),
            !emit.machine,
          );
          if (emit.machine) emit.ok(result);
          else output.write(`${formatResourcePressure(result)}\n`);
        } catch (error) {
          emit.fail(error);
        }
      },
    );
}

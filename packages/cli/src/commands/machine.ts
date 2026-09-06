import { Command, Option } from 'commander';

import {
  gateParkStateLabel,
  gateParkSummaryLine,
  type GateParkView,
  liveGateParkView,
  type MachineParkRecord,
  type MachineParkResourceManifest,
  type MachinePauseExecuteParams,
  type MachinePauseExecuteResult,
  MachinePauseMethods,
  type MachinePauseMode,
  type MachinePausePreviewParams,
  type MachinePausePreviewResult,
  type MachinePausePreviewRun,
  type MachinePauseRestoreParams,
  type MachinePauseRestorePreviewRun,
  type MachinePauseRestoreResult,
  type MachinePauseSelector,
  type MachinePauseStatusParams,
  type MachinePauseStatusResult,
  type ResourcePressureMachine,
} from '@farmslot/protocol';

import { bold, dim, green, red } from '../colors.js';
import { resolveContext } from '../context.js';
import { createEmitter, type EnvelopeEmitter } from '../envelope.js';
import { withProgress } from '../progress.js';

interface SelectionOptions {
  run?: string[];
  excludeRun?: string[];
}

interface PauseOptions extends SelectionOptions {
  execute?: boolean;
  mode?: MachinePauseMode;
  previewId?: string;
}

interface RestoreOptions extends SelectionOptions {
  execute?: boolean;
  previewId?: string;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function selectionOption(flags: '--run <run-id>' | '--exclude-run <run-id>'): Option {
  const option = new Option(
    flags,
    flags.startsWith('--exclude')
      ? 'Exclude a run (repeatable); omit both selectors for all eligible runs'
      : 'Select a run (repeatable); omit both selectors for all eligible runs',
  )
    .argParser(collect)
    .default([]);
  return option.conflicts(flags.startsWith('--exclude') ? 'run' : 'excludeRun');
}

export function machineRunSelector(options: SelectionOptions): MachinePauseSelector {
  const includes = [...new Set(options.run ?? [])];
  const excludes = [...new Set(options.excludeRun ?? [])];
  if (includes.length > 0 && excludes.length > 0) {
    throw Object.assign(new Error('--run and --exclude-run cannot be used together.'), {
      code: 'MACHINE_SELECTION_CONFLICT',
      userAction: 'Choose either repeated `--run` selectors or repeated `--exclude-run` selectors.',
    });
  }
  if (includes.length > 0) return { kind: 'include', runIds: includes };
  if (excludes.length > 0) return { kind: 'exclude', runIds: excludes };
  return { kind: 'all' };
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return '-';
  if (Array.isArray(value)) return value.map(displayValue).join(', ');
  return Object.entries(value as Record<string, unknown>)
    .map(([key, child]) => `${key}=${displayValue(child)}`)
    .join(' ');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function percent(value: unknown): string | undefined {
  if (typeof value !== 'number') return undefined;
  return `${Math.round((value <= 1 ? value * 100 : value) * 10) / 10}%`;
}

function formatPressure(value: ResourcePressureMachine | undefined): string[] {
  if (!value) return [dim('Pressure unavailable')];
  const latest = value.history.at(-1);
  const metrics = latest?.pressure;
  const parts = [
    value.severity,
    percent(metrics?.cpu) ? `CPU ${percent(metrics?.cpu)}` : undefined,
    percent(metrics?.memory) ? `memory ${percent(metrics?.memory)}` : undefined,
    percent(metrics?.disk) ? `disk ${percent(metrics?.disk)}` : undefined,
    typeof metrics?.load1 === 'number' ? `load/core ${metrics.load1.toFixed(2)}x` : undefined,
  ].filter((part): part is string => part !== undefined);
  return [`${bold('Pressure')}  ${parts.join('  ')}`];
}

function formatResource(resource: object): string {
  const fields = resource as Record<string, unknown>;
  const identity =
    fields.leaseId ??
    fields.resourceId ??
    fields.capabilityId ??
    fields.id ??
    fields.name ??
    fields.kind ??
    fields.type ??
    'resource';
  const details = Object.entries(fields)
    .filter(
      ([key]) =>
        !['resourceId', 'leaseId', 'capabilityId', 'id', 'name', 'kind', 'type'].includes(key),
    )
    .map(([key, value]) => `${key}=${displayValue(value)}`)
    .join(' ');
  return `${identity}${details ? ` (${details})` : ''}`;
}

function formatManifest(manifest: MachineParkResourceManifest): string[] {
  const lines: string[] = [];
  if (manifest.resources.length > 0) {
    lines.push(`    resources: ${manifest.resources.map(formatResource).join(', ')}`);
  }
  if (manifest.capabilityLeases.length > 0) {
    lines.push(
      `    capability leases: ${manifest.capabilityLeases.map(formatResource).join(', ')}`,
    );
  }
  return lines;
}

function formatParkDetails(park: MachineParkRecord): string[] {
  const lines = formatManifest(park.resourceManifest);
  if (park.recoveryHandle) {
    lines.push(`    recovery handle: ${displayValue(park.recoveryHandle)}`);
  }
  for (const error of park.errors) {
    lines.push(`    error (${error.phase}/${error.code}): ${error.message}`);
  }
  lines.push(`    residuals: ${displayValue(park.residuals)}`);
  return lines;
}

function formatPreviewRun(run: MachinePausePreviewRun | MachinePauseRestorePreviewRun): string[] {
  const park = 'record' in run ? run.record : undefined;
  const slotId = park?.slotId ?? ('slotId' in run ? run.slotId : null);
  const phase = park?.phase;
  const status = 'status' in run ? run.status : undefined;
  const state = run.eligibility.eligible ? green('eligible') : red('rejected');
  const lines = [
    `  ${bold(run.runId)}  ${run.selected ? 'selected' : 'not-selected'}  ${state}${slotId ? `  slot=${slotId}` : ''}${status ? `  status=${status}` : ''}${phase ? `  phase=${phase}` : ''}`,
    `    ${run.eligibility.eligible ? 'eligibility' : 'reason'} (${run.eligibility.code}): ${run.eligibility.reason}`,
  ];
  if ('recoveryPolicy' in run) {
    lines.push(`    recovery: ${displayValue(run.recoveryPolicy)}`);
    lines.push(...formatManifest(run.resourceManifest));
  } else {
    lines.push(...formatParkDetails(run.record));
  }
  return lines;
}

/**
 * The gate parks in a durable status result — the runs whose slot went back to
 * dispatch while their gate stayed answerable (ADR-054 `free-slot`).
 *
 * Derived through the shared protocol reading so `machine status` cannot
 * disagree with what Command Center and Companion say about the same record.
 * Settled records drop out: they describe a park the operator already resolved.
 */
export function gateParkedRuns(records: readonly MachineParkRecord[]): GateParkView[] {
  const views: GateParkView[] = [];
  for (const record of records) {
    const view = liveGateParkView({ id: record.runId, park: record });
    if (view && view.slotDisposition === 'freed') views.push(view);
  }
  return views;
}

/**
 * One line per gate-parked run: what the park did with the slot, the branch it
 * preserved, the slot a restore would use, and the refusal standing against it.
 *
 * Availability is stated only when something answered it. `machine status`
 * reads durable records and never probes a slot, so it reports the target
 * without claiming it is free — `farmslot machine restore` is what asks.
 */
export function formatGateParkLine(view: GateParkView): string {
  const target = view.restoreTarget;
  const availability =
    target.available === null
      ? 'availability not read'
      : target.available
        ? 'available'
        : `not available${target.reason ? `: ${target.reason}` : ''}`;
  const parts = [
    `  ${bold(view.runId)}`,
    gateParkStateLabel(view),
    `freed=${view.freedSlotId ?? '-'}`,
    `restore=${target.slotId} (${availability})`,
  ];
  if (view.refusal) {
    parts.push(red(`refused ${view.refusal.code}: ${view.refusal.reason}`));
  }
  return `${parts.join('  ')}\n    ${dim(gateParkSummaryLine(view))}`;
}

function formatParkRecord(park: MachineParkRecord): string[] {
  return [
    `  ${bold(park.runId)}  slot=${park.slotId}  mode=${park.mode}  phase=${park.phase}  generation=${park.generation}`,
    ...formatParkDetails(park),
  ];
}

export function formatMachinePauseResult(
  result:
    | MachinePausePreviewResult
    | MachinePauseExecuteResult
    | MachinePauseStatusResult
    | MachinePauseRestoreResult,
  nextCommand?: string,
): string {
  const mode = 'mode' in result ? `  mode=${result.mode}` : '';
  const operation =
    'operationId' in result && result.operationId ? `  operation=${result.operationId}` : '';
  const state = 'outcome' in result ? result.outcome : undefined;
  const lines = [
    `${bold(result.machine)}${mode}${operation}${state ? `  status=${state}` : ''}`,
    ...formatPressure(result.pressure),
  ];
  const previewRuns =
    'runs' in result && (!('execute' in result) || !result.execute) ? result.runs : undefined;
  const parkRecords = previewRuns ? undefined : 'records' in result ? result.records : undefined;
  if ((previewRuns?.length ?? parkRecords?.length ?? 0) === 0) {
    lines.push('', dim('  No selected runs.'));
  } else {
    lines.push('');
    if (previewRuns) {
      for (const run of previewRuns) lines.push(...formatPreviewRun(run));
    } else {
      for (const park of parkRecords ?? []) lines.push(...formatParkRecord(park));
    }
  }
  const gateParks = gateParkedRuns(parkRecords ?? []);
  if (gateParks.length > 0) {
    lines.push('', `${bold('Gate parks')}  ${gateParks.length} run(s) holding a freed slot`);
    for (const view of gateParks) lines.push(formatGateParkLine(view));
  }
  if (nextCommand) lines.push('', `${bold('Next')}  ${nextCommand}`);
  return lines.join('\n');
}

export function isPartialMachineResult(result: unknown): result is (
  | MachinePauseExecuteResult
  | MachinePauseRestoreResult
) & {
  outcome: 'partial' | 'failed';
} {
  if (!result || typeof result !== 'object' || !('outcome' in result)) return false;
  const outcome = (result as { outcome?: unknown }).outcome;
  return outcome === 'partial' || outcome === 'failed';
}

export function reviewedTargetsFromPreview(
  preview: MachinePausePreviewResult | MachinePauseRestoreResult,
): Array<{ runId: string; generation: number }> {
  return preview.runs
    .filter((target) => target.selected && target.eligibility.eligible)
    .map(({ runId, generation }) => ({ runId, generation }));
}

export function rejectedTargetsFromPreview(
  preview: MachinePausePreviewResult | MachinePauseRestoreResult,
): Array<MachinePausePreviewRun | MachinePauseRestorePreviewRun> {
  return preview.runs.filter((target) => target.selected && !target.eligibility.eligible);
}

function selectionArgs(selector: MachinePauseSelector): string {
  if (selector.kind === 'all') return '';
  const flag = selector.kind === 'include' ? '--run' : '--exclude-run';
  return selector.runIds.map((id) => ` ${flag} ${shellQuote(id)}`).join('');
}

export function pauseNextCommand(
  machine: string,
  mode: MachinePauseMode,
  selector: MachinePauseSelector,
  previewId?: string,
): string {
  const pin = previewId ? ` --preview-id ${shellQuote(previewId)}` : '';
  return `farmslot machine pause ${shellQuote(machine)} --mode ${mode}${selectionArgs(selector)}${pin} --execute`;
}

export function restoreNextCommand(
  machine: string,
  selector: MachinePauseSelector,
  previewId?: string,
): string {
  const pin = previewId ? ` --preview-id ${shellQuote(previewId)}` : '';
  return `farmslot machine restore ${shellQuote(machine)}${selectionArgs(selector)}${pin} --execute`;
}

export function resolveReviewedPreviewId(
  suppliedPreviewId: string | undefined,
  preview: MachinePausePreviewResult | MachinePauseRestoreResult,
  nextCommand: string,
): string {
  if (!suppliedPreviewId || suppliedPreviewId === preview.previewId) {
    return suppliedPreviewId ?? preview.previewId;
  }
  throw Object.assign(
    new Error(
      `Reviewed preview ${shellQuote(suppliedPreviewId)} is stale; the fresh preview is ${shellQuote(preview.previewId)}. Nothing changed.`,
    ),
    {
      code: 'MACHINE_PREVIEW_STALE',
      userAction: `Review the fresh result, then run ${nextCommand}.`,
      details: {
        suppliedPreviewId,
        freshPreviewId: preview.previewId,
        preview,
      },
    },
  );
}

function assertPreviewIdRequiresExecute(options: { execute?: boolean; previewId?: string }): void {
  if (!options.previewId || options.execute) return;
  throw Object.assign(new Error('--preview-id can only be used with --execute.'), {
    code: 'MACHINE_PREVIEW_ID_REQUIRES_EXECUTE',
    userAction:
      'Run the preview without --preview-id, then copy the exact pinned command it prints.',
  });
}

function partialError(
  result: MachinePauseExecuteResult | MachinePauseRestoreResult,
  nextCommand: string,
): Error {
  const failed = result.outcome === 'failed';
  return Object.assign(
    new Error(`Machine operation ${failed ? 'failed' : 'completed partially'}.`),
    {
      code: failed ? 'MACHINE_OPERATION_FAILED' : 'MACHINE_OPERATION_PARTIAL',
      userAction: `Inspect durable phases, errors, and residuals with ${nextCommand}.`,
      details: result,
    },
  );
}

function previewRejectedError(preview: unknown, previewCommand: string): Error {
  return Object.assign(
    new Error('The reviewed selection contains ineligible runs; nothing changed.'),
    {
      code: 'MACHINE_PAUSE_PREFLIGHT_REJECTED',
      userAction: `Adjust the selection and preview again with ${previewCommand}.`,
      details: preview,
    },
  );
}

function emitResult(
  output: ReturnType<typeof resolveContext>['output'],
  emit: EnvelopeEmitter,
  result:
    | MachinePausePreviewResult
    | MachinePauseExecuteResult
    | MachinePauseStatusResult
    | MachinePauseRestoreResult,
  nextCommand?: string,
): void {
  if (isPartialMachineResult(result)) {
    if (!emit.machine) output.write(`${formatMachinePauseResult(result, nextCommand)}\n`);
    emit.fail(partialError(result, nextCommand ?? 'farmslot machine status <machine>'));
    return;
  }
  if (emit.machine) emit.ok(result);
  else output.write(`${formatMachinePauseResult(result, nextCommand)}\n`);
}

export function registerMachineCommand(program: Command): void {
  const machine = program.command('machine').description('Machine-scoped run pause and restore');

  machine
    .command('pause')
    .description('Preview or execute a machine-scoped run pause')
    .argument('<machine>', 'Machine identifier')
    .addOption(
      new Option('--mode <mode>', 'Pause mode; required with --execute').choices([
        'orchestration',
        'release',
      ]),
    )
    .option('--execute', 'Execute the reviewed pause (default is preview)')
    .option('--preview-id <id>', 'Pin execution to a previously reviewed preview')
    .addOption(selectionOption('--run <run-id>'))
    .addOption(selectionOption('--exclude-run <run-id>'))
    .action(async (machineId: string, options: PauseOptions, command: Command) => {
      const mode = options.mode ?? 'orchestration';
      const selector = machineRunSelector(options);
      const { client, output } = resolveContext(command);
      const emit = createEmitter(output, command);
      try {
        assertPreviewIdRequiresExecute(options);
        if (options.execute && !options.mode) {
          throw Object.assign(new Error('--execute requires an explicit --mode.'), {
            code: 'MACHINE_MODE_REQUIRED',
            userAction: `Review with \`farmslot machine pause ${shellQuote(machineId)} --mode orchestration\` or \`--mode release\`, then repeat with --execute.`,
          });
        }
        const previewParams = {
          machine: machineId,
          mode,
          selector,
        } satisfies MachinePausePreviewParams;
        const preview = await withProgress(
          `Previewing pause on ${machineId}`,
          () => client.call<MachinePausePreviewResult>(MachinePauseMethods.preview, previewParams),
          !emit.machine,
        );
        const nextCommand = pauseNextCommand(machineId, mode, selector, preview.previewId);
        const previewCommand = pauseNextCommand(machineId, mode, selector).replace(
          / --execute$/u,
          '',
        );
        if (!options.execute) {
          emitResult(output, emit, preview, nextCommand);
          return;
        }
        if (!emit.machine) output.write(`${formatMachinePauseResult(preview, nextCommand)}\n\n`);
        const reviewedPreviewId = resolveReviewedPreviewId(options.previewId, preview, nextCommand);
        if (rejectedTargetsFromPreview(preview).length > 0) {
          emit.fail(previewRejectedError(preview, previewCommand));
          return;
        }
        const executeParams = {
          machine: machineId,
          mode,
          previewId: reviewedPreviewId,
          reviewedTargets: reviewedTargetsFromPreview(preview),
        } satisfies MachinePauseExecuteParams;
        const result = await withProgress(
          `Pausing runs on ${machineId}`,
          () => client.call<MachinePauseExecuteResult>(MachinePauseMethods.execute, executeParams),
          !emit.machine,
        );
        emitResult(output, emit, result, `farmslot machine status ${shellQuote(machineId)}`);
      } catch (error) {
        emit.fail(error);
      }
    });

  machine
    .command('status')
    .description('Show durable machine pause and restore state')
    .argument('<machine>', 'Machine identifier')
    .action(async (machineId: string, _options: unknown, command: Command) => {
      const { client, output } = resolveContext(command);
      const emit = createEmitter(output, command);
      try {
        const statusParams = { machine: machineId } satisfies MachinePauseStatusParams;
        const result = await withProgress(
          `Loading pause state for ${machineId}`,
          () => client.call<MachinePauseStatusResult>(MachinePauseMethods.status, statusParams),
          !emit.machine,
        );
        // The derived gate-park list rides along with the raw records rather
        // than replacing them: a script that already reads `records` keeps
        // working, and one that wants the parked runs no longer has to
        // re-implement the reading the clients use.
        if (emit.machine) emit.ok({ ...result, gateParks: gateParkedRuns(result.records) });
        else output.write(`${formatMachinePauseResult(result)}\n`);
      } catch (error) {
        emit.fail(error);
      }
    });

  machine
    .command('restore')
    .description('Preview or execute restoration of paused runs on a machine')
    .argument('<machine>', 'Machine identifier')
    .option('--execute', 'Execute the reviewed restore (default is preview)')
    .option('--preview-id <id>', 'Pin execution to a previously reviewed preview')
    .addOption(selectionOption('--run <run-id>'))
    .addOption(selectionOption('--exclude-run <run-id>'))
    .action(async (machineId: string, options: RestoreOptions, command: Command) => {
      const selector = machineRunSelector(options);
      const { client, output } = resolveContext(command);
      const emit = createEmitter(output, command);
      try {
        assertPreviewIdRequiresExecute(options);
        const previewParams = {
          machine: machineId,
          selector,
          execute: false,
        } satisfies MachinePauseRestoreParams;
        const preview = await withProgress(
          `Previewing restore on ${machineId}`,
          () => client.call<MachinePauseRestoreResult>(MachinePauseMethods.restore, previewParams),
          !emit.machine,
        );
        const nextCommand = restoreNextCommand(machineId, selector, preview.previewId);
        const previewCommand = restoreNextCommand(machineId, selector).replace(/ --execute$/u, '');
        if (!options.execute) {
          emitResult(output, emit, preview, nextCommand);
          return;
        }
        if (!emit.machine) output.write(`${formatMachinePauseResult(preview, nextCommand)}\n\n`);
        const reviewedPreviewId = resolveReviewedPreviewId(options.previewId, preview, nextCommand);
        if (rejectedTargetsFromPreview(preview).length > 0) {
          emit.fail(previewRejectedError(preview, previewCommand));
          return;
        }
        const restoreParams = {
          machine: machineId,
          selector,
          execute: true,
          previewId: reviewedPreviewId,
          reviewedTargets: reviewedTargetsFromPreview(preview),
        } satisfies MachinePauseRestoreParams;
        const result = await withProgress(
          `Restoring runs on ${machineId}`,
          () => client.call<MachinePauseRestoreResult>(MachinePauseMethods.restore, restoreParams),
          !emit.machine,
        );
        emitResult(output, emit, result, `farmslot machine status ${shellQuote(machineId)}`);
      } catch (error) {
        emit.fail(error);
      }
    });
}

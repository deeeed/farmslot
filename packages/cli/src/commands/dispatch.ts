import type { Command } from 'commander';

import type {
  DispatchPreviewResult,
  DispatchQueueListResult,
  PressureAdmissionDecision,
  PressureAdmissionGetResult,
  PressureAdmissionSetEnabledResult,
} from '@farmslot/protocol';

import { bold, cyan, dim, green, red, yellow } from '../colors.js';
import { resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { withProgress } from '../progress.js';

import { executeRunCreate, type RunCreateCliOptions, runWizardDispatch } from './run.js';

const DISPATCH_MODES = new Set(['interactive', 'autonomous', 'validation']);

/**
 * Render the backend-owned pressure admission decision. The CLI prints the
 * decision verbatim: sustained sample evidence, attributed causes, rejection
 * reason, refresh state, and the exact override syntax. It never re-derives
 * thresholds client-side.
 */
export function renderPressureAdmission(decision: PressureAdmissionDecision): string[] {
  const lines: string[] = [];
  const evidence = decision.evidence;
  const stateLabel =
    decision.outcome === 'admitted'
      ? decision.state === 'green'
        ? green(decision.state)
        : yellow(decision.state)
      : red(decision.state);
  lines.push(`  Pressure:  ${stateLabel} on ${decision.machine}`);
  if (evidence.samples.length > 0) {
    lines.push(
      `    Samples:   ${evidence.consecutiveCriticalSamples}/${evidence.requiredConsecutiveCriticalSamples} consecutive critical (newest ${evidence.latestSampleAt ?? 'unknown'})`,
    );
    for (const sample of evidence.samples.slice(-4)) {
      const load = sample.load1 !== undefined ? ` load1 ${sample.load1.toFixed(2)}` : '';
      const marker = sample.critical ? red('critical') : dim('ok');
      lines.push(
        `      ${sample.collectedAt}  cpu ${(sample.cpu * 100).toFixed(0)}% mem ${(sample.memory * 100).toFixed(0)}% disk ${(sample.disk * 100).toFixed(0)}%${load}  ${marker}`,
      );
    }
  }
  if (evidence.generation) {
    lines.push(`    Generation: ${evidence.generation}`);
  }
  if (decision.outcome === 'admitted') {
    if (decision.state === 'override' && decision.override) {
      lines.push(
        `    Override:  accepted for this dispatch only (principal ${decision.override.principalId}: ${decision.override.reason})`,
      );
    }
    return lines;
  }
  lines.push(`    Rejected:  ${red(decision.code)}: ${decision.reason}`);
  if (decision.causes.length > 0) {
    lines.push('    Causes:');
    for (const cause of decision.causes) {
      const target = cause.slotId ? ` slot ${cause.slotId}` : '';
      const cleanup = cause.cleanupEligible
        ? ''
        : dim(' (explains pressure; not a cleanup target)');
      lines.push(
        `      ${cause.process} ×${cause.processCount}  ${cause.cpuPercent.toFixed(0)}% cpu  ${(cause.rssBytes / 1073741824).toFixed(1)}GB  ${cause.classification}/${cause.confidence}${target}${cleanup}`,
      );
    }
  }
  lines.push(`    Refresh:   re-run \`farmslot dispatch preview\` for a fresh decision`);
  if (decision.overridable && evidence.generation) {
    lines.push(
      `    Override:  farmslot run create … --pressure-machine ${decision.machine} --pressure-generation '${evidence.generation}' --pressure-override-reason '<why this one dispatch is safe>'`,
    );
  }
  return lines;
}

function parseDispatchMode(value: string | undefined) {
  if (!value) return undefined;
  if (!DISPATCH_MODES.has(value)) {
    throw Object.assign(new Error(`Invalid run mode: ${value}`), {
      code: 'CLI_INVALID_OPTION_VALUE',
      userAction: 'Use --mode interactive, --mode autonomous, or --mode validation.',
    });
  }
  return value as 'interactive' | 'autonomous' | 'validation';
}

export function registerDispatchCommand(program: Command): void {
  const dispatch = program
    .command('dispatch')
    .description('Dispatch planning (bare `farmslot dispatch` opens the guided picker on a TTY)')
    .action(async (_: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        if (emit.machine || !process.stdin.isTTY) {
          throw Object.assign(new Error('The guided dispatch picker requires a terminal.'), {
            code: 'DISPATCH_WIZARD_REQUIRES_TTY',
            userAction:
              'Use the typed commands instead: `farmslot run create --project <p> --flow-type <f> --ticket <ref>` or `farmslot backlog dispatch <ref>`.',
          });
        }
        const opts: RunCreateCliOptions = {};
        const handled = await runWizardDispatch(ctx, opts);
        if (!handled) await executeRunCreate(ctx, emit, opts);
      } catch (err) {
        emit.fail(err);
      }
    });

  dispatch
    .command('preview')
    .description('Preview dispatch plan')
    .requiredOption('--project <name>', 'Project name')
    .requiredOption('--flow-type <type>', 'Flow type (fix-bug, review-pr, dev, pr-complete)')
    .requiredOption('--ticket <id>', 'Ticket or PR identifier')
    .option('--slot <id>', 'Specific slot ID')
    .option('--mode <mode>', 'Run mode (interactive, autonomous, validation)')
    .option('--execution-template <id>', 'Exact execution-template id')
    .option('--domain <name>', 'Domain overlay carried by the dispatch')
    .action(async (opts: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const result = await withProgress(
          'Computing dispatch plan',
          () =>
            client.call<DispatchPreviewResult>('dispatch.preview', {
              project: opts.project,
              flowType: opts.flowType,
              ticketOrPr: opts.ticket,
              slotId: opts.slot,
              ...(opts.mode ? { mode: parseDispatchMode(opts.mode) } : {}),
              ...(opts.executionTemplate ? { executionTemplateId: opts.executionTemplate } : {}),
              ...(opts.domain ? { domain: opts.domain } : {}),
            }),
          !emit.machine,
        );
        if (emit.machine) {
          emit.ok(result);
        } else {
          const p = result.preview;
          output.write(
            [
              `${bold('Dispatch Preview')}`,
              `  Slot:      ${green(p.slotId)}`,
              `  Project:   ${p.project}`,
              `  Flow:      ${p.flowType}`,
              `  Branch:    ${p.branch || dim('(none)')}`,
              `  Runner:    ${p.runner}:${p.model}`,
              `  Task:      ${p.taskId}`,
              ...(p.domain ? [`  Domain:    ${p.domain}`] : []),
              ...(p.executionTemplate
                ? [
                    `  Template:  ${green(p.executionTemplate.id)}`,
                    `  Source:    ${p.executionTemplate.sourceId}`,
                    `  Digest:    ${p.executionTemplate.sha256.slice(0, 12)}`,
                  ]
                : []),
              ...(result.pressureAdmission
                ? renderPressureAdmission(result.pressureAdmission)
                : []),
              '',
            ].join('\n'),
          );
        }
      } catch (err) {
        emit.fail(err);
        return;
      }
    });

  const admission = dispatch
    .command('pressure-admission')
    .description('Durable kill switch for sustained-pressure dispatch prevention');

  const renderAdmissionControl = (
    output: { write: (text: string) => void },
    state: { enabled: boolean; updatedAt: string | null; updatedBy: string | null },
  ) => {
    output.write(
      [
        `${bold('Pressure admission')}: ${state.enabled ? green('enabled') : red('DISABLED')}`,
        state.updatedAt
          ? `  Last change: ${state.updatedAt} by ${state.updatedBy ?? 'unknown'}`
          : `  Last change: never (gateway default)`,
        state.enabled
          ? ''
          : `  ${yellow('Dispatches are NOT pressure-gated. Sampling, history, and charts continue.')}`,
        '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  };

  admission
    .command('status')
    .description('Show whether pressure-based dispatch prevention is active')
    .action(async (_opts: unknown, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const state = await client.call<PressureAdmissionGetResult>(
          'dispatch.pressureAdmission.get',
          {},
        );
        if (emit.machine) emit.ok(state);
        else renderAdmissionControl(output, state);
      } catch (err) {
        emit.fail(err);
      }
    });

  for (const [verb, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    admission
      .command(verb)
      .description(
        enabled
          ? 'Re-enable pressure-based dispatch prevention'
          : 'Disable pressure rejection/override prompts (sampling and charts continue)',
      )
      .action(async (_opts: unknown, cmd: Command) => {
        const { client, output } = resolveContext(cmd);
        const emit = createEmitter(output, cmd);
        try {
          const state = await client.call<PressureAdmissionSetEnabledResult>(
            'dispatch.pressureAdmission.setEnabled',
            { enabled },
          );
          if (emit.machine) emit.ok(state);
          else renderAdmissionControl(output, state);
        } catch (err) {
          emit.fail(err);
        }
      });
  }

  const queue = dispatch.command('queue').description('Inspect the shared dispatch queue');

  queue
    .command('list')
    .description('List dispatch queue items')
    .action(async (_opts: unknown, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const result = await withProgress(
          'Loading dispatch queue',
          () => client.call<DispatchQueueListResult>('dispatch.queue.list', {}),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else if (result.items.length === 0) output.write(`${dim('queue empty')}\n`);
        else {
          for (const item of result.items) {
            output.write(
              `${cyan(item.id.slice(0, 8))}  p${String(item.priority ?? '-').padEnd(3)}  ${item.project}  ${item.flowType}  ${item.ticketOrPr || item.label || '-'}\n`,
            );
          }
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  // Run dispatch is intentionally handled by `farmslot run create`, where
  // `--ticket` and `--task` are peer input sources for the same run pipeline.
}

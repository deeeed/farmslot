import type { Command } from 'commander';

import type { DispatchPreviewResult } from '@farmslot/protocol';

import { bold, dim, green } from '../colors.js';
import { resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { withProgress } from '../progress.js';

import { executeRunCreate, type RunCreateCliOptions, runWizardDispatch } from './run.js';

const DISPATCH_MODES = new Set(['interactive', 'autonomous', 'validation']);

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
              '',
            ].join('\n'),
          );
        }
      } catch (err) {
        emit.fail(err);
        return;
      }
    });

  // Run dispatch is intentionally handled by `farmslot run create`, where
  // `--ticket` and `--task` are peer input sources for the same run pipeline.
}

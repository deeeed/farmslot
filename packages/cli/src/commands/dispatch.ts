import type { Command } from 'commander';

import type { DispatchPreviewResult } from '@farmslot/protocol';

import { bold, dim, green } from '../colors.js';
import { resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { withProgress } from '../progress.js';

export function registerDispatchCommand(program: Command): void {
  const dispatch = program.command('dispatch').description('Dispatch planning');

  dispatch
    .command('preview')
    .description('Preview dispatch plan')
    .requiredOption('--project <name>', 'Project name')
    .requiredOption('--flow-type <type>', 'Flow type (fix-bug, review-pr, dev, pr-complete)')
    .requiredOption('--ticket <id>', 'Ticket or PR identifier')
    .option('--slot <id>', 'Specific slot ID')
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
              '',
            ].join('\n'),
          );
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // Run dispatch is intentionally handled by `farmslot run create`, where
  // `--ticket` and `--task` are peer input sources for the same run pipeline.
}

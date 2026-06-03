import type { Command } from 'commander';

import type { DispatchPreviewResult, EventFrame, Run } from '@farmslot/protocol';

import { bold, dim, green } from '../colors.js';
import { resolveContext } from '../context.js';
import { withProgress } from '../progress.js';

// Map task subdirectory names to FlowType values
const SUBDIR_TO_FLOW: Record<string, string> = {
  fix: 'fix-bug',
  review: 'review-pr',
  dev: 'dev',
  'pr-complete': 'pr-complete',
  'merge-main': 'merge-main',
};

/**
 * Parse a task file path to extract project, flowType, and ticketOrPr.
 * Expected path structure: projects/<project>/tasks/<flow>/<ticket-folder>/TASK.md
 */
function parseTaskPath(taskFile: string): {
  project: string;
  flowType: string;
  ticketOrPr: string;
  relativePath: string;
} {
  // Normalize to forward slashes and find the projects/ segment
  const normalized = taskFile.replace(/\\/g, '/');
  const projIdx = normalized.indexOf('projects/');
  if (projIdx === -1)
    throw new Error(
      `Cannot parse task path — expected "projects/<name>/tasks/<flow>/<id>/TASK.md": ${taskFile}`,
    );

  const relative = normalized.slice(projIdx);
  // projects/<project>/tasks/<flow>/<ticket-folder>/TASK.md
  const parts = relative.split('/');
  // parts: [projects, <project>, tasks, <flow>, <ticket-folder>, TASK.md]
  if (parts.length < 6 || parts[0] !== 'projects' || parts[2] !== 'tasks') {
    throw new Error(
      `Cannot parse task path — expected "projects/<name>/tasks/<flow>/<id>/TASK.md": ${taskFile}`,
    );
  }

  const project = parts[1];
  const flowSubdir = parts[3];
  const ticketFolder = parts[4];

  const flowType = SUBDIR_TO_FLOW[flowSubdir] || flowSubdir;
  // Extract ticket ID: first two segments of folder name, uppercased (e.g. "proj-2483-0409-1813" → "PROJ-2483")
  const ticketOrPr = ticketFolder.split('-').slice(0, 2).join('-').toUpperCase();

  return { project, flowType, ticketOrPr, relativePath: relative };
}

export function registerDispatchCommand(program: Command): void {
  const dispatch = program.command('dispatch').description('Task dispatch');

  dispatch
    .command('preview')
    .description('Preview dispatch plan')
    .requiredOption('--project <name>', 'Project name')
    .requiredOption('--flow-type <type>', 'Flow type (fix-bug, review-pr, dev, pr-complete)')
    .requiredOption('--ticket <id>', 'Ticket or PR identifier')
    .option('--slot <id>', 'Specific slot ID')
    .action(async (opts: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const result = await withProgress(
          'Computing dispatch plan',
          () =>
            client.call<DispatchPreviewResult>('dispatch.preview', {
              project: opts.project,
              flowType: opts.flowType,
              ticketOrPr: opts.ticket,
              slotId: opts.slot,
            }),
          !output.json,
        );
        if (output.json) {
          output.writeJson(result);
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
              '',
            ].join('\n'),
          );
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  dispatch
    .command('execute')
    .description('Execute dispatch (creates a full Run with monitoring + CI watch)')
    .argument('<id>', 'Slot ID')
    .argument('<task>', 'Task file path')
    .option('--skip-prepare', 'Skip slot preparation')
    .option('--mode <mode>', 'Run mode (interactive, autonomous, validation)')
    .option(
      '--runner <name>',
      'Runner override (claude, codex, opencode, or a runner-aware custom config)',
    )
    .option('--model <name>', 'Model override (sonnet, opus, haiku)')
    .option('--app <path>', 'Project-specific app selector, e.g. apps/sherpa-voice')
    .action(async (id: string, task: string, opts: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const parsed = parseTaskPath(task);
        const result = await client.callWithEvents<{ run: Run }>(
          'run.create',
          {
            flowType: parsed.flowType,
            project: parsed.project,
            ticketOrPr: parsed.ticketOrPr,
            slotId: id,
            taskFile: task,
            runId: undefined,
            skipPrepare: opts.skipPrepare || undefined,
            mode: opts.mode || undefined,
            runner: opts.runner || undefined,
            model: opts.model || undefined,
            app: opts.app || undefined,
          },
          (event: EventFrame) => {
            const payload = event.payload as any;
            if (payload?.data) {
              process.stderr.write(payload.data);
            }
          },
        );
        if (output.json) {
          output.writeJson(result);
        } else {
          output.write(
            `${green('Run created')} ${bold(result.run.id.slice(0, 8))} for ${bold(id)} (${parsed.flowType})\n`,
          );
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

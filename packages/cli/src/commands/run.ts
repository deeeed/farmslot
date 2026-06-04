import type { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { EventFrame, Run } from '@farmslot/protocol';

import { bold, green } from '../colors.js';
import { resolveContext } from '../context.js';

// Map task subdirectory names to FlowType values.
const SUBDIR_TO_FLOW: Record<string, string> = {
  fix: 'fix-bug',
  feat: 'dev',
  review: 'review-pr',
  dev: 'dev',
  'pr-complete': 'pr-complete',
  'merge-main': 'merge-main',
};

function readTaskJson(taskFile: string, relativePath: string): Record<string, unknown> | null {
  const jsonPath = path.join(path.dirname(taskFile), relativePath);
  if (!existsSync(jsonPath)) return null;
  try {
    return JSON.parse(readFileSync(jsonPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid task metadata ${jsonPath}: ${detail}`);
  }
}

/**
 * Parse a task file path to extract project, flowType, and ticketOrPr.
 * Expected path structure: projects/<project>/tasks/<flow>/<ticket-folder>/TASK.md
 */
export function parseTaskPath(taskFile: string): {
  project: string;
  flowType: string;
  ticketOrPr: string;
  relativePath: string;
} {
  const normalized = taskFile.replace(/\\/g, '/');
  const projIdx = normalized.indexOf('projects/');
  if (projIdx === -1) {
    throw new Error(
      `Cannot parse task path — expected "projects/<name>/tasks/<flow>/<id>/TASK.md": ${taskFile}`,
    );
  }

  const relative = normalized.slice(projIdx);
  const parts = relative.split('/');
  if (parts.length < 6 || parts[0] !== 'projects' || parts[2] !== 'tasks') {
    throw new Error(
      `Cannot parse task path — expected "projects/<name>/tasks/<flow>/<id>/TASK.md": ${taskFile}`,
    );
  }

  const project = parts[1];
  const flowSubdir = parts[3];
  const ticketFolder = parts[4];
  const provenance = readTaskJson(taskFile, 'inputs/template-provenance.json');
  const ticketData = readTaskJson(taskFile, 'inputs/bug-input.json');
  const flowType =
    typeof provenance?.flowType === 'string'
      ? provenance.flowType
      : SUBDIR_TO_FLOW[flowSubdir] || flowSubdir;
  const ticketOrPr =
    typeof ticketData?.githubIssue === 'string'
      ? ticketData.githubIssue
      : ticketFolder.split('-').slice(0, 2).join('-').toUpperCase();

  return { project, flowType, ticketOrPr, relativePath: relative };
}

export interface RunCreateCliOptions {
  project?: string;
  flowType?: string;
  ticket?: string;
  task?: string;
  slot?: string;
  skipPrepare?: boolean;
  mode?: string;
  runner?: string;
  model?: string;
  app?: string;
}

export function buildRunCreateParams(opts: RunCreateCliOptions): Record<string, unknown> {
  if (opts.ticket && opts.task) {
    throw new Error('Use either --ticket or --task, not both.');
  }
  if (!opts.ticket && !opts.task) {
    throw new Error('Provide --ticket <jira-or-github-ref> or --task <TASK.md>.');
  }

  const base = {
    slotId: opts.slot || undefined,
    skipPrepare: opts.skipPrepare || undefined,
    mode: opts.mode || undefined,
    runner: opts.runner || undefined,
    model: opts.model || undefined,
    app: opts.app || undefined,
  };

  if (opts.task) {
    const parsed = parseTaskPath(opts.task);
    return {
      ...base,
      flowType: opts.flowType || parsed.flowType,
      project: opts.project || parsed.project,
      ticketOrPr: parsed.ticketOrPr,
      taskFile: opts.task,
    };
  }

  if (!opts.project) throw new Error('--project is required with --ticket.');
  if (!opts.flowType) throw new Error('--flow-type is required with --ticket.');

  return {
    ...base,
    flowType: opts.flowType,
    project: opts.project,
    ticketOrPr: opts.ticket,
  };
}

export function registerRunCommand(program: Command): void {
  const run = program.command('run').description('Run lifecycle operations');

  run
    .command('create')
    .description('Create a supervised run from a ticket/ref or an existing task file')
    .option('--project <name>', 'Project name; required with --ticket')
    .option('--flow-type <type>', 'Flow type (fix-bug, review-pr, dev, pr-complete)')
    .option('--ticket <ref>', 'Jira key/URL or GitHub issue/PR URL/ref')
    .option('--task <path>', 'Existing TASK.md to dispatch through the run pipeline')
    .option('--slot <id>', 'Specific slot ID')
    .option('--skip-prepare', 'Skip slot preparation')
    .option('--mode <mode>', 'Run mode (interactive, autonomous, validation)')
    .option(
      '--runner <name>',
      'Runner override (claude, codex, opencode, or a runner-aware custom config)',
    )
    .option('--model <name>', 'Model override')
    .option('--app <path>', 'Project-specific app selector, e.g. apps/sherpa-voice')
    .action(async (opts: RunCreateCliOptions, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const params = buildRunCreateParams(opts);
        const result = await client.callWithEvents<{ run: Run }>(
          'run.create',
          params,
          (event: EventFrame) => {
            const payload = event.payload as any;
            if (payload?.data) process.stderr.write(payload.data);
          },
        );
        if (output.json) {
          output.writeJson(result);
        } else {
          output.write(
            `${green('Run created')} ${bold(result.run.id.slice(0, 8))} for ${bold(
              result.run.slotId || '(slot pending)',
            )} (${result.run.flowType})\n`,
          );
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Command } from 'commander';

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

const FARMSLOT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function resolveReadableTaskFile(taskFile: string): string {
  if (path.isAbsolute(taskFile)) return taskFile;
  const cwdPath = path.resolve(taskFile);
  if (existsSync(cwdPath)) return cwdPath;
  const rootPath = path.join(FARMSLOT_ROOT, taskFile);
  if (existsSync(rootPath)) return rootPath;
  return taskFile;
}

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

function taskRelativePathFromSegments(taskFile: string, normalized: string): string {
  const parts = normalized.split('/').filter(Boolean);
  const start = parts.length - 6;
  if (start >= 0 && parts[start] === 'projects' && parts[start + 2] === 'tasks') {
    return parts.slice(start).join('/');
  }
  throw new Error(
    `Cannot parse task path — expected "projects/<name>/tasks/<flow>/<id>/TASK.md": ${taskFile}`,
  );
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
  const resolvedTaskFile = resolveReadableTaskFile(taskFile);
  const normalized = resolvedTaskFile.replace(/\\/g, '/');
  const relative = taskRelativePathFromSegments(taskFile, normalized);
  const parts = relative.split('/');
  if (parts.length < 6 || parts[0] !== 'projects' || parts[2] !== 'tasks') {
    throw new Error(
      `Cannot parse task path — expected "projects/<name>/tasks/<flow>/<id>/TASK.md": ${taskFile}`,
    );
  }

  const project = parts[1];
  const flowSubdir = parts[3];
  const ticketFolder = parts[4];
  const provenance = readTaskJson(resolvedTaskFile, 'inputs/template-provenance.json');
  const ticketData = readTaskJson(resolvedTaskFile, 'inputs/bug-input.json');
  const flowType =
    typeof provenance?.flowType === 'string'
      ? provenance.flowType
      : SUBDIR_TO_FLOW[flowSubdir] || flowSubdir;
  const ticketOrPr =
    typeof ticketData?.githubIssue === 'string'
      ? ticketData.githubIssue
      : typeof ticketData?.jiraKey === 'string'
        ? ticketData.jiraKey
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
  prepareProfile?: string;
  mode?: string;
  runner?: string;
  model?: string;
  app?: string;
  team?: string;
  familyId?: string;
  parentRunId?: string;
  familyRootTicketOrPr?: string;
  lane?: string;
  variant?: string;
  scriptedScenario?: string;
  scriptedStepDelayMs?: string;
  scriptedCommandRef?: string;
  scriptedTimeoutMs?: string;
}

function optionalPositiveInteger(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function optionalNonNegativeInteger(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${field} must be a non-negative integer`);
  return parsed;
}

function buildScriptedConfig(opts: RunCreateCliOptions): Record<string, unknown> | undefined {
  if (opts.scriptedScenario && opts.scriptedCommandRef) {
    throw new Error('Use either --scripted-scenario or --scripted-command-ref, not both.');
  }
  if (opts.scriptedScenario) {
    return {
      mode: 'scenario',
      scenario: opts.scriptedScenario,
      stepDelayMs: optionalNonNegativeInteger(opts.scriptedStepDelayMs, '--scripted-step-delay-ms'),
    };
  }
  if (opts.scriptedCommandRef) {
    return {
      mode: 'command',
      commandRef: opts.scriptedCommandRef,
      timeoutMs: optionalPositiveInteger(opts.scriptedTimeoutMs, '--scripted-timeout-ms'),
    };
  }
  return undefined;
}

export function buildRunCreateParams(opts: RunCreateCliOptions): Record<string, unknown> {
  if (opts.ticket && opts.task) {
    throw new Error('Use either --ticket or --task, not both.');
  }
  if (!opts.ticket && !opts.task) {
    throw new Error('Provide --ticket <jira-or-github-ref> or --task <TASK.md>.');
  }

  const scripted = buildScriptedConfig(opts);

  const base = {
    slotId: opts.slot || undefined,
    skipPrepare: opts.skipPrepare || undefined,
    prepareProfile: opts.prepareProfile || undefined,
    mode: opts.mode || undefined,
    runner: opts.runner || undefined,
    model: opts.model || undefined,
    ...(scripted ? { scripted } : {}),
    app: opts.app || undefined,
    ...(opts.team ? { team: opts.team } : {}),
    familyId: opts.familyId || undefined,
    parentRunId: opts.parentRunId || undefined,
    familyRootTicketOrPr: opts.familyRootTicketOrPr || undefined,
    lane: opts.lane || undefined,
    variant: opts.variant || undefined,
  };

  if (opts.task) {
    const parsed = parseTaskPath(opts.task);
    return {
      ...base,
      flowType: opts.flowType || parsed.flowType,
      project: opts.project || parsed.project,
      ticketOrPr: parsed.ticketOrPr,
      taskFile: parsed.relativePath,
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
    .option('--skip-prepare', 'Skip slot preparation entirely (operator owns slot state)')
    .option(
      '--prepare-profile <name>',
      "Named prepare profile from the project's prepare.profiles (ADR-037)",
    )
    .option(
      '--mode <mode>',
      'Run mode (interactive, autonomous, validation). Omitted mode uses dispatch-wizard defaults (gateway applies on create).',
    )
    .option(
      '--runner <name>',
      'Runner override (claude, codex, opencode, or a runner-aware custom config)',
    )
    .option('--model <name>', 'Model override')
    .option(
      '--scripted-scenario <name>',
      'Scripted scenario for runner=scripted (success, failure, timeout)',
    )
    .option('--scripted-step-delay-ms <ms>', 'Scripted scenario step delay in ms')
    .option(
      '--scripted-command-ref <name>',
      'Project-owned scripted command ref for runner=scripted',
    )
    .option('--scripted-timeout-ms <ms>', 'Scripted command timeout override in ms')
    .option('--app <path>', 'Project-specific app selector, e.g. apps/sherpa-voice')
    .option('--team <name>', 'Team overlay for fixture compose + {{team}} template substitution')
    .option('--family-id <id>', 'Run family id for comparison/follow-up lineage')
    .option('--parent-run-id <id>', 'Parent run id for explicit lineage')
    .option('--family-root-ticket-or-pr <ref>', 'Family root ticket/PR label')
    .option('--lane <lane>', 'Run lane (production, validation, comparison)')
    .option('--variant <name>', 'Run variant, required for comparison siblings')
    .action(async (opts: RunCreateCliOptions, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const params = buildRunCreateParams(opts);
        const result = await client.callWithEvents<{ run: Run }>(
          'run.create',
          params,
          (event: EventFrame) => {
            const payload = event.payload;
            if (payload && typeof payload === 'object' && 'data' in payload) {
              const data = payload.data;
              if (typeof data === 'string') process.stderr.write(data);
            }
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

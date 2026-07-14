import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Command } from 'commander';

import type { EventFrame, Run } from '@farmslot/protocol';

import { bold, green } from '../colors.js';
import { type CommandContext, resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { collectRunCreatePlan } from '../wizard/run-create-wizard.js';

import { dispatchBacklogItem, resolveItem } from './backlog.js';

/** The run.create pipeline shared by the flag path and the wizard entry points. */
export async function executeRunCreate(
  ctx: CommandContext,
  emit: ReturnType<typeof createEmitter>,
  opts: RunCreateCliOptions,
): Promise<void> {
  const params = buildRunCreateParams(opts);
  const result = await ctx.client.callWithEvents<{ run: Run }>(
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
  if (emit.machine) {
    emit.ok(result);
  } else {
    ctx.output.write(
      `${green('Run created')} ${bold(result.run.id.slice(0, 8))} for ${bold(
        result.run.slotId || '(slot pending)',
      )} (${result.run.flowType})\n`,
    );
  }
}

/**
 * Guided TTY path for a missing input source. Returns true when the wizard
 * fully handled the invocation (backlog dispatch or operator cancel); false
 * when it collected ticket-route options and the normal create path should
 * continue with them.
 */
export async function runWizardDispatch(
  ctx: CommandContext,
  opts: RunCreateCliOptions,
): Promise<boolean> {
  const plan = await collectRunCreatePlan(ctx.client);
  if (!plan) return true; // operator cancelled — exit 0, nothing dispatched
  if (plan.kind === 'backlog') {
    const item = await resolveItem(ctx, plan.backlogRef ?? plan.backlogItemId ?? '');
    await dispatchBacklogItem(ctx, item, (promoted) => {
      ctx.output.write(`Promoted ${promoted.sourceRef ?? promoted.id} to ready\n`);
    });
    ctx.output.write(
      `${green('Dispatch requested')} for ${bold(item.sourceRef ?? item.id)} — watch with \`farmslot fleet status\` / \`farmslot run list\`\n`,
    );
    return true;
  }
  // Overwrite unconditionally: a stray pre-set flag (e.g. --slot without a
  // source) must not survive a wizard choice that contradicts it.
  opts.project = plan.project;
  opts.flowType = plan.flowType;
  opts.ticket = plan.ticket;
  opts.slot = plan.slotId;
  return false;
}

// Map task subdirectory names to FlowType values.
const SUBDIR_TO_FLOW: Record<string, string> = {
  fix: 'fix-bug',
  feat: 'dev',
  review: 'review-pr',
  dev: 'dev',
  'pr-complete': 'pr-complete',
  'update-branch': 'update-branch',
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
  domain?: string;
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
    ...(opts.domain ? { domain: opts.domain } : {}),
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
    .command('list')
    .description('List runs')
    .option('--limit <n>', 'Max runs', '20')
    .option('--active', 'Only active runs')
    .option('--project <name>', 'Filter by project')
    .action(async (opts: { limit: string; active?: boolean; project?: string }, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const result = await client.call<{ runs: Array<Record<string, unknown>> }>('run.list', {
          limit: Number(opts.limit),
          ...(opts.active ? { active: true } : {}),
          ...(opts.project ? { project: opts.project } : {}),
        });
        if (emit.machine) {
          emit.ok(result);
        } else {
          for (const r of result.runs) {
            output.write(
              `${String(r.id).slice(0, 8)}  ${String(r.status).padEnd(14)} ${String(r.flowType ?? '-').padEnd(12)} ${String(r.ticketOrPr ?? '-')}\n`,
            );
          }
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  run
    .command('get <runId>')
    .description('Show one run')
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const result = await client.call<{ run: Record<string, unknown> }>('run.get', { runId });
        if (emit.machine) emit.ok(result);
        else output.write(`${JSON.stringify(result.run, null, 2)}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  run
    .command('gate <runId>')
    .description('List or resolve pending human-gate decisions for a run')
    .option('--action <id>', 'Action to resolve with (approve-publish|hold|close-as-shipped|…)')
    .option('--decision <id>', 'Decision id when several are pending')
    .action(async (runId: string, opts: { action?: string; decision?: string }, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const { run: current } = await client.call<{
          run: {
            decisions?: Array<{
              id: string;
              title?: string;
              resolvedAt?: string;
              actions?: Array<{ id: string; label: string }>;
            }>;
          };
        }>('run.get', { runId });
        const pending = (current.decisions ?? []).filter((d) => !d.resolvedAt);
        if (!opts.action) {
          if (emit.machine) {
            emit.ok({ pending });
          } else if (pending.length === 0) {
            output.write('No pending decisions.\n');
          } else {
            for (const d of pending) {
              output.write(`${d.id}  ${d.title ?? ''}\n`);
              for (const a of d.actions ?? []) output.write(`  - ${a.id}  ${a.label}\n`);
            }
          }
          return;
        }
        const decisionId = opts.decision ?? (pending.length === 1 ? pending[0].id : undefined);
        if (!decisionId) {
          throw Object.assign(new Error(`Run has ${pending.length} pending decisions.`), {
            code: 'GATE_DECISION_AMBIGUOUS',
            userAction:
              'List them with `farmslot run gate <runId>` and pass --decision <id> with --action.',
          });
        }
        const result = await client.call('run.resolveDecision', {
          runId,
          decisionId,
          actionId: opts.action,
        });
        if (emit.machine) emit.ok(result);
        else output.write(`Resolved ${decisionId} with ${opts.action}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  run
    .command('cancel <runId>')
    .description('Cancel a run')
    .option('--reason <reason>', 'Cancellation reason')
    .action(async (runId: string, opts: { reason?: string }, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const result = await client.call('run.cancel', {
          runId,
          ...(opts.reason ? { reason: opts.reason } : {}),
        });
        if (emit.machine) emit.ok(result);
        else output.write(`Cancelled ${runId}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  run
    .command('archive <runId>')
    .description('Archive a terminal run out of default views')
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const result = await client.call('run.archive', { runId });
        if (emit.machine) emit.ok(result);
        else output.write(`Archived ${runId}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

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
    .option(
      '--domain <name>',
      'Domain overlay for fixture compose + {{domain}} template substitution',
    )
    .option('--family-id <id>', 'Run family id for comparison/follow-up lineage')
    .option('--parent-run-id <id>', 'Parent run id for explicit lineage')
    .option('--family-root-ticket-or-pr <ref>', 'Family root ticket/PR label')
    .option('--lane <lane>', 'Run lane (production, validation, comparison)')
    .option('--variant <name>', 'Run variant, required for comparison siblings')
    .action(async (opts: RunCreateCliOptions, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        if (!opts.ticket && !opts.task && !emit.machine && process.stdin.isTTY) {
          // No input source on an interactive terminal: guided picker instead
          // of the usage error. Machine mode keeps the envelope error below.
          const done = await runWizardDispatch(ctx, opts);
          if (done) return;
        }
        await executeRunCreate(ctx, emit, opts);
      } catch (err) {
        emit.fail(err);
        return;
      }
    });
}

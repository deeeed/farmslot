import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Command } from 'commander';

import {
  AGENT_ROLES,
  type AgentRole,
  buildRunResolveDecisionParams,
  type EventFrame,
  failedRunCancelEffects,
  type HumanGrade,
  observedReviewSessionContinuity,
  type ReviewChainEntry,
  reviewChainForRun,
  type Run,
  type RunCancelEffect,
  type RunForceCompleteResult,
  type RunGetGradeResult,
  type RunGradeResult,
  type RunPauseResult,
  type RunResumeResult,
  type RunSessionCommandResult,
} from '@farmslot/protocol';

import { bold, cyan, green } from '../colors.js';
import { type CommandContext, resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { withProgress, withStreamProgress } from '../progress.js';
import { collectRunCreatePlan } from '../wizard/run-create-wizard.js';

import { dispatchBacklogItem, resolveItem } from './backlog.js';

export function parseOptionalPrNumber(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const prNumber = Number(raw);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('--pr must be a positive integer');
  }
  return prNumber;
}

export function assertRunGateActionAvailable(
  decision: NonNullable<Run['decisions']>[number],
  actionId: string,
): void {
  if (decision.actions?.some((action) => action.id === actionId)) return;
  const available = (decision.actions ?? []).map((action) => action.id);
  throw Object.assign(
    new Error(
      `Action ${actionId} is not available for decision ${decision.id}.` +
        (available.length ? ` Available actions: ${available.join(', ')}.` : ''),
    ),
    {
      code: 'GATE_ACTION_UNAVAILABLE',
      userAction: 'List current actions with `farmslot run gate <runId>`.',
    },
  );
}

export function buildReviewChainResult(run: Run): { chain: ReviewChainEntry[] } {
  return { chain: reviewChainForRun(run) };
}

export function formatReviewChainLine(entry: ReviewChainEntry): string {
  return `G${entry.generation} ${entry.runId.slice(0, 8)}  ${entry.baseSha?.slice(0, 7) ?? '-'} -> ${entry.headSha?.slice(0, 7) ?? 'pending'}  ${entry.reviewScope}/${entry.validationDepth}  ${entry.verdict}  ${entry.unresolvedCount == null ? 'unresolved pending' : `${entry.unresolvedCount} unresolved`}  ${observedReviewSessionContinuity(entry)}`;
}

/** The run.create pipeline shared by the flag path and the wizard entry points. */
export async function executeRunCreate(
  ctx: CommandContext,
  emit: ReturnType<typeof createEmitter>,
  opts: RunCreateCliOptions,
): Promise<void> {
  const params = buildRunCreateParams(opts);
  const result = await withStreamProgress(
    'Creating run',
    (onData) =>
      ctx.client.callWithEvents<{ run: Run }>('run.create', params, (event: EventFrame) => {
        const payload = event.payload;
        if (payload && typeof payload === 'object' && 'data' in payload) {
          const data = payload.data;
          if (typeof data === 'string') onData(data);
        }
      }),
    !emit.machine,
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
  executionTemplate?: string;
  familyId?: string;
  parentRunId?: string;
  familyRootTicketOrPr?: string;
  lane?: string;
  variant?: string;
  scriptedScenario?: string;
  scriptedStepDelayMs?: string;
  scriptedCommandRef?: string;
  scriptedTimeoutMs?: string;
  pressureMachine?: string;
  pressureGeneration?: string;
  pressureOverrideReason?: string;
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

/**
 * Backend-decision pass-through only: the pair --pressure-machine +
 * --pressure-generation echoes the decision the gateway printed at preview
 * time (preview identity). Adding --pressure-override-reason turns the same
 * pair into a deliberate one-dispatch override. The CLI computes nothing.
 */
function buildPressureAdmissionParams(opts: RunCreateCliOptions): Record<string, unknown> {
  const machine = opts.pressureMachine?.trim();
  const generation = opts.pressureGeneration?.trim();
  const overrideReason = opts.pressureOverrideReason?.trim();
  if (!machine && !generation && !overrideReason) return {};
  if (!machine || !generation) {
    throw new Error(
      'Pressure options require both --pressure-machine and --pressure-generation (copy them from `farmslot dispatch preview`).',
    );
  }
  if (overrideReason) {
    return {
      pressureOverride: { machine, pressureGeneration: generation, reason: overrideReason },
    };
  }
  return { pressureAdmissionRef: { machine, pressureGeneration: generation } };
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
    ...(opts.executionTemplate ? { executionTemplateId: opts.executionTemplate } : {}),
    familyId: opts.familyId || undefined,
    parentRunId: opts.parentRunId || undefined,
    familyRootTicketOrPr: opts.familyRootTicketOrPr || undefined,
    lane: opts.lane || undefined,
    variant: opts.variant || undefined,
    ...buildPressureAdmissionParams(opts),
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

/** Reject an unknown --role before it reaches the gateway. */
export function parseAgentRole(raw: string | undefined): AgentRole | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const role = raw.trim();
  if (!(AGENT_ROLES as readonly string[]).includes(role)) {
    throw Object.assign(new Error(`Invalid --role '${role}'.`), {
      code: 'RUN_SESSION_INVALID_ROLE',
      userAction: `Pass one of: ${AGENT_ROLES.join(', ')}.`,
    });
  }
  return role as AgentRole;
}

/**
 * Human output for `run session`. The reopen and attach commands each get their
 * own line with nothing else on it, so an operator can select and paste one.
 */
export function formatRunSessionLines(result: RunSessionCommandResult): string[] {
  if (!result.supported) {
    return [
      `No reopen command for role ${result.role ?? 'unknown'}: ${result.reason}`,
      result.detail,
    ];
  }
  return [
    `${result.runner}/${result.model ?? 'unknown'}  role=${result.role}  slot=${result.slotId}  session=${result.sessionId}  liveness=${result.liveness}`,
    result.reopenCommand,
    ...(result.attachCommand ? [result.attachCommand] : []),
  ];
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
        const result = await withProgress(
          'Loading runs',
          () =>
            client.call<{ runs: Array<Record<string, unknown>> }>('run.list', {
              limit: Number(opts.limit),
              ...(opts.active ? { active: true } : {}),
              ...(opts.project ? { project: opts.project } : {}),
            }),
          !emit.machine,
        );
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
        const result = await withProgress(
          `Loading run ${runId.slice(0, 8)}`,
          () => client.call<{ run: Record<string, unknown> }>('run.get', { runId }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else output.write(`${JSON.stringify(result.run, null, 2)}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  run
    .command('session <runId>')
    .description("Show the command that reopens a run agent's runner session")
    .option('--role <role>', "Agent context role (default: the run's primary worker role)")
    .action(async (runId: string, opts: { role?: string }, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const role = parseAgentRole(opts.role);
        const result = await withProgress(
          `Session for ${runId.slice(0, 8)}`,
          () =>
            client.call<RunSessionCommandResult>('run.sessionCommand', {
              runId,
              ...(role ? { role } : {}),
            }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else for (const line of formatRunSessionLines(result)) output.write(`${line}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  run
    .command('review-chain <runId>')
    .description('Show the review generations and reviewer-session continuity for one run')
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const { run: current } = await withProgress(
          `Loading review chain for ${runId.slice(0, 8)}`,
          () => client.call<{ run: Run }>('run.get', { runId }),
          !emit.machine,
        );
        const result = buildReviewChainResult(current);
        if (emit.machine) {
          emit.ok(result);
        } else if (result.chain.length === 0) {
          output.write('No repeat-review chain.\n');
        } else {
          for (const entry of result.chain) {
            output.write(`${formatReviewChainLine(entry)}\n`);
          }
        }
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
        const { run: current } = await withProgress(
          `Loading gates for ${runId.slice(0, 8)}`,
          () => client.call<{ run: Run }>('run.get', { runId }),
          !emit.machine,
        );
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
        const actionId = opts.action;
        const decisionId = opts.decision ?? (pending.length === 1 ? pending[0].id : undefined);
        if (!decisionId) {
          throw Object.assign(new Error(`Run has ${pending.length} pending decisions.`), {
            code: 'GATE_DECISION_AMBIGUOUS',
            userAction:
              'List them with `farmslot run gate <runId>` and pass --decision <id> with --action.',
          });
        }
        const decision = current.decisions?.find((candidate) => candidate.id === decisionId);
        if (!decision) {
          throw new Error(`Decision ${decisionId} was not found on run ${runId}.`);
        }
        assertRunGateActionAvailable(decision, actionId);
        const result = await withProgress(
          `Resolving ${decisionId} with ${opts.action}`,
          () =>
            client.call(
              'run.resolveDecision',
              buildRunResolveDecisionParams({
                runId,
                decision,
                actionId,
              }),
            ),
          !emit.machine,
        );
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
        const result = await withProgress(
          `Cancelling ${runId.slice(0, 8)}`,
          () =>
            client.call('run.cancel', {
              runId,
              ...(opts.reason ? { reason: opts.reason } : {}),
            }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else {
          output.write(`Cancelled ${runId}\n`);
          // The run is terminal, but an advisory effect can still have failed. Printing
          // only "Cancelled" hid a slot that was never released or a backlog left
          // unsettled, which is the whole reason the effects travel with the result.
          for (const effect of failedRunCancelEffects(
            (result as { effects?: RunCancelEffect[] }).effects,
          )) {
            output.write(`  warning: ${effect.name} failed — ${effect.detail ?? 'no detail'}\n`);
          }
        }
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
        const result = await withProgress(
          `Archiving ${runId.slice(0, 8)}`,
          () => client.call('run.archive', { runId }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else output.write(`Archived ${runId}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  run
    .command('pause <runId>')
    .description('Pause a running run')
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const result = await withProgress(
          `Pausing ${runId.slice(0, 8)}`,
          () => client.call<RunPauseResult>('run.pause', { runId }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else output.write(`${green('Paused')} ${cyan(runId.slice(0, 8))}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  run
    .command('resume <runId>')
    .description('Resume a paused run')
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const result = await withProgress(
          `Resuming ${runId.slice(0, 8)}`,
          () => client.call<RunResumeResult>('run.resume', { runId }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else output.write(`${green('Resumed')} ${cyan(runId.slice(0, 8))}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  run
    .command('force-complete <runId>')
    .description('Force-complete a run (operator escape hatch)')
    .option('--pr <n>', 'PR number to attach when force-completing a failed run')
    .action(async (runId: string, opts: { pr?: string }, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const prNumber = parseOptionalPrNumber(opts.pr);
        const result = await withProgress(
          `Force-completing ${runId.slice(0, 8)}`,
          () =>
            client.call<RunForceCompleteResult>('run.forceComplete', {
              runId,
              ...(prNumber != null ? { prNumber } : {}),
            }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else {
          const prLabel = result.run.prNumber != null ? ` (#${result.run.prNumber})` : '';
          output.write(`${green('Force-completed')} ${cyan(runId.slice(0, 8))}${prLabel}\n`);
          for (const effect of failedRunCancelEffects(result.effects)) {
            output.write(`  warning: ${effect.name} failed — ${effect.detail ?? 'no detail'}\n`);
          }
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  run
    .command('for-slot <slotId>')
    .description('Show the run currently bound to a slot (if any)')
    .action(async (slotId: string, _opts: unknown, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const result = await withProgress(
          `Run for ${slotId}`,
          () => client.call<{ run: Run | null }>('run.forSlot', { slotId }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else if (!result.run) output.write(`No run bound to ${slotId}.\n`);
        else
          output.write(
            `${result.run.id.slice(0, 8)}  ${String(result.run.status)}  ${result.run.flowType}  ${result.run.ticketOrPr ?? '-'}\n`,
          );
      } catch (err) {
        emit.fail(err);
      }
    });

  run
    .command('grade <runId>')
    .description('Record a human grade on a run')
    .requiredOption('--semantic <grade>', 'recipe_semantic: good | ok | bad')
    .requiredOption('--reasoning <text>', 'Why this grade')
    .option('--by <id>', 'Grader identity', 'cli-operator')
    .action(
      async (
        runId: string,
        opts: { semantic: string; reasoning: string; by: string },
        cmd: Command,
      ) => {
        const { client, output } = resolveContext(cmd);
        const emit = createEmitter(output, cmd);
        try {
          if (!['good', 'ok', 'bad'].includes(opts.semantic)) {
            throw Object.assign(new Error(`Invalid --semantic '${opts.semantic}'.`), {
              code: 'RUN_GRADE_INVALID',
              userAction: 'Pass --semantic good, --semantic ok, or --semantic bad.',
            });
          }
          const grade: HumanGrade = {
            recipe_semantic: opts.semantic as HumanGrade['recipe_semantic'],
            reasoning: opts.reasoning,
            graded_by: opts.by,
            graded_at: new Date().toISOString(),
          };
          const result = await withProgress(
            `Grading ${runId.slice(0, 8)}`,
            () => client.call<RunGradeResult>('run.grade', { runId, grade }),
            !emit.machine,
          );
          if (emit.machine) emit.ok(result);
          else output.write(`${green('Graded')} ${cyan(runId.slice(0, 8))} as ${opts.semantic}\n`);
        } catch (err) {
          emit.fail(err);
        }
      },
    );

  run
    .command('get-grade <runId>')
    .description('Read the human grade on a run, if any')
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const result = await withProgress(
          `Grade for ${runId.slice(0, 8)}`,
          () => client.call<RunGetGradeResult>('run.getGrade', { runId }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else if (!result.grade) output.write('No grade recorded.\n');
        else
          output.write(
            `${result.grade.recipe_semantic}  by ${result.grade.graded_by}  ${result.grade.graded_at}\n${result.grade.reasoning}\n`,
          );
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
    .option(
      '--execution-template <id>',
      'Exact execution-template catalog id (inspect with `farmslot execution-template options`)',
    )
    .option('--family-id <id>', 'Run family id for comparison/follow-up lineage')
    .option('--parent-run-id <id>', 'Parent run id for explicit lineage')
    .option('--family-root-ticket-or-pr <ref>', 'Family root ticket/PR label')
    .option('--lane <lane>', 'Run lane (production, validation, comparison)')
    .option('--variant <name>', 'Run variant, required for comparison siblings')
    .option(
      '--pressure-machine <machine>',
      'Machine from the pressure decision shown by `farmslot dispatch preview`',
    )
    .option(
      '--pressure-generation <generation>',
      'Pressure generation from that decision; execution rejects if it moved',
    )
    .option(
      '--pressure-override-reason <reason>',
      'Deliberate one-dispatch pressure override reason (with --pressure-machine/--pressure-generation)',
    )
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

// backlog.ts — terminal operator loop for backlog items. RPC only: the gateway
// owns the backlog store; this module never touches .backlog.json on disk.

import type { Command } from 'commander';

import type {
  BacklogArchiveResult,
  BacklogCloseShippedResult,
  BacklogCreateResult,
  BacklogDeleteResult,
  BacklogDequeueResult,
  BacklogEnqueueResult,
  BacklogItem,
  BacklogListResult,
  BacklogReconcileRunResult,
  BacklogRefinementSessionGetResult,
  BacklogRefineResult,
  BacklogSpecGetResult,
  BacklogUpcomingResult,
  BacklogUpdateResult,
} from '@farmslot/protocol';

import { bold, cyan, dim, green, yellow } from '../colors.js';
import { type CommandContext, resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { withProgress } from '../progress.js';
import { TableRenderer } from '../table.js';

/** Accepts a full sourceRef, an item id, or an id prefix. */
export async function resolveItem(ctx: CommandContext, ref: string): Promise<BacklogItem> {
  const { items } = await ctx.client.call<BacklogListResult>('backlog.list', {});
  const exact = items.find((item) => item.sourceRef === ref || item.id === ref);
  if (exact) return exact;
  const prefixed = items.filter((item) => item.id.startsWith(ref));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw Object.assign(
      new Error(
        `Ambiguous ref '${ref}' matches ${prefixed.length} items: ${prefixed
          .map((item) => item.sourceRef ?? item.id.slice(0, 12))
          .join(', ')}.`,
      ),
      {
        code: 'BACKLOG_ITEM_AMBIGUOUS',
        userAction: 'Pass the full sourceRef (e.g. MANUAL-000015) or a longer id prefix.',
      },
    );
  }
  throw Object.assign(new Error(`No backlog item matches '${ref}'.`), {
    code: 'BACKLOG_ITEM_NOT_FOUND',
    userAction:
      'List items with `farmslot backlog list` and pass a sourceRef (e.g. MANUAL-000015) or item id.',
  });
}

/**
 * The dispatch pipeline for one backlog item: promote a candidate to ready,
 * enqueue, and trigger an auto-dispatch tick. Shared by `backlog dispatch`
 * and the run-create wizard.
 */
export async function dispatchBacklogItem(
  ctx: CommandContext,
  item: BacklogItem,
  onPromoted?: (item: BacklogItem) => void,
): Promise<{ enqueue: BacklogEnqueueResult; tick: unknown }> {
  if (item.status === 'candidate') {
    // Dispatch implies readiness — promote instead of failing enqueue.
    const ready = await ctx.client.call<{ item: BacklogItem }>('backlog.markReady', {
      itemId: item.id,
    });
    item = ready.item;
    onPromoted?.(item);
  }
  const enqueue = await ctx.client.call<BacklogEnqueueResult>('backlog.enqueue', {
    itemId: item.id,
  });
  const tick = await ctx.client.call('backlog.autoDispatchTick', {});
  return { enqueue, tick };
}

export async function reconcileBacklogItemRun(
  ctx: CommandContext,
  item: BacklogItem,
  runId: string,
): Promise<BacklogReconcileRunResult> {
  return ctx.client.call<BacklogReconcileRunResult>('backlog.reconcileRun', {
    itemId: item.id,
    runId,
  });
}

function renderItems(items: BacklogItem[]): string {
  const table = new TableRenderer();
  table
    .addColumn('REF')
    .addColumn('STATUS')
    .addColumn('PROJECT', { shrinkable: true, minWidth: 8 })
    .addColumn('PRIO')
    .addColumn('TITLE', { shrinkable: true, minWidth: 16 });
  for (const item of items) {
    const plain = [
      item.sourceRef ?? item.id.slice(0, 8),
      item.status,
      item.project,
      String(item.priority ?? '-'),
      item.title,
    ];
    table.addRow(plain, [
      cyan(plain[0]),
      item.status === 'done' ? green(item.status) : yellow(item.status),
      plain[2],
      plain[3],
      plain[4],
    ]);
  }
  return table.render();
}

export function registerBacklogCommand(program: Command): void {
  const backlog = program.command('backlog').description('Backlog operator loop (gateway RPC)');

  backlog
    .command('list')
    .description('List backlog items')
    .option('--project <name>', 'Filter by project')
    .option('--status <status>', 'Filter by status (candidate|ready|queued|running|done|…)')
    .action(async (opts: { project?: string; status?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          'Loading backlog',
          () =>
            ctx.client.call<BacklogListResult>('backlog.list', {
              project: opts.project,
              status: opts.status,
            }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else ctx.output.write(`${renderItems(result.items)}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  backlog
    .command('get <ref>')
    .description('Show one backlog item by sourceRef or id')
    .option('--spec', 'Also print the attached spec document')
    .action(async (ref: string, opts: { spec?: boolean }, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const { item, spec } = await withProgress(
          `Loading ${ref}`,
          async () => {
            const item = await resolveItem(ctx, ref);
            const spec = opts.spec
              ? await ctx.client.call<BacklogSpecGetResult>('backlog.spec.get', { itemId: item.id })
              : undefined;
            return { item, spec };
          },
          !emit.machine,
        );
        if (emit.machine) {
          emit.ok({ item, ...(spec ? { spec } : {}) });
        } else {
          ctx.output.write(`${bold(item.sourceRef ?? item.id)}  ${item.status}\n`);
          ctx.output.write(`${item.title}\n`);
          if (item.specPath) ctx.output.write(`${dim(`spec: ${item.specPath}`)}\n`);
          if (item.notes) ctx.output.write(`\n${item.notes}\n`);
          if (spec) ctx.output.write(`\n${spec.content}\n`);
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  backlog
    .command('reconcile-run <ref> <run-id>')
    .description('Repair a missing backlog/run link after validating project and source identity')
    .action(async (ref: string, runId: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const { item, result } = await withProgress(
          `Reconciling ${ref} to ${runId.slice(0, 8)}`,
          async () => {
            const item = await resolveItem(ctx, ref);
            const result = await reconcileBacklogItemRun(ctx, item, runId);
            return { item, result };
          },
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else
          ctx.output.write(
            `${green('Reconciled')} ${cyan(item.sourceRef ?? item.id)} to run ${cyan(result.run.id.slice(0, 8))} (${result.item.status})\n`,
          );
      } catch (err) {
        emit.fail(err);
      }
    });

  backlog
    .command('create')
    .description('Create a backlog item (spec paths live under .backlog/specs/)')
    .requiredOption('--project <name>', 'Target project')
    .requiredOption('--title <title>', 'Item title')
    .option('--spec <path>', 'Spec path relative to the farmslot root (.backlog/specs/...)')
    .option('--notes <notes>', 'Notes')
    .option('--priority <n>', 'Priority (lower dispatches first)')
    .option('--flow-type <flow>', 'Flow type', 'dev')
    .option(
      '--multi-pr',
      'Acceptance criteria span multiple PRs: finished runs return the item to ready instead of auto-closing it',
    )
    .action(
      async (
        opts: {
          project: string;
          title: string;
          spec?: string;
          notes?: string;
          priority?: string;
          flowType: string;
          multiPr?: boolean;
        },
        cmd: Command,
      ) => {
        const ctx = resolveContext(cmd);
        const emit = createEmitter(ctx.output, cmd);
        try {
          const result = await withProgress(
            `Creating ${opts.title}`,
            () =>
              ctx.client.call<BacklogCreateResult>('backlog.create', {
                project: opts.project,
                title: opts.title,
                sourceKind: 'manual',
                flowType: opts.flowType,
                ...(opts.spec ? { specPath: opts.spec } : {}),
                ...(opts.notes ? { notes: opts.notes } : {}),
                ...(opts.priority ? { priority: Number(opts.priority) } : {}),
                ...(opts.multiPr ? { multiPr: true } : {}),
              }),
            !emit.machine,
          );
          if (emit.machine) emit.ok(result);
          else
            ctx.output.write(
              `${green('Created')} ${cyan(result.item.sourceRef ?? result.item.id)} ${result.item.title}\n`,
            );
        } catch (err) {
          emit.fail(err);
        }
      },
    );

  backlog
    .command('update <ref>')
    .description('Update title/notes/priority/multi-pr of a backlog item')
    .option('--title <title>', 'New title')
    .option('--notes <notes>', 'New notes')
    .option('--priority <n>', 'New priority')
    .option(
      '--multi-pr',
      'Mark acceptance criteria as spanning multiple PRs (no auto-close on run done)',
    )
    .option('--no-multi-pr', 'Clear the multi-PR marker (runs auto-close the item again)')
    .action(
      async (
        ref: string,
        opts: { title?: string; notes?: string; priority?: string; multiPr?: boolean },
        cmd: Command,
      ) => {
        const ctx = resolveContext(cmd);
        const emit = createEmitter(ctx.output, cmd);
        try {
          const { item, result } = await withProgress(
            `Updating ${ref}`,
            async () => {
              const item = await resolveItem(ctx, ref);
              const result = await ctx.client.call<BacklogUpdateResult>('backlog.update', {
                itemId: item.id,
                ...(opts.title ? { title: opts.title } : {}),
                ...(opts.notes ? { notes: opts.notes } : {}),
                ...(opts.priority ? { priority: Number(opts.priority) } : {}),
                ...(opts.multiPr !== undefined ? { multiPr: opts.multiPr } : {}),
              });
              return { item, result };
            },
            !emit.machine,
          );
          if (emit.machine) emit.ok(result);
          else ctx.output.write(`${green('Updated')} ${cyan(item.sourceRef ?? item.id)}\n`);
        } catch (err) {
          emit.fail(err);
        }
      },
    );

  backlog
    .command('ready <ref>')
    .description('Mark a candidate item ready for dispatch')
    .action(async (ref: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const { item, result } = await withProgress(
          `Marking ${ref} ready`,
          async () => {
            const item = await resolveItem(ctx, ref);
            const result = await ctx.client.call<{ item: BacklogItem }>('backlog.markReady', {
              itemId: item.id,
            });
            return { item, result };
          },
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else ctx.output.write(`${green('Ready')} ${cyan(item.sourceRef ?? item.id)}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  backlog
    .command('enqueue <ref>')
    .description('Queue a backlog item for dispatch')
    .action(async (ref: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const { item, result } = await withProgress(
          `Enqueuing ${ref}`,
          async () => {
            const item = await resolveItem(ctx, ref);
            const result = await ctx.client.call<BacklogEnqueueResult>('backlog.enqueue', {
              itemId: item.id,
            });
            return { item, result };
          },
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else
          ctx.output.write(
            `${green('Enqueued')} ${cyan(item.sourceRef ?? item.id)} for dispatch\n`,
          );
      } catch (err) {
        emit.fail(err);
      }
    });

  backlog
    .command('dispatch <ref>')
    .description('Enqueue a backlog item and trigger a dispatch tick immediately')
    .action(async (ref: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        // Keep the spinner up through the whole pipeline — markReady → enqueue →
        // autoDispatchTick is the slow part, not the item lookup.
        const { item, enqueue, tick } = await withProgress(
          `Dispatching ${ref}`,
          async () => {
            const item = await resolveItem(ctx, ref);
            const { enqueue, tick } = await dispatchBacklogItem(ctx, item, (promoted) => {
              if (!emit.machine)
                ctx.output.write(`Promoted ${promoted.sourceRef ?? promoted.id} to ready\n`);
            });
            return { item, enqueue, tick };
          },
          !emit.machine,
        );
        if (emit.machine) emit.ok({ enqueue, tick });
        else
          ctx.output.write(
            `${green('Dispatch requested')} for ${cyan(item.sourceRef ?? item.id)} — watch with \`farmslot fleet status\` / \`farmslot run list\`\n`,
          );
      } catch (err) {
        emit.fail(err);
      }
    });

  backlog
    .command('close-shipped <ref>')
    .description('Close an item whose work already shipped (e.g. PR merged out-of-band)')
    .option('--pr <ref>', 'Merged PR reference, e.g. owner/repo#123')
    .option('--note <note>', 'Provenance note')
    .action(async (ref: string, opts: { pr?: string; note?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const { item, result } = await withProgress(
          `Closing ${ref}`,
          async () => {
            const item = await resolveItem(ctx, ref);
            const result = await ctx.client.call<BacklogCloseShippedResult>(
              'backlog.closeShipped',
              {
                itemId: item.id,
                ...(opts.pr ? { prRef: opts.pr } : {}),
                ...(opts.note ? { note: opts.note } : {}),
              },
            );
            return { item, result };
          },
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else
          ctx.output.write(
            `${green('Closed as shipped')} ${cyan(item.sourceRef ?? item.id)}${opts.pr ? ` (${opts.pr})` : ''}\n`,
          );
      } catch (err) {
        emit.fail(err);
      }
    });

  backlog
    .command('delete <ref>')
    .description('Delete a backlog item (gateway backlog.delete)')
    .action(async (ref: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          `Deleting ${ref}`,
          async () => {
            const item = await resolveItem(ctx, ref);
            return ctx.client.call<BacklogDeleteResult>('backlog.delete', { itemId: item.id });
          },
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else ctx.output.write(`${green('Deleted')} ${cyan(ref)}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  backlog
    .command('archive <ref>')
    .description('Archive a backlog item')
    .action(async (ref: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const { item, result } = await withProgress(
          `Archiving ${ref}`,
          async () => {
            const item = await resolveItem(ctx, ref);
            const result = await ctx.client.call<BacklogArchiveResult>('backlog.archive', {
              itemId: item.id,
            });
            return { item, result };
          },
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else ctx.output.write(`${green('Archived')} ${cyan(item.sourceRef ?? item.id)}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  backlog
    .command('dequeue <ref>')
    .description('Remove a queued backlog item from the dispatch queue')
    .action(async (ref: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const { item, result } = await withProgress(
          `Dequeuing ${ref}`,
          async () => {
            const item = await resolveItem(ctx, ref);
            const result = await ctx.client.call<BacklogDequeueResult>('backlog.dequeue', {
              itemId: item.id,
            });
            return { item, result };
          },
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else ctx.output.write(`${green('Dequeued')} ${cyan(item.sourceRef ?? item.id)}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  backlog
    .command('upcoming')
    .description('Show ready vs blocked backlog items for auto-dispatch')
    .option('--project <name>', 'Filter by project')
    .option('--limit <n>', 'Max items')
    .action(async (opts: { project?: string; limit?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        let limit: number | undefined;
        if (opts.limit !== undefined) {
          limit = Number(opts.limit);
          if (!Number.isInteger(limit) || limit <= 0) {
            throw Object.assign(new Error(`Invalid --limit '${opts.limit}'.`), {
              code: 'BACKLOG_LIMIT_INVALID',
              userAction: 'Pass a positive integer, e.g. `--limit 20`.',
            });
          }
        }
        const result = await withProgress(
          'Loading upcoming backlog',
          () =>
            ctx.client.call<BacklogUpcomingResult>('backlog.upcoming', {
              ...(opts.project ? { project: opts.project } : {}),
              ...(limit !== undefined ? { limit } : {}),
            }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else {
          ctx.output.write(`${bold('ready')} (${result.ready.length})\n`);
          ctx.output.write(`${renderItems(result.ready)}\n`);
          if (result.blocked.length > 0) {
            ctx.output.write(`${bold('blocked')} (${result.blocked.length})\n`);
            for (const blocked of result.blocked) {
              const ref = blocked.item.sourceRef ?? blocked.item.id.slice(0, 8);
              ctx.output.write(`  ${cyan(ref)}  ${yellow(blocked.reason)}\n`);
            }
          }
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  backlog
    .command('refine <ref>')
    .description('Prepare (and optionally launch) a backlog refinement session')
    .option('--runner <name>', 'Runner override')
    .option('--model <name>', 'Model override')
    .option('--runner-command <template>', 'Shell command template for refinement')
    .option('--safety-tier <tier>', 'Runner safety tier (sandboxed|full-auto|dangerous)')
    .option('--launch', 'Create or attach the tmux refinement session')
    .action(
      async (
        ref: string,
        opts: {
          runner?: string;
          model?: string;
          runnerCommand?: string;
          safetyTier?: string;
          launch?: boolean;
        },
        cmd: Command,
      ) => {
        const ctx = resolveContext(cmd);
        const emit = createEmitter(ctx.output, cmd);
        try {
          const result = await withProgress(
            `Refining ${ref}`,
            async () => {
              const item = await resolveItem(ctx, ref);
              return ctx.client.call<BacklogRefineResult>(
                'backlog.refine',
                backlogRefineRpcParams(item.id, opts),
              );
            },
            !emit.machine,
          );
          if (emit.machine) emit.ok(result);
          else {
            const lines = describeBacklogRefineOutput(result);
            ctx.output.write(
              `${green(lines.verb)} refinement for ${cyan(result.item.sourceRef)}\n`,
            );
            ctx.output.write(`${dim(lines.promptLine)}\n`);
            ctx.output.write(`${dim(lines.attachLine)}\n`);
          }
        } catch (err) {
          emit.fail(err);
        }
      },
    );

  backlog
    .command('refinement-session <ref>')
    .description('Show refinement tmux session status for a backlog item')
    .action(async (ref: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          `Refinement session ${ref}`,
          async () => {
            const item = await resolveItem(ctx, ref);
            return ctx.client.call<BacklogRefinementSessionGetResult>(
              'backlog.refinementSession.get',
              { itemId: item.id },
            );
          },
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else {
          const status = result.exists ? green('running') : yellow('absent');
          ctx.output.write(`${status}  ${result.tmuxSession}\n`);
          ctx.output.write(`${dim(result.attachCommand)}\n`);
        }
      } catch (err) {
        emit.fail(err);
      }
    });
}

/** Build the backlog.refine RPC params the CLI would send (testable without Commander). */
export function backlogRefineRpcParams(
  itemId: string,
  opts: {
    runner?: string;
    model?: string;
    runnerCommand?: string;
    safetyTier?: string;
    launch?: boolean;
  },
): Record<string, unknown> {
  return {
    itemId,
    ...(opts.runner ? { runner: opts.runner } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.runnerCommand ? { runnerCommand: opts.runnerCommand } : {}),
    ...(opts.safetyTier?.trim() ? { safetyTier: opts.safetyTier.trim() } : {}),
    ...(opts.launch ? { launch: true } : {}),
  };
}

/** Structured human lines for refine CLI output (testable; used by the command handler). */
export function describeBacklogRefineOutput(result: BacklogRefineResult): {
  verb: 'Launched' | 'Reopened' | 'Prepared';
  promptLine: string;
  attachLine: string;
} {
  const verb = result.launched ? 'Launched' : result.attachedExisting ? 'Reopened' : 'Prepared';
  return {
    verb,
    promptLine: `prompt: ${result.promptPath}`,
    attachLine: `attach: ${result.attachCommand}`,
  };
}

// backlog.ts — terminal operator loop for backlog items. RPC only: the gateway
// owns the backlog store; this module never touches .backlog.json on disk.

import type { Command } from 'commander';

import type {
  BacklogCloseShippedResult,
  BacklogCreateResult,
  BacklogEnqueueResult,
  BacklogItem,
  BacklogListResult,
  BacklogSpecGetResult,
  BacklogUpdateResult,
} from '@farmslot/protocol';

import { bold, cyan, dim, green, yellow } from '../colors.js';
import { type CommandContext, resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { TableRenderer } from '../table.js';

/** Accepts a sourceRef (MANUAL-000015), an item id, or an id prefix. */
async function resolveItem(ctx: CommandContext, ref: string): Promise<BacklogItem> {
  const { items } = await ctx.client.call<BacklogListResult>('backlog.list', {});
  const match = items.find(
    (item) => item.sourceRef === ref || item.id === ref || item.id.startsWith(ref),
  );
  if (!match) {
    throw Object.assign(new Error(`No backlog item matches '${ref}'.`), {
      code: 'BACKLOG_ITEM_NOT_FOUND',
      userAction:
        'List items with `farmslot backlog list` and pass a sourceRef (e.g. MANUAL-000015) or item id.',
    });
  }
  return match;
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
        const result = await ctx.client.call<BacklogListResult>('backlog.list', {
          project: opts.project,
          status: opts.status,
        });
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
        const item = await resolveItem(ctx, ref);
        const spec = opts.spec
          ? await ctx.client.call<BacklogSpecGetResult>('backlog.spec.get', { itemId: item.id })
          : undefined;
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
    .command('create')
    .description('Create a backlog item (spec paths live under .backlog/specs/)')
    .requiredOption('--project <name>', 'Target project')
    .requiredOption('--title <title>', 'Item title')
    .option('--spec <path>', 'Spec path relative to the farmslot root (.backlog/specs/...)')
    .option('--notes <notes>', 'Notes')
    .option('--priority <n>', 'Priority (lower dispatches first)')
    .option('--flow-type <flow>', 'Flow type', 'dev')
    .action(
      async (
        opts: {
          project: string;
          title: string;
          spec?: string;
          notes?: string;
          priority?: string;
          flowType: string;
        },
        cmd: Command,
      ) => {
        const ctx = resolveContext(cmd);
        const emit = createEmitter(ctx.output, cmd);
        try {
          const result = await ctx.client.call<BacklogCreateResult>('backlog.create', {
            project: opts.project,
            title: opts.title,
            sourceKind: 'manual',
            flowType: opts.flowType,
            ...(opts.spec ? { specPath: opts.spec } : {}),
            ...(opts.notes ? { notes: opts.notes } : {}),
            ...(opts.priority ? { priority: Number(opts.priority) } : {}),
          });
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
    .description('Update title/notes/priority of a backlog item')
    .option('--title <title>', 'New title')
    .option('--notes <notes>', 'New notes')
    .option('--priority <n>', 'New priority')
    .action(
      async (
        ref: string,
        opts: { title?: string; notes?: string; priority?: string },
        cmd: Command,
      ) => {
        const ctx = resolveContext(cmd);
        const emit = createEmitter(ctx.output, cmd);
        try {
          const item = await resolveItem(ctx, ref);
          const result = await ctx.client.call<BacklogUpdateResult>('backlog.update', {
            itemId: item.id,
            ...(opts.title ? { title: opts.title } : {}),
            ...(opts.notes ? { notes: opts.notes } : {}),
            ...(opts.priority ? { priority: Number(opts.priority) } : {}),
          });
          if (emit.machine) emit.ok(result);
          else ctx.output.write(`${green('Updated')} ${cyan(item.sourceRef ?? item.id)}\n`);
        } catch (err) {
          emit.fail(err);
        }
      },
    );

  backlog
    .command('enqueue <ref>')
    .description('Queue a backlog item for dispatch')
    .action(async (ref: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const item = await resolveItem(ctx, ref);
        const result = await ctx.client.call<BacklogEnqueueResult>('backlog.enqueue', {
          itemId: item.id,
        });
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
        const item = await resolveItem(ctx, ref);
        const enqueue = await ctx.client.call<BacklogEnqueueResult>('backlog.enqueue', {
          itemId: item.id,
        });
        const tick = await ctx.client.call('backlog.autoDispatchTick', {});
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
        const item = await resolveItem(ctx, ref);
        const result = await ctx.client.call<BacklogCloseShippedResult>('backlog.closeShipped', {
          itemId: item.id,
          ...(opts.pr ? { prRef: opts.pr } : {}),
          ...(opts.note ? { note: opts.note } : {}),
        });
        if (emit.machine) emit.ok(result);
        else
          ctx.output.write(
            `${green('Closed as shipped')} ${cyan(item.sourceRef ?? item.id)}${opts.pr ? ` (${opts.pr})` : ''}\n`,
          );
      } catch (err) {
        emit.fail(err);
      }
    });
}

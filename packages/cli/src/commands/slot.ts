import type { Command } from 'commander';

import type { EventFrame, ScriptActionResult, SlotCheckResult } from '@farmslot/protocol';

import { resolveContext } from '../context.js';
import { formatSlotCheck } from '../formatters/slot.js';
import { withProgress } from '../progress.js';

function handleStreamEvents(event: EventFrame): void {
  const payload = event.payload as any;
  if (payload?.data) {
    process.stderr.write(payload.data);
  }
}

export function registerSlotCommand(program: Command): void {
  const slot = program.command('slot').description('Slot lifecycle operations');

  slot
    .command('check')
    .description('Check slot health')
    .argument('<id>', 'Slot ID')
    .action(async (id: string, _: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const result = await withProgress(
          `Checking ${id}`,
          () => client.call<SlotCheckResult>('slot.check', { slotId: id }),
          !output.json,
        );
        if (output.json) {
          output.writeJson(result);
        } else {
          output.write(formatSlotCheck(result));
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  slot
    .command('prepare')
    .description('Prepare slot for dispatch')
    .argument('<id>', 'Slot ID')
    .option('--branch <name>', 'Branch to checkout')
    .option('--merge-main', 'Merge main after checkout')
    .option('--flow-type <type>', 'Flow type')
    .option('--app <path>', 'Project-specific app selector, e.g. apps/sherpa-voice')
    .option(
      '--var <key=value>',
      'Project-scoped var passed to preflight as FARMSLOT_VAR_<KEY> (repeatable)',
      (value: string, acc: Record<string, string>) => {
        const eq = value.indexOf('=');
        if (eq <= 0) throw new Error(`--var expects key=value, got '${value}'`);
        acc[value.slice(0, eq)] = value.slice(eq + 1);
        return acc;
      },
      {} as Record<string, string>,
    )
    .action(async (id: string, opts: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const vars: Record<string, string> = opts.var ?? {};
      const params = {
        slotId: id,
        branch: opts.branch,
        mergeMain: opts.mergeMain,
        flowType: opts.flowType,
        app: opts.app,
        vars: Object.keys(vars).length > 0 ? vars : undefined,
      };
      try {
        if (output.json) {
          const result = await client.call<ScriptActionResult>('slot.prepare', params);
          output.writeJson(result);
        } else {
          await client.callWithEvents<ScriptActionResult>(
            'slot.prepare',
            params,
            handleStreamEvents,
          );
          output.write(`Prepare complete for ${id}\n`);
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  slot
    .command('release')
    .description('Release slot')
    .argument('<id>', 'Slot ID')
    .option('--keep-warm', 'Keep Metro/device running')
    .option('--keep-work', 'Keep branch and changes')
    .option('--skip-artifacts', 'Skip artifact collection')
    .option('--reset', 'Force git reset even with uncommitted work')
    .option('--kill-tmux', 'Kill tmux session after release')
    .action(async (id: string, opts: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const params = {
        slotId: id,
        keepWarm: opts.keepWarm,
        keepWork: opts.keepWork,
        skipArtifacts: opts.skipArtifacts,
        forceReset: opts.reset,
        killTmux: opts.killTmux,
      };
      try {
        if (output.json) {
          const result = await client.call<ScriptActionResult>('slot.release', params);
          output.writeJson(result);
        } else {
          await client.callWithEvents<ScriptActionResult>(
            'slot.release',
            params,
            handleStreamEvents,
          );
          output.write(`Release complete for ${id}\n`);
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  slot
    .command('recycle')
    .description('Recycle slot (release + prepare)')
    .argument('<id>', 'Slot ID')
    .action(async (id: string, _: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        if (output.json) {
          const result = await client.call<ScriptActionResult>('slot.recycle', { slotId: id });
          output.writeJson(result);
        } else {
          await client.callWithEvents<ScriptActionResult>(
            'slot.recycle',
            { slotId: id },
            handleStreamEvents,
          );
          output.write(`Recycle complete for ${id}\n`);
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

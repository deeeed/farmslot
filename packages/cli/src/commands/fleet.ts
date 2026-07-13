import type { Command } from 'commander';

import { type FleetStatusResult, selectSlot } from '@farmslot/protocol';

import { resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { formatFleetStatus } from '../formatters/fleet.js';
import { withProgress } from '../progress.js';

export function registerFleetCommand(program: Command): void {
  const fleet = program.command('fleet').description('Fleet management');

  fleet
    .command('status')
    .description('Show fleet status')
    .option('--force-refresh', 'Force refresh from machines')
    .action(async (opts: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const result = await withProgress(
          'Fetching fleet status',
          () => client.call<FleetStatusResult>('fleet.status', { forceRefresh: opts.forceRefresh }),
          !emit.machine,
        );
        if (emit.machine) {
          emit.ok(result);
        } else {
          output.write(formatFleetStatus(result));
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  const FIND_SLOT_ACTIONS: Record<string, string> = {
    FLEET_STALE: 'Re-probe the fleet first: `farmslot fleet status --force-refresh`.',
    SLOT_NOT_FOUND: 'List slot ids with `farmslot fleet status`.',
    SLOT_UNAVAILABLE: 'Pick another slot or wait: `farmslot fleet status` shows each state.',
    NO_PROJECT_SLOTS:
      'Check the project name (`farmslot config projects`) or add slots for it to a pool.',
    NO_SLOT_AVAILABLE:
      'Free a slot or check the fleet: `farmslot fleet status`. Details list each blocked slot.',
  };

  fleet
    .command('find-slot')
    .description('Pick the best free slot for a project (or validate a specific slot)')
    .option('--project <name>', 'Project to find a slot for')
    .option('--slot <slotId>', 'Validate this specific slot instead of picking one')
    .action(async (opts: { project?: string; slot?: string }, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        if (!opts.project && !opts.slot) {
          throw Object.assign(new Error('Either --project or --slot is required.'), {
            code: 'USAGE_ERROR',
            userAction:
              'Run `farmslot fleet find-slot --project <name>` or `farmslot fleet find-slot --slot <slotId>`.',
          });
        }
        const status = await withProgress(
          'Fetching fleet status',
          () => client.call<FleetStatusResult>('fleet.status'),
          !emit.machine,
        );
        const result = selectSlot(status.fleet, {
          project: opts.project,
          slotId: opts.slot,
        });
        if (!result.ok) {
          throw Object.assign(new Error(result.reason), {
            code: result.code,
            userAction: FIND_SLOT_ACTIONS[result.code],
            details: result.details,
          });
        }
        if (emit.machine) {
          emit.ok({ slot: result.slot });
        } else {
          output.write(`${result.slot.slot}\n`);
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  fleet
    .command('refresh')
    .description('Force refresh fleet status')
    .action(async (_: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        // fleet.refresh already returns the freshly probed fleet — a second
        // forceRefresh status call would run the whole machine probe again.
        const result = await withProgress(
          'Refreshing fleet',
          () => client.call<FleetStatusResult>('fleet.refresh'),
          !emit.machine,
        );
        if (emit.machine) {
          emit.ok(result);
        } else {
          output.write(formatFleetStatus(result));
        }
      } catch (err) {
        emit.fail(err);
      }
    });
}

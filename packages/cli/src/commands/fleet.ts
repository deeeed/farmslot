import type { Command } from 'commander';

import type { FleetStatusResult } from '@farmslot/protocol';

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

import type { Command } from 'commander';

import type { FleetStatusResult } from '@farmslot/protocol';

import { resolveContext } from '../context.js';
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
      try {
        const result = await withProgress(
          'Fetching fleet status',
          () => client.call<FleetStatusResult>('fleet.status', { forceRefresh: opts.forceRefresh }),
          !output.json,
        );
        if (output.json) {
          output.writeJson(result);
        } else {
          output.write(formatFleetStatus(result));
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  fleet
    .command('refresh')
    .description('Force refresh fleet status')
    .action(async (_: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        await withProgress('Refreshing fleet', () => client.call('fleet.refresh'), !output.json);
        const result = await withProgress(
          'Fetching fleet status',
          () => client.call<FleetStatusResult>('fleet.status', { forceRefresh: true }),
          !output.json,
        );
        if (output.json) {
          output.writeJson(result);
        } else {
          output.write(formatFleetStatus(result));
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

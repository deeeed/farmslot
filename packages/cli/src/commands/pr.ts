import type { Command } from 'commander';

import type { PRListResult, PRStatusResult } from '@farmslot/protocol';

import { resolveContext } from '../context.js';
import { isMachineMode } from '../envelope.js';
import { formatPRList, formatPRStatus } from '../formatters/pr.js';
import { withProgress } from '../progress.js';

export function registerPRCommand(program: Command): void {
  const pr = program.command('pr').description('PR status and monitoring');

  pr.command('status')
    .description('Show PR status')
    .argument('<num>', 'PR number')
    .action(async (num: string, _: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const result = await withProgress(
          `Fetching PR #${num}`,
          () => client.call<PRStatusResult>('pr.status', { pr: Number(num) }),
          !isMachineMode(output),
        );
        if (output.json) {
          output.writeJson(result);
        } else {
          output.write(formatPRStatus(result.pr));
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  pr.command('list')
    .description('List active PRs')
    .option('--project <name>', 'Filter by project')
    .option('--cached', "Accept the gateway's warm copy instead of waiting for a fresh GitHub read")
    .action(async (opts: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        // A one-shot command exits before any background refresh lands, so
        // it asks for fresh data unless the caller opts into the warm copy.
        const result = await withProgress(
          'Fetching PRs',
          () =>
            client.call<PRListResult>('pr.list', {
              project: opts.project,
              force: !opts.cached,
            }),
          !isMachineMode(output),
        );
        if (output.json) {
          output.writeJson(result);
        } else {
          if (opts.cached && result.fetchedAt)
            output.write(
              `Fetched ${result.fetchedAt}${result.refreshing ? ' (gateway refreshing)' : ''}`,
            );
          output.write(formatPRList(result.prs));
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

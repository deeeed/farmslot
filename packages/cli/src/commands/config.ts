import type { Command } from 'commander';

import type { ConfigPoolsResult, ConfigProjectsResult } from '@farmslot/protocol';

import { bold, dim } from '../colors.js';
import { resolveContext } from '../context.js';
import { withProgress } from '../progress.js';

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('View pool and project configuration');

  config
    .command('pools')
    .description('Show pool configurations')
    .action(async (_: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const result = await withProgress(
          'Fetching pools',
          () => client.call<ConfigPoolsResult>('config.pools'),
          !output.json,
        );
        if (output.json) {
          output.writeJson(result);
        } else {
          for (const pool of result.pools) {
            output.write(
              `${bold(pool.machine)}  ${dim(`${pool.platform}/${pool.os}`)}  ${pool.host}\n`,
            );
            for (const slot of pool.slots) {
              const mode = slot.mode !== 'dispatch' ? dim(` [${slot.mode}]`) : '';
              output.write(`  ${slot.id}${mode}\n`);
            }
            output.write('\n');
          }
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  config
    .command('projects')
    .description('Show project configurations')
    .action(async (_: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const result = await withProgress(
          'Fetching projects',
          () => client.call<ConfigProjectsResult>('config.projects'),
          !output.json,
        );
        if (output.json) {
          output.writeJson(result);
        } else {
          for (const proj of result.projects) {
            output.write(`${bold(proj.name)}\n`);
            output.write(`  repo:    ${proj.repoUrl}\n`);
            output.write(`  branch:  ${proj.defaultBranch}\n`);
            if (proj.ci?.watchChecks?.length) {
              output.write(`  checks:  ${dim(proj.ci.watchChecks.join(', '))}\n`);
            }
            output.write('\n');
          }
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

import { resolve } from 'node:path';

import type { Command } from 'commander';

import { repoRoot } from '../onboarding/workspace.js';
import { OutputContext } from '../output.js';

import { createRoadmapPromotionRequest } from './roadmap-promotion-request.js';

interface RequestPromotionOptions {
  itemId?: string;
  itemFile?: string;
  title?: string;
  targetProjects?: string;
  roadmapRoute?: string;
}

export function registerRoadmapCommand(program: Command): void {
  const roadmap = program.command('roadmap').description('Roadmap planning helpers');

  roadmap
    .command('request-promotion')
    .description('Create a human decision to promote a refined roadmap item into backlog specs')
    .requiredOption('--item-id <id>', 'Roadmap item id')
    .option('--item-file <path>', 'Roadmap item markdown path')
    .option('--title <title>', 'Roadmap item title')
    .option('--target-projects <projects>', 'Comma-separated target projects')
    .option('--roadmap-route <hash>', 'Command Center roadmap hash route')
    .action(async (opts: RequestPromotionOptions, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      try {
        const result = await createRoadmapPromotionRequest(resolveFarmslotRoot(), {
          itemId: opts.itemId ?? '',
          itemFile: opts.itemFile,
          title: opts.title,
          targetProjects: opts.targetProjects,
          roadmapRoute: opts.roadmapRoute,
        });
        if (output.json) {
          output.writeJson(result);
        } else {
          output.write(`Created roadmap promotion request: ${result.decisionPath}\n`);
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function resolveFarmslotRoot(): string {
  return resolve(process.env.FARMSLOT_ROOT || repoRoot);
}

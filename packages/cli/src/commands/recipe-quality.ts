import type { Command } from 'commander';

import type { CliOptions } from '@farmslot/recipe-cli/harness';

import { errorEnvelope } from '../envelope.js';
import { OutputContext } from '../output.js';

import { projectRecipeHostOptions, recipeProjectOptions } from './recipe-project.js';
import { taskHelperArgv } from './task.js';

export function registerRecipeQualityCommand(recipe: Command): void {
  const quality = recipe
    .command('quality')
    .description('Build canonical quality artifacts or request explicit project advice');
  for (const operation of ['build', 'plan', 'advise', 'advisor-status'] as const) {
    const command = recipeProjectOptions(quality.command(operation))
      .description(
        operation === 'build'
          ? 'Validate and build the quality artifact'
          : operation === 'advisor-status'
            ? 'Inspect advisor policy without requesting advice'
            : `Request explicit recipe ${operation}`,
      )
      .option('--target <path>', 'Product checkout')
      .option('--input <path>', 'Compact quality verdict')
      .option('--output <path>', 'Output artifact');
    if (operation !== 'build') {
      for (const flag of [
        '--recipe <path>',
        '--task <path>',
        '--evidence <path>',
        '--params <json>',
        '--advisor <provider>',
        '--advisor-model <model>',
        '--advisor-stages <csv>',
      ])
        command.option(flag);
    }
    command.action(async () => {
      const options: CliOptions = { ...command.optsWithGlobals() };
      try {
        const shared = await import('@farmslot/recipe-cli/harness');
        if (operation === 'build') {
          process.exitCode = await shared.handleRecipeQuality([
            operation,
            ...taskHelperArgv(command),
          ]);
          return;
        }
        process.exitCode = await shared.withProjectRecipeHost(
          {
            ...(await projectRecipeHostOptions('recipe-quality', undefined, options)),
            deferOutput: false,
          },
          async ({ provider }) => {
            if (!provider.commandOptions?.recipeQuality)
              throw shared.usageError(
                'The selected provider does not declare recipe quality advice.',
              );
            return shared.handleRecipeQuality(
              [operation, ...taskHelperArgv(command)],
              provider.commandOptions.recipeQuality,
            );
          },
        );
      } catch (error) {
        new OutputContext(true).writeJson(errorEnvelope(`recipe.quality.${operation}`, error));
        process.exitCode =
          error instanceof Error && 'exitCode' in error && typeof error.exitCode === 'number'
            ? error.exitCode
            : 1;
      }
    });
  }
}

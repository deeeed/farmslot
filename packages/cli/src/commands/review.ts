import type { Command } from 'commander';

import type { CliOptions } from '@farmslot/recipe-cli/harness';

import { errorEnvelope } from '../envelope.js';
import { OutputContext } from '../output.js';

import { projectRecipeHostOptions, recipeProjectOptions } from './recipe-project.js';
import { taskHelperArgv } from './task.js';

export function registerReviewCommand(program: Command): void {
  const review = program
    .command('review')
    .description('Compose review rules from the selected project and libraries');
  for (const operation of ['checklist', 'domain'] as const) {
    const command = recipeProjectOptions(review.command(operation))
      .description(
        operation === 'checklist'
          ? 'Materialize a review checklist'
          : 'Resolve ownership of changed files',
      )
      .option('--target <path>', 'Checkout to review')
      .option('--domain <name>', 'Declared domain')
      .option('--base <ref>', 'Diff base');
    if (operation === 'checklist')
      command
        .option('--since <ref>', 'Incremental review since this revision')
        .option('--out <path>', 'Write the generated checklist');
    command.action(async () => {
      const options: CliOptions = { ...command.optsWithGlobals() };
      try {
        const shared = await import('@farmslot/recipe-cli/harness');
        process.exitCode = await shared.withProjectRecipeHost(
          { ...(await projectRecipeHostOptions('review', undefined, options)), deferOutput: false },
          async ({ provider }) => {
            if (!provider.commandOptions?.review)
              throw shared.usageError('The selected provider does not declare review rules.');
            return shared.handleReview(
              [operation, ...taskHelperArgv(command)],
              provider.commandOptions.review,
            );
          },
        );
      } catch (error) {
        new OutputContext(true).writeJson(errorEnvelope(`review.${operation}`, error));
        process.exitCode =
          error instanceof Error && 'exitCode' in error && typeof error.exitCode === 'number'
            ? error.exitCode
            : 1;
      }
    });
  }
}

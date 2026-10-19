import { type Command, Option } from 'commander';

import {
  getRecipeActionManifestActionNames,
  Methods,
  type RecipeActionManifestDocument,
  type RecipeProjectHookCommandResult,
  type RecipeProjectHookName,
  type RecipeProjectHookRunResult,
  type RecipeValidationFinding,
  type RecipeValidationResult,
} from '@farmslot/protocol';
import type {
  ArtifactValidationResult,
  RecipeArtifactsValidateOptions,
} from '@farmslot/recipe-cli/harness';
import {
  applyTaskLocalInvocationTrust,
  createRecipeRunner,
  createStandardCoreAdapters,
  type RecipeRunRequest,
  resolveRecipeLibrarySources,
  resolveRecipeRunSelection,
  resolveRecipeTrustInput,
} from '@farmslot/recipe-runner';
import {
  parseRecipeParamAssignments,
  readRecipeCliJsonFile,
  resolveRecipeCliPath,
  validateRecipeCliInput,
} from '@farmslot/recipe-runner/cli/support';

import { green, red, yellow } from '../colors.js';
import { resolveContext } from '../context.js';
import { createEmitter, isMachineMode } from '../envelope.js';
import { OutputContext } from '../output.js';
import { withProgress } from '../progress.js';

import {
  collectRecipeOption,
  projectRecipeHostOptions,
  recipeProjectOptions,
  registerProjectActionsCommand,
  registerProjectExecutionCommand,
  registerProjectLifecycleCommands,
} from './recipe-project.js';
import { resolveRecipeProjectHookGatewayTimeoutMs } from './recipe-project-hook-timeout.js';
import { registerRecipeQualityCommand } from './recipe-quality.js';

interface RecipeValidateOptions {
  artifactManifest?: string;
  artifactDir?: string;
  actionManifest?: string;
  librarySource?: string[];
}

interface RecipeRunOptions {
  artifactsDir?: string;
  actionManifest?: string;
  projectRoot?: string;
  sourceTrust?: string;
  sourceKind?: string;
  sourceName?: string;
  sourceDigest?: string;
  approvePlan?: string;
  adapter?: string;
  librarySource?: string[];
}

interface RecipeProjectHookOptions {
  project?: string;
  slot?: string;
  timeoutMs?: string;
  recipePath?: string;
  artifactsDir?: string;
}

function statusLabel(status: RecipeValidationResult['status']): string {
  switch (status) {
    case 'valid':
      return green('valid');
    case 'invalid':
    default:
      return red('invalid');
  }
}

function findingLabel(finding: RecipeValidationFinding): string {
  const prefix = finding.severity === 'error' ? red('error') : yellow('warning');
  return `${prefix} ${finding.code} ${finding.path}: ${finding.message}`;
}

function formatArtifactValidationResult(result: ArtifactValidationResult): string {
  const lines = [
    `Recipe artifact package: ${runStatusLabel(result.status)} (${result.artifactDir})`,
    `Validation: ${statusLabel(result.recipe.status)} (${result.recipe.summary.errors} errors, ${result.recipe.summary.warnings} warnings)`,
    '',
  ];
  for (const check of result.checks) {
    lines.push(`- ${runStatusLabel(check.status)} ${check.id}: ${check.message}`);
  }
  for (const warning of result.warnings ?? []) lines.push(`- WARN ${warning}`);
  for (const finding of result.recipe.findings) {
    lines.push(`- ${findingLabel(finding)}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function runStatusLabel(status: 'pass' | 'fail' | 'unknown'): string {
  switch (status) {
    case 'pass':
      return green('pass');
    case 'fail':
      return red('fail');
    case 'unknown':
    default:
      return yellow('unknown');
  }
}

function formatValidationResult(result: RecipeValidationResult): string {
  const lines = [
    `Recipe validation: ${statusLabel(result.status)} (${result.summary.errors} errors, ${result.summary.warnings} warnings)`,
  ];
  if (result.findings.length > 0) {
    lines.push('');
    lines.push(...result.findings.map((finding) => `- ${findingLabel(finding)}`));
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function registerRecipeCommand(program: Command): void {
  const recipe = program.command('recipe').description('Checkout recipes and artifact helpers');
  registerRecipeQualityCommand(recipe);
  registerProjectActionsCommand(recipe);
  registerProjectLifecycleCommands(recipe);
  registerProjectExecutionCommand(recipe, 'call');

  recipe
    .command('validate')
    .description(
      'Validate one or more recipe graphs (and an optional artifact package) against the Farmslot Recipe v1 contract',
    )
    .argument('<recipes...>', 'Path(s) to recipe.json files')
    .option('--action-manifest <path>', 'Path to runner action manifest to validate recipe actions')
    .option(
      '--artifact-manifest <path>',
      'Path to artifact-manifest.json to validate (single recipe only)',
    )
    .option(
      '--artifact-dir <path>',
      'Artifact directory; validates required package files and manifest paths (single recipe only)',
    )
    .option(
      '--library-source <spec>',
      'Recipe library source (name=path or path, colon-separated); repeatable. call.refs resolvable here are not reported as unresolved.',
      collectRecipeOption,
      [],
    )
    .action(async (recipePaths: string[], opts: RecipeValidateOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const output = new OutputContext(Boolean(globals.json));

      try {
        if (recipePaths.length > 1 && (opts.artifactDir || opts.artifactManifest)) {
          throw new Error(
            '--artifact-dir/--artifact-manifest validate a single recipe package; pass exactly one recipe.',
          );
        }
        const results: Array<{ recipePath: string; result: RecipeValidationResult }> = [];
        for (const recipePath of recipePaths) {
          const librarySources = await resolveRecipeLibrarySources({
            cliEntries: opts.librarySource,
            recipePath: resolveRecipeCliPath(recipePath),
          });
          const result = await validateRecipeCliInput({
            recipePath,
            actionManifestPath: opts.actionManifest,
            artifactManifestPath: opts.artifactManifest,
            artifactDir: opts.artifactDir,
            librarySources: librarySources.length > 0 ? librarySources : undefined,
          });
          results.push({ recipePath, result });
        }

        if (output.json) {
          output.writeJson(results.length === 1 ? results[0].result : results);
        } else {
          for (const { recipePath, result } of results) {
            if (results.length > 1) output.write(`\n${recipePath}:\n`);
            output.write(formatValidationResult(result));
          }
        }
        if (results.some(({ result }) => result.status === 'invalid')) process.exit(1);
      } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  const artifacts = recipeProjectOptions(
    recipe.command('artifacts').description('Inspect, validate or render retained recipe evidence'),
  )
    .argument('[directory]', 'Artifact package or task directory; defaults to the latest proof')
    .option('--target <path>', 'Checkout whose latest proof to inspect')
    .option('--validate', 'Validate the artifact package and runner provenance')
    .addOption(new Option('--format <format>', 'Output format').choices(['text', 'markdown']))
    .option(
      '--command <text>',
      'Invocation displayed above the authored task run log (Markdown only)',
    )
    .option('--out <file>', 'Write Markdown to this file instead of stdout')
    .action(async (directory: string | undefined, _options: unknown, cmd: Command) => {
      const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
      const emit = createEmitter(output, cmd);
      try {
        const shared = await import('@farmslot/recipe-cli/harness');
        const options = cmd.opts();
        if ((options.out || options.command) && options.format !== 'markdown')
          throw new Error('--out and --command require --format markdown.');
        const context = directory
          ? undefined
          : await shared.resolveProjectContext(
              await projectRecipeHostOptions('artifacts', undefined, options),
            );
        const { result, body } = await shared.renderRetainedArtifactsMarkdown({
          directory,
          candidates: context
            ? shared.readLatestProofJournal(context.target.value, context.project!.runtimeDir)
                .record?.evidencePaths
            : undefined,
          command: options.command,
          out: options.out,
          validate: options.validate,
          format: options.format === 'markdown' ? 'markdown' : 'text',
        });
        const { artifactDir, summary, validation, out } = result;
        if (output.json) output.writeJson(result);
        else if (options.format === 'markdown') {
          output.write(out ? `Markdown: ${out}\n` : body);
          if (validation) output.write(`\nValidation: ${validation.status}\n`);
        } else {
          output.write(`Artifacts: ${artifactDir}\n${JSON.stringify(summary, null, 2)}\n`);
          if (validation) output.write(formatArtifactValidationResult(validation));
        }
        if (validation?.status === 'fail') process.exitCode = 1;
      } catch (error) {
        emit.fail(error);
      }
    });

  artifacts
    .command('validate')
    .description('Validate a Recipe v1 artifact package directory')
    .argument(
      '<artifacts-dir>',
      'Directory containing summary.json, trace.json, and artifact-manifest.json',
    )
    .option('--recipe <path>', 'Resolved recipe.json used for node/artifact cross-checks')
    .option(
      '--require-runner-provenance',
      'Require runner provenance in summary, trace metadata, and artifact manifest',
    )
    .action(async (artifactDir: string, opts: RecipeArtifactsValidateOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const output = new OutputContext(Boolean(globals.json));

      try {
        const { validateRecipeArtifactDirectory } = await import('@farmslot/recipe-cli/harness');
        const result = await validateRecipeArtifactDirectory(artifactDir, opts);
        if (output.json) {
          output.writeJson(result);
        } else {
          output.write(formatArtifactValidationResult(result));
        }
        if (result.status !== 'pass') process.exit(1);
      } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  const projectHook = recipe
    .command('project-hook')
    .description('Inspect or execute Recipe v1 project hooks through the Farmslot gateway');

  projectHook
    .command('command')
    .description('Print the expanded project hook command for a slot')
    .argument('<hook>', 'recipe_action_manifest, recipe_doctor, or recipe_run')
    .requiredOption('--project <project>', 'Farmslot project name')
    .requiredOption('--slot <slot>', 'Farmslot slot id')
    .option('--recipe-path <path>', 'Recipe path on the slot filesystem for recipe_run hooks')
    .option(
      '--artifacts-dir <path>',
      'Artifact output directory on the slot filesystem; required for recipe_run hooks',
    )
    .action(async (hook: RecipeProjectHookName, opts: RecipeProjectHookOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const output = new OutputContext(Boolean(globals.json));
      const { client } = resolveContext(cmd);
      try {
        const result = await withProgress(
          `Resolving ${hook} for ${opts.slot}`,
          () =>
            client.call<RecipeProjectHookCommandResult>(Methods.RECIPE_PROJECT_HOOK_COMMAND, {
              hook,
              project: opts.project,
              slotId: opts.slot,
              recipePath: opts.recipePath,
              artifactsDir: opts.artifactsDir,
            }),
          !isMachineMode(output),
        );
        if (output.json) {
          output.writeJson(result);
        } else {
          output.write(`${result.command}\n`);
        }
      } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  projectHook
    .command('run')
    .description('Run a Recipe v1 project hook for a slot and check its hook-level output contract')
    .argument('<hook>', 'recipe_action_manifest, recipe_doctor, or recipe_run')
    .requiredOption('--project <project>', 'Farmslot project name')
    .requiredOption('--slot <slot>', 'Farmslot slot id')
    .option('--recipe-path <path>', 'Recipe path on the slot filesystem for recipe_run hooks')
    .option(
      '--artifacts-dir <path>',
      'Artifact output directory on the slot filesystem; required for recipe_run hooks',
    )
    .option('--timeout-ms <ms>', 'Hook timeout in milliseconds; defaults to 60000')
    .action(async (hook: RecipeProjectHookName, opts: RecipeProjectHookOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const output = new OutputContext(Boolean(globals.json));
      const timeoutMs = opts.timeoutMs ? Number(opts.timeoutMs) : 60_000;
      try {
        if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
          throw new Error(`Invalid --timeout-ms value: ${opts.timeoutMs}`);
        }
        const { client } = resolveContext(cmd, {
          timeout: resolveRecipeProjectHookGatewayTimeoutMs(globals.timeout, timeoutMs),
        });
        const result = await withProgress(
          `Running ${hook} for ${opts.slot}`,
          () =>
            client.call<RecipeProjectHookRunResult>(Methods.RECIPE_PROJECT_HOOK_RUN, {
              hook,
              project: opts.project,
              slotId: opts.slot,
              timeoutMs,
              recipePath: opts.recipePath,
              artifactsDir: opts.artifactsDir,
            }),
          !isMachineMode(output),
        );
        if (output.json) {
          output.writeJson(result);
        } else {
          output.write(
            `${hook}: ${runStatusLabel(result.validation.status)}\n${result.stdout.trimEnd()}\n`,
          );
        }
      } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  registerProjectExecutionCommand(recipe, 'run', async (recipePath, paramAssignments, cmd) => {
    const opts = cmd.opts<RecipeRunOptions>();
    const globals = cmd.optsWithGlobals();
    const output = new OutputContext(Boolean(globals.json));
    const emit = createEmitter(output, cmd);

    try {
      if (!opts.artifactsDir) throw new Error('Missing --artifacts-dir.');
      if (!opts.actionManifest) throw new Error('Missing --action-manifest.');
      const actionManifest = await readRecipeCliJsonFile(opts.actionManifest);
      const runner = createRecipeRunner({
        actionManifest: actionManifest as RecipeActionManifestDocument,
        adapters: createStandardCoreAdapters({
          actions: getRecipeActionManifestActionNames(actionManifest),
        }),
        defaultSource: {
          kind: 'operator',
          trust: 'trusted',
          name: '@farmslot/cli',
        },
      });
      const trust = resolveRecipeTrustInput({
        sourceTrust: opts.sourceTrust,
        sourceKind: opts.sourceKind,
        sourceName: opts.sourceName,
        sourceDigest: opts.sourceDigest,
        approvalDigest: opts.approvePlan,
      });
      const invocationTrust = trust.source?.trust ?? 'trusted';
      const {
        librarySources: sources,
        match,
        selection,
      } = await resolveRecipeRunSelection(recipePath, {
        ...(opts.adapter ? { adapter: opts.adapter } : {}),
        cliEntries: opts.librarySource,
        recipePath: resolveRecipeCliPath(recipePath),
      });
      const librarySources = applyTaskLocalInvocationTrust(sources, invocationTrust);
      const { withRecipeSignals } = await import('@farmslot/recipe-cli/harness');
      const request: RecipeRunRequest = {
        recipePath: match ? match.recipe.path : resolveRecipeCliPath(recipePath),
        ...(selection ? { selection } : {}),
        artifactsDir: resolveRecipeCliPath(opts.artifactsDir),
        projectRoot: opts.projectRoot
          ? resolveRecipeCliPath(opts.projectRoot)
          : resolveRecipeCliPath('.'),
        params: parseRecipeParamAssignments(paramAssignments),
        ...(opts.adapter ? { adapter: opts.adapter } : {}),
        librarySources,
        ...trust,
        // A library recipe keeps its library's trust unless the caller sets one.
        ...(!trust.source && match ? { source: match.recipe.provenance } : {}),
      };
      const result = await withRecipeSignals((signal) => runner.run({ ...request, signal }));
      if (emit.machine) {
        emit.ok(result);
      } else {
        output.write(
          `Recipe run: ${runStatusLabel(result.status)}\nArtifacts: ${result.artifactManifestPath}\n`,
        );
      }
      if (result.status !== 'pass') process.exitCode = 1;
    } catch (error) {
      emit.fail(error);
    }
  });
}

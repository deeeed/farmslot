import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Command } from 'commander';

import {
  getRecipeActionManifestActionNames,
  isRecord,
  mergeRecipeValidationResults,
  Methods,
  type RecipeActionManifestDocument,
  type RecipeProjectHookCommandResult,
  type RecipeProjectHookName,
  type RecipeProjectHookRunResult,
  type RecipeValidationFinding,
  type RecipeValidationResult,
  validateRecipeArtifactPackage,
  validateRecipeDocument,
} from '@farmslot/protocol';
import {
  composeRecipe,
  createRecipeRunner,
  createStandardCoreAdapters,
  parseRecipeLibraryPath,
  type RecipeLibrarySource,
} from '@farmslot/recipe-harness';
import {
  readRecipeCliJsonFile,
  resolveRecipeCliPath,
  validateRecipeCliInput,
} from '@farmslot/recipe-harness/cli/support';

import { green, red, yellow } from '../colors.js';
import { resolveContext } from '../context.js';
import { isMachineMode } from '../envelope.js';
import { OutputContext } from '../output.js';
import { withProgress } from '../progress.js';

import { resolveRecipeProjectHookGatewayTimeoutMs } from './recipe-project-hook-timeout.js';

interface RecipeValidateOptions {
  artifactManifest?: string;
  artifactDir?: string;
  actionManifest?: string;
  librarySource?: string[];
  emitResolved?: boolean;
}

interface RecipeArtifactsValidateOptions {
  recipe?: string;
  requireRunnerProvenance?: boolean;
}

interface RecipeRunOptions {
  artifactsDir?: string;
  actionManifest?: string;
  projectRoot?: string;
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

function collectLibrarySource(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function emitResolvedRecipeArtifact(
  recipePath: string,
  librarySources: RecipeLibrarySource[],
): Promise<RecipeValidationResult | undefined> {
  const resolvedRecipePath = resolveRecipeCliPath(recipePath);
  const recipe = await readRecipeCliJsonFile(recipePath);
  const { resolved, flowCount } = await composeRecipe(recipe, {
    projectRoot: process.env.INIT_CWD ?? process.cwd(),
    recipeDir: path.dirname(resolvedRecipePath),
    librarySources: librarySources.length > 0 ? librarySources : undefined,
  });
  // A recipe that composes no flows is already self-contained; recipe.json is the
  // full composition, so there is nothing extra to emit or validate.
  if (flowCount === 0) return undefined;
  const outputPath = path.join(path.dirname(resolvedRecipePath), 'resolved-recipe.json');
  await writeFile(outputPath, `${JSON.stringify(resolved, null, 2)}\n`);
  // Validate the emitted composition in full so the static resolve-check fails when
  // the composed artifact is not self-contained.
  return validateRecipeDocument(resolved);
}

function findingLabel(finding: RecipeValidationFinding): string {
  const prefix = finding.severity === 'error' ? red('error') : yellow('warning');
  return `${prefix} ${finding.code} ${finding.path}: ${finding.message}`;
}

interface ArtifactValidationCheck {
  id: string;
  status: 'pass' | 'fail';
  message: string;
}

interface ArtifactValidationResult {
  status: 'pass' | 'fail';
  artifactDir: string;
  checks: ArtifactValidationCheck[];
  recipe: RecipeValidationResult;
}

const TERMINAL_RECIPE_STATUSES = new Set(['pass', 'fail', 'unknown']);

function addArtifactCheck(
  checks: ArtifactValidationCheck[],
  id: string,
  status: ArtifactValidationCheck['status'],
  message: string,
): void {
  checks.push({ id, status, message });
}

async function readArtifactJson(artifactDir: string, relativePath: string): Promise<unknown> {
  const filePath = path.join(artifactDir, relativePath);
  let text: string;
  try {
    text = await readFile(filePath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${relativePath}: ${message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${relativePath}: ${message}`);
  }
}

async function readArtifactJsonIfPresent(
  artifactDir: string,
  relativePath: string,
): Promise<{ value?: unknown; error?: string }> {
  try {
    return { value: await readArtifactJson(artifactDir, relativePath) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function listRelativeArtifactFiles(root: string): Promise<string[]> {
  const output: string[] = [];

  async function visit(relativeDir: string): Promise<void> {
    const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await visit(relativePath);
      } else if (entry.isFile()) {
        output.push(relativePath.split(path.sep).join('/'));
      }
    }
  }

  await visit('');
  return output.sort();
}

function hasSummaryRunnerProvenance(summary: unknown): boolean {
  return readRunnerProvenance(summary, 'runner') !== null;
}

function hasTraceRunnerProvenance(trace: unknown): boolean {
  return isRecord(trace) && readRunnerProvenance(trace.metadata, 'runner') !== null;
}

function hasManifestRunnerProvenance(manifest: unknown): boolean {
  return isRecord(manifest) && readRunnerProvenance(manifest.provenance, 'runner') !== null;
}

function readRunnerProvenance(parent: unknown, field: string): Record<string, unknown> | null {
  if (!isRecord(parent)) return null;
  const runner = parent[field];
  if (!isRecord(runner)) return null;
  const source = runner.source;
  const ref = runner.git_ref ?? runner.gitRef ?? runner.ref ?? runner.commit;
  if (typeof source !== 'string' || source.trim() === '') return null;
  if (typeof ref !== 'string' || ref.trim() === '') return null;
  return runner;
}

function canonicalRunnerIdentity(runner: Record<string, unknown>): string | null {
  const source = runner.source;
  const ref = runner.git_ref ?? runner.gitRef ?? runner.ref ?? runner.commit;
  if (typeof source !== 'string' || source.trim() === '') return null;
  if (typeof ref !== 'string' || ref.trim() === '') return null;
  return JSON.stringify({ source: source.trim(), ref: ref.trim() });
}

function runnerProvenanceMatches(summary: unknown, trace: unknown, manifest: unknown): boolean {
  const summaryRunner = readRunnerProvenance(summary, 'runner');
  const traceRunner = isRecord(trace) ? readRunnerProvenance(trace.metadata, 'runner') : null;
  const manifestRunner = isRecord(manifest)
    ? readRunnerProvenance(manifest.provenance, 'runner')
    : null;
  if (!summaryRunner || !traceRunner || !manifestRunner) return false;
  const canonical = canonicalRunnerIdentity(summaryRunner);
  return (
    canonical !== null &&
    canonicalRunnerIdentity(traceRunner) === canonical &&
    canonicalRunnerIdentity(manifestRunner) === canonical
  );
}

function readTraceEntries(trace: unknown): Record<string, unknown>[] | null {
  const entries = Array.isArray(trace) ? trace : isRecord(trace) ? trace.entries : null;
  if (!Array.isArray(entries)) return null;
  return entries.filter(isRecord);
}

function traceCounts(trace: unknown): { passed: number; failed: number; unknown: number } | null {
  const entries = readTraceEntries(trace);
  if (!entries) return null;
  let passed = 0;
  let failed = 0;
  let unknown = 0;
  for (const entry of entries) {
    if (entry.status === 'fail' || entry.ok === false) {
      failed += 1;
    } else if (entry.status === 'pass' || entry.ok === true) {
      passed += 1;
    } else {
      unknown += 1;
    }
  }
  return { passed, failed, unknown };
}

function traceStatus(trace: unknown): 'pass' | 'fail' | 'unknown' | null {
  const counts = traceCounts(trace);
  if (!counts) return null;
  if (counts.failed > 0) return 'fail';
  if (counts.unknown > 0 || counts.passed === 0) return 'unknown';
  return 'pass';
}

function traceStatusMatchesSummary(summaryStatus: unknown, trace: unknown): boolean {
  const status = traceStatus(trace);
  return typeof summaryStatus === 'string' && status === summaryStatus;
}

function traceCountsMatchSummary(summary: unknown, trace: unknown): boolean {
  if (!isRecord(summary)) return false;
  const counts = traceCounts(trace);
  if (!counts) return false;
  if (typeof summary.passed === 'number' && summary.passed !== counts.passed) return false;
  if (typeof summary.failed === 'number' && summary.failed !== counts.failed) return false;
  if (
    typeof summary.total === 'number' &&
    summary.total !== counts.passed + counts.failed + counts.unknown
  ) {
    return false;
  }
  return true;
}

export async function validateRecipeArtifactDirectory(
  artifactDirInput: string,
  opts: RecipeArtifactsValidateOptions,
): Promise<ArtifactValidationResult> {
  const artifactDir = resolveRecipeCliPath(artifactDirInput);
  const checks: ArtifactValidationCheck[] = [];
  const artifactPaths = await listRelativeArtifactFiles(artifactDir);
  const artifactPathSet = new Set(artifactPaths);
  const reads = {
    summary: await readArtifactJsonIfPresent(artifactDir, 'summary.json'),
    trace: await readArtifactJsonIfPresent(artifactDir, 'trace.json'),
    manifest: await readArtifactJsonIfPresent(artifactDir, 'artifact-manifest.json'),
    recipe: artifactPathSet.has('recipe.json')
      ? await readArtifactJsonIfPresent(artifactDir, 'recipe.json')
      : { value: undefined },
    resolvedRecipe: artifactPathSet.has('resolved-recipe.json')
      ? await readArtifactJsonIfPresent(artifactDir, 'resolved-recipe.json')
      : { value: undefined },
  };

  for (const [requiredPath, read] of [
    ['summary.json', reads.summary],
    ['trace.json', reads.trace],
    ['artifact-manifest.json', reads.manifest],
  ] as const) {
    addArtifactCheck(
      checks,
      `file.${requiredPath}`,
      artifactPathSet.has(requiredPath) && !read.error ? 'pass' : 'fail',
      !artifactPathSet.has(requiredPath)
        ? `Missing required Recipe v1 artifact ${requiredPath}.`
        : read.error
          ? read.error
          : `${requiredPath} exists.`,
    );
  }

  // recipe.json and resolved-recipe.json are optional, but a present-but-unreadable
  // one must fail — never silently skip the recipe/composition validation.
  for (const optionalPath of ['recipe.json', 'resolved-recipe.json'] as const) {
    if (!artifactPathSet.has(optionalPath)) continue;
    const read = optionalPath === 'recipe.json' ? reads.recipe : reads.resolvedRecipe;
    addArtifactCheck(
      checks,
      `file.${optionalPath}`,
      read.error ? 'fail' : 'pass',
      read.error ?? `${optionalPath} is readable.`,
    );
  }

  const summary = reads.summary.value;
  const trace = reads.trace.value;
  const manifest = reads.manifest.value;
  // Default to the package's own recipe.json so composition is proven without an
  // explicit --recipe; --recipe overrides it for cross-checking a resolved recipe.
  const recipe = opts.recipe ? await readRecipeCliJsonFile(opts.recipe) : reads.recipe.value;

  // validateRecipeArtifactPackage validates the recipe document internally
  // (protocol/recipe/artifact.ts) whenever `recipe` is present, so calling
  // validateRecipeDocument separately here would double-count every finding. Passing
  // runPassed lets it validate the composition in full only for a passing run —
  // matching the runner/gateway — so CLI and gateway verdicts stay in sync.
  const resolvedRecipe = reads.resolvedRecipe.value;
  const recipeValidation = validateRecipeArtifactPackage({
    recipe,
    manifest,
    artifactPaths,
    ...(resolvedRecipe !== undefined ? { resolvedRecipe } : {}),
    // Only a confirmed failure relaxes composition enforcement; unknown/missing status
    // still requires the composition to be proven.
    runPassed: !(isRecord(summary) && summary.status === 'fail'),
  });

  const summaryStatus = isRecord(summary) ? summary.status : undefined;
  addArtifactCheck(
    checks,
    'summary.status',
    typeof summaryStatus === 'string' && TERMINAL_RECIPE_STATUSES.has(summaryStatus)
      ? 'pass'
      : 'fail',
    'summary.json must include terminal status pass, fail, or unknown.',
  );

  addArtifactCheck(
    checks,
    'trace.shape',
    Array.isArray(trace) || (isRecord(trace) && Array.isArray(trace.entries)) ? 'pass' : 'fail',
    'trace.json must be an array or an object with entries[].',
  );
  addArtifactCheck(
    checks,
    'trace.status_matches_summary',
    traceStatusMatchesSummary(summaryStatus, trace) ? 'pass' : 'fail',
    'trace.json terminal status must agree with summary.json status.',
  );
  addArtifactCheck(
    checks,
    'trace.counts_match_summary',
    traceCountsMatchSummary(summary, trace) ? 'pass' : 'fail',
    'trace.json pass/fail counts must agree with summary.json counts when summary counts are present.',
  );

  const manifestStatus = isRecord(manifest) ? manifest.runStatus : undefined;
  addArtifactCheck(
    checks,
    'manifest.status_matches_summary',
    typeof summaryStatus === 'string' && manifestStatus === summaryStatus ? 'pass' : 'fail',
    'artifact-manifest.json runStatus must match summary.json status.',
  );

  if (opts.requireRunnerProvenance) {
    addArtifactCheck(
      checks,
      'runner.provenance.summary',
      hasSummaryRunnerProvenance(summary) ? 'pass' : 'fail',
      'summary.json must include runner provenance at summary.runner.',
    );
    addArtifactCheck(
      checks,
      'runner.provenance.trace',
      hasTraceRunnerProvenance(trace) ? 'pass' : 'fail',
      'trace.json must include runner provenance at trace.metadata.runner.',
    );
    addArtifactCheck(
      checks,
      'runner.provenance.manifest',
      hasManifestRunnerProvenance(manifest) ? 'pass' : 'fail',
      'artifact-manifest.json must include runner provenance at provenance.runner.',
    );
    addArtifactCheck(
      checks,
      'runner.provenance.matches',
      runnerProvenanceMatches(summary, trace, manifest) ? 'pass' : 'fail',
      'Runner provenance must identify the same source/ref in summary, trace metadata, and artifact manifest.',
    );
  }

  const status =
    checks.some((check) => check.status === 'fail') || recipeValidation.status === 'invalid'
      ? 'fail'
      : 'pass';
  return { status, artifactDir, checks, recipe: recipeValidation };
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
  const recipe = program.command('recipe').description('Recipe protocol helpers');

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
      collectLibrarySource,
      [],
    )
    .option(
      '--emit-resolved',
      'Write resolved-recipe.json (the full composition) next to each recipe',
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
        const librarySources = (opts.librarySource ?? []).flatMap((spec) =>
          parseRecipeLibraryPath(spec),
        );

        const results: Array<{ recipePath: string; result: RecipeValidationResult }> = [];
        for (const recipePath of recipePaths) {
          let result = await validateRecipeCliInput({
            recipePath,
            actionManifestPath: opts.actionManifest,
            artifactManifestPath: opts.artifactManifest,
            artifactDir: opts.artifactDir,
            librarySources: librarySources.length > 0 ? librarySources : undefined,
          });
          if (opts.emitResolved) {
            const composed = await emitResolvedRecipeArtifact(recipePath, librarySources);
            if (composed) result = mergeRecipeValidationResults([result, composed]);
          }
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

  const artifacts = recipe.command('artifacts').description('Recipe artifact package helpers');

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

  recipe
    .command('run')
    .description('Run a recipe through the reusable Farmslot recipe harness')
    .argument('<recipe>', 'Path to recipe.json')
    .requiredOption('--artifacts-dir <path>', 'Directory where the v1 artifact package is written')
    .requiredOption('--action-manifest <path>', 'Runner action manifest for this recipe')
    .option(
      '--project-root <path>',
      'Project root used for command execution and artifact indexing',
    )
    .action(async (recipePath: string, opts: RecipeRunOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const output = new OutputContext(Boolean(globals.json));

      try {
        if (!opts.artifactsDir) throw new Error('Missing --artifacts-dir.');
        if (!opts.actionManifest) throw new Error('Missing --action-manifest.');
        const actionManifest = await readRecipeCliJsonFile(opts.actionManifest);
        const runner = createRecipeRunner({
          actionManifest: actionManifest as RecipeActionManifestDocument,
          adapters: createStandardCoreAdapters({
            actions: getRecipeActionManifestActionNames(actionManifest),
          }),
        });
        const result = await runner.run({
          recipePath: resolveRecipeCliPath(recipePath),
          artifactsDir: resolveRecipeCliPath(opts.artifactsDir),
          projectRoot: opts.projectRoot
            ? resolveRecipeCliPath(opts.projectRoot)
            : resolveRecipeCliPath('.'),
        });
        if (output.json) {
          output.writeJson(result);
        } else {
          output.write(
            `Recipe run: ${runStatusLabel(result.status)}\nArtifacts: ${result.artifactManifestPath}\n`,
          );
        }
        if (result.status !== 'pass') process.exit(1);
      } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}

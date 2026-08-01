import { readdir } from 'node:fs/promises';
import path from 'node:path';

import type { Command } from 'commander';

import {
  getRecipeActionManifestActionNames,
  isRecord,
  Methods,
  type RecipeActionManifestDocument,
  type RecipeProjectHookCommandResult,
  type RecipeProjectHookName,
  type RecipeProjectHookRunResult,
  type RecipeValidationFinding,
  type RecipeValidationResult,
  resolvedRecipeArtifactPath,
  validateRecipeArtifactPackage,
} from '@farmslot/protocol';
import {
  applyTaskLocalInvocationTrust,
  createRecipeRunner,
  createStandardCoreAdapters,
  resolveRecipeLibrarySources,
  resolveRecipeTrustInput,
} from '@farmslot/recipe-harness';
import {
  parseRecipeParamAssignments,
  readRecipeCliJsonFile,
  readRecipeCliJsonFileWithinRoot,
  resolveRecipeCliPath,
  validateRecipeCliInput,
} from '@farmslot/recipe-harness/cli/support';

import { green, red, yellow } from '../colors.js';
import { resolveContext } from '../context.js';
import { createEmitter, isMachineMode } from '../envelope.js';
import { OutputContext } from '../output.js';
import { withProgress } from '../progress.js';

import { resolveRecipeProjectHookGatewayTimeoutMs } from './recipe-project-hook-timeout.js';

interface RecipeValidateOptions {
  artifactManifest?: string;
  artifactDir?: string;
  actionManifest?: string;
  librarySource?: string[];
}

interface RecipeArtifactsValidateOptions {
  recipe?: string;
  requireRunnerProvenance?: boolean;
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

function collectLibrarySource(value: string, previous: string[]): string[] {
  return [...previous, value];
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
  return readRecipeCliJsonFileWithinRoot(artifactDir, relativePath);
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
      } else if (entry.isFile() || entry.isSymbolicLink()) {
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
    recipeResolution: artifactPathSet.has('recipe-resolution.json')
      ? await readArtifactJsonIfPresent(artifactDir, 'recipe-resolution.json')
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

  // These files are optional only when the package omits recipe.json. A present but
  // unreadable file always fails.
  for (const optionalPath of ['recipe.json', 'recipe-resolution.json'] as const) {
    if (!artifactPathSet.has(optionalPath)) continue;
    const read = optionalPath === 'recipe.json' ? reads.recipe : reads.recipeResolution;
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
  // Default to the package's own recipe.json; --recipe overrides it for cross-checking.
  const recipe = opts.recipe ? await readRecipeCliJsonFile(opts.recipe) : reads.recipe.value;
  const recipeResolution = reads.recipeResolution.value;
  const resolvedRecipes: Record<string, unknown> = {};
  if (isRecord(recipeResolution) && Array.isArray(recipeResolution.dependencies)) {
    for (const dependency of recipeResolution.dependencies) {
      if (!isRecord(dependency)) continue;
      const artifact = resolvedRecipeArtifactPath(dependency.digest);
      if (!artifact) continue;
      const read = await readArtifactJsonIfPresent(artifactDir, artifact);
      if (read.value !== undefined) resolvedRecipes[String(dependency.digest)] = read.value;
      if (read.error) {
        addArtifactCheck(checks, `file.${artifact}`, 'fail', read.error);
      }
    }
  }
  const recipeValidation = validateRecipeArtifactPackage({
    recipe,
    trace,
    summary,
    manifest,
    artifactPaths,
    recipeResolution,
    resolvedRecipes,
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
    .argument('[params...]', 'Recipe parameters as key=value')
    .requiredOption('--artifacts-dir <path>', 'Directory where the v1 artifact package is written')
    .requiredOption('--action-manifest <path>', 'Runner action manifest for this recipe')
    .option(
      '--project-root <path>',
      'Project root used for command execution and artifact indexing',
    )
    .option('--source-trust <trust>', 'Recipe source trust: trusted, untrusted, or unknown')
    .option('--source-kind <kind>', 'Recipe source kind supplied by the caller')
    .option('--source-name <name>', 'Human-readable recipe source name')
    .option('--source-digest <digest>', 'Caller-computed source digest')
    .option('--approve-plan <digest>', 'Approve exactly one resolved execution-plan digest')
    .option('--adapter <name>', 'Active adapter for adapter-specific library recipes')
    .option(
      '--library-source <spec>',
      'Recipe library source (name=path or path, colon-separated); repeatable',
      collectLibrarySource,
      [],
    )
    .action(
      async (
        recipePath: string,
        paramAssignments: string[],
        opts: RecipeRunOptions,
        cmd: Command,
      ) => {
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
          const librarySources = applyTaskLocalInvocationTrust(
            await resolveRecipeLibrarySources({
              cliEntries: opts.librarySource,
              recipePath: resolveRecipeCliPath(recipePath),
            }),
            invocationTrust,
          );
          const result = await runner.run({
            recipePath: resolveRecipeCliPath(recipePath),
            artifactsDir: resolveRecipeCliPath(opts.artifactsDir),
            projectRoot: opts.projectRoot
              ? resolveRecipeCliPath(opts.projectRoot)
              : resolveRecipeCliPath('.'),
            params: parseRecipeParamAssignments(paramAssignments),
            ...(opts.adapter ? { adapter: opts.adapter } : {}),
            librarySources,
            ...trust,
          });
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
      },
    );
}

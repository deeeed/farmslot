import { existsSync } from 'node:fs';
import path from 'node:path';

import { type Command, Option } from 'commander';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import { validateRecordedEvidencePackage } from '@farmslot/adapter-sdk/evidence';
import {
  digestRecipeDocument,
  getRecipeActionManifestActionNames,
  isRecord,
  Methods,
  type RecipeActionManifestDocument,
  type RecipeConformanceLiveEvidence,
  type RecipeProjectHookCommandResult,
  type RecipeProjectHookName,
  type RecipeProjectHookRunResult,
  type RecipeValidationFinding,
  type RecipeValidationResult,
} from '@farmslot/protocol';
import {
  applyTaskLocalInvocationTrust,
  createRecipeRunner,
  createStandardCoreAdapters,
  type RecipeRunRequest,
  resolveRecipeLibrarySources,
  resolveRecipeTrustInput,
} from '@farmslot/recipe-runner';
import {
  parseRecipeParamAssignments,
  readRecipeCliJsonFile,
  readRecipeCliJsonFileWithinRoot,
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

interface RecipeValidateOptions {
  artifactManifest?: string;
  artifactDir?: string;
  actionManifest?: string;
  librarySource?: string[];
}

interface RecipeArtifactsValidateOptions {
  recipe?: string;
  requireRunnerProvenance?: boolean;
  liveProof?: Pick<
    RecipeConformanceLiveEvidence,
    'smokeTarget' | 'teardownTarget' | 'captureRequired' | 'hudRequired'
  >;
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
  liveEvidence?: RecipeConformanceLiveEvidence;
  warnings?: string[];
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

export async function validateRecipeArtifactDirectory(
  artifactDirInput: string,
  opts: RecipeArtifactsValidateOptions,
): Promise<ArtifactValidationResult> {
  const artifactDir = resolveRecipeCliPath(artifactDirInput);
  const loaded = await readRecordedEvidencePackage(artifactDir);
  const checks: ArtifactValidationCheck[] = loaded.checks;
  const retained = loaded.input;
  const { summary, trace, manifest, artifactDigests } = retained;
  const artifactPaths = retained.artifactPaths ?? [];
  // --recipe cross-checks the retained root; it cannot replace a recorded package's root.
  const recipe = opts.recipe ? await readRecipeCliJsonFile(opts.recipe) : retained.recipe;
  const bundle = { ...retained, recipe };
  if (opts.recipe && retained.recipe !== undefined) {
    addArtifactCheck(
      checks,
      'recipe.matches_retained',
      digestRecipeDocument(recipe) === digestRecipeDocument(retained.recipe) ? 'pass' : 'fail',
      'The supplied recipe must match the retained root recipe.',
    );
  }
  const recorded =
    (isRecord(summary) && typeof summary.recipeRunId === 'string') ||
    artifactPaths.includes('acceptance-status.json');
  const recipeValidation = validateRecordedEvidencePackage({
    ...bundle,
    recipe: recorded ? retained.recipe : recipe,
  });
  let captures: string[] = [];
  const warnings: string[] = [];
  if (opts.liveProof) {
    const { validateRuntimeProof } = await import('@farmslot/recipe-cli/harness');
    try {
      captures = validateRuntimeProof(
        bundle,
        opts.liveProof.smokeTarget,
        opts.liveProof.teardownTarget,
        { ...opts.liveProof, hudRequired: false },
      );
      addArtifactCheck(
        checks,
        'runtime.proof',
        'pass',
        'Runtime effect and authored teardown assertions passed.',
      );
      if (opts.liveProof.hudRequired) {
        // The same immutable bundle already passed state, capture and cleanup checks.
        // HUD observations are advisory; their absence cannot invalidate that proof.
        try {
          validateRuntimeProof(
            bundle,
            opts.liveProof.smokeTarget,
            opts.liveProof.teardownTarget,
            opts.liveProof,
          );
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      addArtifactCheck(
        checks,
        'runtime.proof',
        'fail',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

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
  const liveEvidence =
    status === 'pass' && opts.liveProof
      ? {
          ...opts.liveProof,
          hudRequired: false,
          ...(opts.liveProof.captureRequired || opts.liveProof.hudRequired ? { captures } : {}),
          artifactDir,
          artifacts: await Promise.all(
            [...artifactPaths].sort().map(async (file) => ({
              path: file,
              digest: artifactDigests[file]!,
            })),
          ),
        }
      : undefined;
  return {
    status,
    artifactDir,
    checks,
    recipe: recipeValidation,
    ...(liveEvidence ? { liveEvidence } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
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
    .action(async (directory: string | undefined, _options: unknown, cmd: Command) => {
      const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
      const emit = createEmitter(output, cmd);
      try {
        const shared = await import('@farmslot/recipe-cli/harness');
        const options = cmd.opts();
        const context = directory
          ? undefined
          : await shared.resolveProjectContext(
              await projectRecipeHostOptions('artifacts', undefined, options),
            );
        const candidates = directory
          ? [path.resolve(directory)]
          : (shared.readLatestProofJournal(context!.target.value, context!.project!.runtimeDir)
              .record?.evidencePaths ?? []);
        const packages = candidates
          .flatMap((candidate) => [
            candidate,
            path.join(candidate, 'artifacts'),
            path.join(candidate, 'artifacts/recipe'),
          ])
          .filter((candidate) => existsSync(path.join(candidate, 'artifact-manifest.json')));
        const distinct = [...new Set(packages)];
        if (distinct.length !== 1)
          throw new Error(
            distinct.length
              ? `More than one artifact package matches; select a directory: ${distinct.join(', ')}`
              : 'No retained artifact package found; pass its directory explicitly.',
          );
        const artifactDir = distinct[0]!;
        const summary = await readRecipeCliJsonFileWithinRoot(artifactDir, 'summary.json');
        const manifest = await readRecipeCliJsonFileWithinRoot(
          artifactDir,
          'artifact-manifest.json',
        );
        const validation = options.validate
          ? await validateRecipeArtifactDirectory(artifactDir, { requireRunnerProvenance: true })
          : undefined;
        const result = { artifactDir, summary, manifest, ...(validation ? { validation } : {}) };
        if (output.json) output.writeJson(result);
        else if (options.format === 'markdown') {
          const literal = (value: string) =>
            `<code>${value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</code>`;
          const entries =
            isRecord(manifest) && Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
          output.write(`Recipe evidence: ${literal(artifactDir)}\n\n`);
          output.write(
            `Result: ${literal(isRecord(summary) ? String(summary.status) : 'unknown')}\n\n`,
          );
          for (const entry of entries)
            if (isRecord(entry) && typeof entry.path === 'string')
              output.write(`- ${literal(entry.path)}\n`);
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
      const librarySources = applyTaskLocalInvocationTrust(
        await resolveRecipeLibrarySources({
          cliEntries: opts.librarySource,
          recipePath: resolveRecipeCliPath(recipePath),
        }),
        invocationTrust,
      );
      const { withRecipeSignals } = await import('@farmslot/recipe-cli/harness');
      const request: RecipeRunRequest = {
        recipePath: resolveRecipeCliPath(recipePath),
        artifactsDir: resolveRecipeCliPath(opts.artifactsDir),
        projectRoot: opts.projectRoot
          ? resolveRecipeCliPath(opts.projectRoot)
          : resolveRecipeCliPath('.'),
        params: parseRecipeParamAssignments(paramAssignments),
        ...(opts.adapter ? { adapter: opts.adapter } : {}),
        librarySources,
        ...trust,
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

// run — validate a recipe, then execute it through the engine with bounded
// healing, observation, and the run report; or describe its plan (--plan).

import fs from 'node:fs';
import path from 'node:path';

import type { RecipeNodeEvent } from '@farmslot/adapter-sdk';
import type { RecipeValidationFinding } from '@farmslot/protocol';
import { type RecipeLibrarySource, redactRecipeParams } from '@farmslot/recipe-runner';

import { type ActionCapabilityRefusal, missingActionCapabilities } from '../../action-catalog.js';
import { harnessAdapter } from '../adapters.js';
import {
  actionLibraryContextArgs,
  type RecipeCatalog,
  resolveActionCapabilityMatrix,
} from '../catalog.js';
import { acquireCheckoutLock } from '../checkout-lock.js';
import { color } from '../cli-color.js';
import { recordCommandEvidence } from '../command-journal.js';
import { ProvenanceDriftError } from '../execution-provenance.js';
import { recipeRunning, recipeRunningRefusal } from '../heal-bounds.js';
import { harnessHost } from '../host.js';
import { JsonStreamWriter } from '../json-stream.js';
import {
  applyRuntimeDirOption,
  type CliOptions,
  isRecord,
  optionFlag,
  optionString,
  parseArgs,
  parseRecipeParamAssignments,
  resolveAdapter,
  shellQuote,
  targetPath,
  usageError,
} from '../parse-args.js';
import { validateRunRecipeStatic } from '../recipe-validation.js';
import {
  type ConsoleAllowlist,
  formatRunDiagnosticsForHuman,
  readRunDiagnosticsDocument,
} from '../run-diagnostics.js';
import {
  countRecipeNodes,
  emitHealViolation,
  executeWithHealBounds,
  persistRunEffects,
  preflightRecipe,
  type PreparedRecipeExecution,
  prepareHeal,
  type RecipeEngine,
  type RecipeEngineRunOptions,
  runRecipe,
} from '../run-engine.js';
import { type RunObservers, startRunObservers } from '../run-observers.js';
import { recipeRunOptionsFromCli } from '../run-options.js';
import { indexProductProvenanceArtifact, writeRunReport } from '../run-report.js';
import { checkoutBusyOut, EXIT, usageOut, writeInteractiveProgress } from '../shared.js';
import { type RecipeTrustFailure, recipeTrustFailure } from '../trust.js';

import { handleDescribeRecipe, handleListExecutables } from './discover.js';

/**
 * Resolve and pin the device a `run` or `call` drives, before the engine reads
 * the environment; a refusal is reported as a usage error.
 */
export type DeviceTargeting = (
  command: 'run' | 'call',
  adapter: string,
  options: CliOptions,
) => { ok: true } | { ok: false; code: string; message: string; userAction: string };

export interface RunPlanStep {
  step: string;
  confidence: 'static' | 'conditional';
  status: 'ok' | 'error' | 'planned';
  detail: string;
}

export interface RunCommandOptions<TMutation, TAllowlist extends ConsoleAllowlist> {
  engine: RecipeEngine<TMutation, TAllowlist>;
  targetDevice?: DeviceTargeting;
  // `run --plan`: the host's own static steps after validation, and how it
  // words the app launch a non-headless run performs.
  plan?: { steps?(target: string): RunPlanStep[]; launchDetail?: string };
}

async function validationCapabilityRefusals(
  catalog: RecipeCatalog,
  adapter: string,
  findings: RecipeValidationFinding[],
  librarySources?: RecipeLibrarySource[],
): Promise<ActionCapabilityRefusal[]> {
  const actionNames = findings.flatMap((finding) => {
    if (finding.code !== 'recipe.action_not_declared_by_manifest') return [];
    const match = /^Recipe action ([^ ]+) is not declared by the runner action manifest[.]?$/u.exec(
      finding.message,
    );
    return match?.[1] ? [match[1]] : [];
  });
  if (actionNames.length === 0) return [];
  return missingActionCapabilities(
    adapter,
    actionNames,
    await resolveActionCapabilityMatrix(catalog, librarySources),
  );
}

function capabilityValidationUserAction(
  adapter: string,
  refusals: ActionCapabilityRefusal[],
  libraryContextArgs: string,
): string {
  const capabilities = refusals
    .map((refusal) => `"${refusal.capability}" [${refusal.satisfyingAdapters.join(', ')}]`)
    .join('; ');
  return (
    `Missing action capabilities for ${adapter}, with satisfying adapters: ${capabilities}. ` +
    `Inspect: ${harnessHost().name} actions --matrix${libraryContextArgs} --json; ` +
    'then rerun from a checkout matching ' +
    'a satisfying adapter, splitting the recipe if no single adapter satisfies every capability'
  );
}

export async function handleRun<TMutation, TAllowlist extends ConsoleAllowlist>(
  argv: string[],
  commandOptions: RunCommandOptions<TMutation, TAllowlist>,
): Promise<number> {
  const parsed = parseArgs(argv);
  const host = harnessHost().name;
  const stream = new JsonStreamWriter('run', optionFlag(parsed.options, 'jsonStream'));
  const restoreStdout = stream.isolateStdout();
  const target = targetPath(parsed.options);
  try {
    const exitCode = await handleRunInner(
      parsed.positional,
      parsed.options,
      stream,
      commandOptions,
    );
    stream.complete(exitCode === EXIT.ok ? 'pass' : 'fail', exitCode);
    return exitCode;
  } catch (error) {
    if (error instanceof ProvenanceDriftError) {
      const failure = provenanceFailure(error);
      if (stream.enabled) {
        stream.error(failure);
        stream.complete('fail', error.exitCode);
      } else if (optionFlag(parsed.options, 'json')) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              command: 'run',
              status: 'fail',
              error: failure,
              exitCode: error.exitCode,
            },
            null,
            2,
          ),
        );
      } else {
        console.error(`✗ ${host} run: ${error.message}`);
        console.error(`  Next: ${error.userAction}`);
      }
      return error.exitCode;
    }
    const trustFailure = recipeTrustFailure(error);
    if (trustFailure) {
      if (stream.enabled) {
        stream.error(trustFailure);
        stream.complete('fail', EXIT.validation);
      } else {
        reportTrustFailure('run', trustFailure, optionFlag(parsed.options, 'json'));
      }
      return EXIT.validation;
    }
    const exitCode =
      error !== null &&
      typeof error === 'object' &&
      'exitCode' in error &&
      typeof (error as { exitCode?: unknown }).exitCode === 'number'
        ? (error as { exitCode: number }).exitCode
        : EXIT.runtime;
    stream.error({
      code: exitCode === EXIT.usage ? 'CLI_USAGE_ERROR' : 'RUN_FAILED',
      message: error instanceof Error ? error.message : String(error),
      userAction: `${host} doctor --target ${shellQuote(target)} --json`,
    });
    stream.complete('fail', exitCode);
    throw error;
  } finally {
    restoreStdout();
  }
}

/** The drift a provenance failure reports in an envelope's `error`. */
export function provenanceFailure(error: ProvenanceDriftError): Record<string, unknown> {
  return {
    code: error.code,
    message: error.message,
    userAction: error.userAction,
    provenancePath: error.provenancePath,
    drift: error.drift,
  };
}

/**
 * A recipe trust or approval failure: the `--json` envelope, or the human
 * error with at most ten restricted plan nodes.
 */
export function reportTrustFailure(
  command: 'run' | 'call',
  failure: RecipeTrustFailure,
  json: boolean,
): void {
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command,
          status: 'fail',
          error: failure,
          exitCode: EXIT.validation,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.error(`✗ ${harnessHost().name} ${command}: ${failure.message}`);
  const blocked = failure.details?.blocked;
  if (blocked?.length) {
    console.error('  Restricted plan nodes:');
    for (const node of blocked.slice(0, 10)) {
      const implementation = node.implementation?.digest
        ? ` implementation=${node.implementation.kind ?? 'custom'}@${node.implementation.digest}`
        : '';
      console.error(
        `  - ${node.nodeId}: ${node.action} [${node.capabilities.join(', ')}] source=${node.source}${implementation}`,
      );
    }
    if (blocked.length > 10) console.error(`  - … ${blocked.length - 10} more (use --json)`);
  }
  console.error(`  Next: ${failure.userAction}`);
}

async function handleRunInner<TMutation, TAllowlist extends ConsoleAllowlist>(
  positional: string[],
  options: CliOptions,
  stream: JsonStreamWriter,
  commandOptions: RunCommandOptions<TMutation, TAllowlist>,
): Promise<number> {
  const { engine } = commandOptions;
  const host = harnessHost().name;
  if (
    !optionFlag(options, 'list') &&
    ['domain', 'source', 'sort'].some((name) => optionString(options, name) !== undefined)
  ) {
    throw usageError('--domain, --source, and --sort require run --list.');
  }
  if (
    optionFlag(options, 'describe') &&
    (optionFlag(options, 'list') || optionFlag(options, 'plan'))
  ) {
    const message = '--describe cannot be combined with --list or --plan.';
    const userAction = `choose one: ${host} run --list, ${host} run <recipe> --describe, or ${host} run <recipe> --plan`;
    if (stream.enabled) {
      stream.error({ code: 'CLI_USAGE_ERROR', message, userAction });
      return EXIT.usage;
    }
    return usageOut(optionFlag(options, 'json'), 'run', message, userAction);
  }
  // --list: complete recipes accepted by `run` for the detected adapter.
  if (optionFlag(options, 'list')) {
    if (stream.enabled) {
      const message = '--json-stream is for recipe execution; use run --list --json for discovery.';
      stream.error({
        code: 'JSON_STREAM_UNSUPPORTED_MODE',
        message,
        userAction: `${host} run --list --json`,
      });
      return EXIT.usage;
    }
    return handleListExecutables('run', options, { catalog: engine });
  }
  const targetRecipe = positional[0];
  if (!targetRecipe) throw usageError('run requires <recipe.json>.');
  const paramAssignments = positional.slice(1);
  if (optionFlag(options, 'describe')) {
    if (paramAssignments.length > 0) {
      throw usageError(
        'run --describe does not accept parameter values; inspect the declaration first.',
      );
    }
    if (stream.enabled) {
      const message = '--json-stream is for recipe execution; use --describe --json for discovery.';
      stream.error({
        code: 'JSON_STREAM_UNSUPPORTED_MODE',
        message,
        userAction: `${host} run ${shellQuote(targetRecipe)} --describe --json`,
      });
      return EXIT.usage;
    }
    return handleDescribeRecipe(targetRecipe, options, { catalog: engine });
  }
  const params = parseRecipeParamAssignments(paramAssignments);
  // The runtime directory names where the slot's context and the run's runtime
  // state live, so it applies before the plan and before the slot resolves.
  applyRuntimeDirOption(options);
  if (optionFlag(options, 'plan')) {
    return handleRunPlan(targetRecipe, params, options, stream, commandOptions);
  }
  // Auto-detect the adapter from the target/cwd when --adapter is absent (parity
  // with call/doctor); teaches when the repo type cannot be detected.
  const { adapter, target } = resolveAdapter(options);
  const json = optionFlag(options, 'json');
  const jsonOutput = json && !stream.enabled;
  const machine = json || stream.enabled;
  stream.phase('resolve', { adapter, target, recipe: targetRecipe });
  if (!fs.existsSync(target)) {
    const message = `target does not exist: ${target}`;
    const userAction = `pass --target <${harnessHost().product.toLowerCase()}-checkout> pointing to an existing checkout`;
    if (stream.enabled) {
      stream.error({ code: 'TARGET_NOT_FOUND', message, userAction });
      return EXIT.usage;
    }
    return usageOut(jsonOutput, 'run', message, userAction);
  }
  writeInteractiveProgress(machine, `→ recipe run — validating ${targetRecipe} · ${adapter}`);
  harnessAdapter(adapter).resolveSlotPorts(target);
  // Resolve/gate the device target before any engine path reads process.env.
  const device = commandOptions.targetDevice?.('run', adapter, options);
  if (device && !device.ok) {
    return emitRunUsageError(
      jsonOutput,
      stream,
      adapter,
      targetRecipe,
      device.code,
      device.message,
      device.userAction,
    );
  }

  if (recipeRunning(target)) return emitRunRecipeRunning(jsonOutput, stream, target);

  stream.phase('validate');
  const validated = await validateRunRecipeStatic(engine, targetRecipe, adapter, options, params);
  if (validated.usageError) {
    const userAction = runUsageRecovery(
      validated.usageError.code,
      validated.usageError.message,
      adapter,
      validated.recipeFile,
    );
    return emitRunUsageError(
      jsonOutput,
      stream,
      adapter,
      validated.recipeFile,
      validated.usageError.code,
      validated.usageError.message,
      userAction,
    );
  }
  if (validated.errorCount > 0) {
    const capabilityRefusals = optionString(options, 'actionManifest')
      ? []
      : await validationCapabilityRefusals(
          engine,
          adapter,
          validated.findings,
          validated.librarySources,
        );
    return emitRunValidationError(
      jsonOutput,
      stream,
      adapter,
      validated.recipeFile,
      validated.findings,
      validated.errorCount,
      capabilityRefusals,
      actionLibraryContextArgs(engine, validated.librarySources),
    );
  }
  const depsBlock =
    (await harnessAdapter(adapter).run?.dependencyBlock?.(target, {
      recipe: validated.recipe,
      librarySources: validated.librarySources,
    })) ?? null;
  if (depsBlock) {
    return emitRunUsageError(
      jsonOutput,
      stream,
      adapter,
      validated.recipeFile,
      depsBlock.code,
      depsBlock.message,
      depsBlock.userAction,
    );
  }
  let artifactsDir: string;
  try {
    artifactsDir = resolveRunArtifactsDir(target, optionString(options, 'artifactsDir'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return emitRunUsageError(
      jsonOutput,
      stream,
      adapter,
      validated.recipeFile,
      'ARTIFACT_DIR_INVALID',
      message,
      'set RECIPE_TASK_DIR/FARMSLOT_TASK_DIR inside the checkout or pass --artifacts-dir <path>',
    );
  }
  recordCommandEvidence(artifactsDir);
  // Reuse the sources validateRunRecipeStatic already resolved (same --library
  // input) instead of a second resolution.
  const librarySources = validated.librarySources;
  let observers: RunObservers | undefined;
  const runtimeOptions: RecipeEngineRunOptions = {
    ...recipeRunOptionsFromCli(adapter, options),
    cli: options,
    params,
    ...(librarySources ? { librarySources } : {}),
    stdoutIsMachineContract: machine,
    onActionEvent: ({ nodeId, action, status }: RecipeNodeEvent) => {
      stream.node(nodeId, action, status);
      observers?.onActionEvent({ nodeId, action, status });
    },
  };
  stream.phase('authorize');
  let preflightedExecution: PreparedRecipeExecution | undefined = await preflightRecipe(
    engine,
    adapter,
    validated.recipeFile,
    artifactsDir,
    target,
    optionString(options, 'actionManifest'),
    runtimeOptions,
  );
  const lock = acquireCheckoutLock(target, 'run');
  if ('message' in lock) {
    const userAction = `wait for the current owner, or inspect ${lock.path} if its process has exited`;
    stream.error({ code: 'SANDBOX_BUSY', message: lock.message, userAction });
    return checkoutBusyOut(jsonOutput, 'run', lock.message, lock.path);
  }

  try {
    const prepared = await prepareHeal(adapter, target, options, machine, {
      onPhase: (phase, fields) => stream.phase(phase, fields),
    });
    if (typeof prepared === 'number') {
      stream.error({
        code: 'RUN_PREPARE_FAILED',
        message: 'runtime preparation failed; inspect stderr for the exact probe',
        userAction: `${host} doctor --fix --adapter ${adapter} --target ${shellQuote(target)} --json`,
      });
      return prepared;
    }
    const { state } = prepared;
    preflightedExecution = await preflightRecipe(
      engine,
      adapter,
      validated.recipeFile,
      artifactsDir,
      target,
      optionString(options, 'actionManifest'),
      runtimeOptions,
    );

    const ports = { cdpPort: runtimeOptions.cdpPort, watcherPort: runtimeOptions.watcherPort };
    const started = await startRunObservers(adapter, target, artifactsDir, ports);
    observers = started;
    stream.phase('execute');
    let executionResult;
    try {
      executionResult = await executeWithHealBounds(
        // validated.recipeFile, not the raw arg: the arg may be a library recipe NAME
        // that only the resolver knows how to turn into a file.
        () => {
          const execution = preflightedExecution;
          preflightedExecution = undefined;
          return runRecipe(
            engine,
            adapter,
            validated.recipeFile,
            artifactsDir,
            target,
            optionString(options, 'actionManifest'),
            runtimeOptions,
            execution,
            state,
          );
        },
        target,
        state,
      );
    } catch (error) {
      await started.abandon();
      observers = undefined;
      throw error;
    }
    const { result, violation } = executionResult;
    await started.finalize(result.artifactManifestPath);
    observers = undefined;
    for (const mutation of state.mutations) stream.mutation(mutation);
    for (const recovery of state.recovered) stream.recovery(recovery);
    persistRunEffects(result.summaryPath, result.artifactManifestPath, state);
    indexProductProvenanceArtifact(
      result.artifactManifestPath,
      target,
      adapter,
      result.browser ?? null,
    );
    if (violation !== null) {
      const userAction =
        violation.userAction ??
        `inspect ${shellQuote(result.summaryPath)} and ${shellQuote(result.tracePath)}; fix the application or recipe failure before retrying`;
      stream.error({
        code: violation.code,
        message: violation.message,
        userAction,
        originalError: violation.originalError ?? null,
      });
      return emitHealViolation(jsonOutput, 'run', result, violation, state, adapter);
    }
    const report = writeRunReport(result);
    const exitCode = result.status === 'pass' ? EXIT.ok : EXIT.runtime;
    const failureUserAction = `${host} last --target ${shellQuote(target)} --json`;
    if (stream.enabled) {
      if (result.status === 'fail') {
        stream.error({
          code: 'RECIPE_EXECUTION_FAILED',
          message: 'recipe execution failed; inspect the persisted result and evidence paths',
          userAction: failureUserAction,
        });
      }
      stream.complete(result.status, exitCode, {
        adapter,
        reportPath: report.path,
        summaryPath: result.summaryPath,
        tracePath: result.tracePath,
        artifactManifestPath: result.artifactManifestPath,
        recovered: state.recovered,
        mutations: state.mutations,
      });
    } else if (json) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'run',
            adapter,
            status: result.status,
            exitCode,
            recovered: state.recovered,
            mutations: state.mutations,
            reportPath: report.path,
            result,
            ...(result.status === 'fail'
              ? {
                  error: {
                    code: 'RECIPE_EXECUTION_FAILED',
                    message:
                      'recipe execution failed; inspect the persisted result and evidence paths',
                    userAction: failureUserAction,
                  },
                }
              : {}),
          },
          null,
          2,
        ),
      );
    } else {
      const out = (style: string, text: string) => color(style, text, { stream: process.stdout });
      console.log(
        `${out(result.status === 'pass' ? 'ok' : 'err', result.status.toUpperCase())} ${out('bold', 'recipe run')} ${out('dim', `[${adapter}]`)}`,
      );
      if (report.preview.length > 0) {
        console.log(out('label', 'summary:'));
        for (const line of report.preview) console.log(`  ${formatPreviewLine(line, out)}`);
      }
      const artifacts = runArtifactInventory(result.artifactManifestPath);
      console.log(out('label', `artifacts (${artifacts.length}):`));
      for (const artifact of artifacts) {
        console.log(`  ${out('dim', `${artifact.label}:`)} ${out('path', artifact.absolutePath)}`);
      }
      if (result.status === 'fail') {
        console.error(`  Next: ${failureUserAction}`);
      }
      console.log(out('label', 'diagnostics:'));
      const diagnostics = readRunDiagnosticsDocument(result.diagnosticsPath);
      for (const line of formatRunDiagnosticsForHuman(diagnostics, adapter)) {
        console.log(`  ${formatDiagnosticLine(line, out)}`);
      }
    }
    return exitCode;
  } finally {
    lock.release();
  }
}

function formatDiagnosticLine(line: string, out: (style: string, text: string) => string): string {
  const match = /^(CLEAN|REVIEW|UNAVAILABLE|N\/A|WARNING|ERROR|EXCEPTION)(.*)$/u.exec(line);
  if (!match) return line;
  const status = match[1]!;
  const style =
    status === 'CLEAN' ? 'ok' : status === 'ERROR' || status === 'EXCEPTION' ? 'err' : 'warn';
  return `${out(style, status)}${match[2]}`;
}

function resolveRunArtifactsDir(target: string, explicit: string | undefined): string {
  if (explicit !== undefined) return path.resolve(explicit);
  const taskDir = process.env.RECIPE_TASK_DIR || process.env.FARMSLOT_TASK_DIR;
  if (taskDir) {
    const resolvedTask = path.resolve(target, taskDir);
    const relative = path.relative(path.resolve(target), resolvedTask);
    if (!relative.startsWith(`..${path.sep}`) && relative !== '..') {
      return path.join(resolvedTask, 'artifacts');
    }
    throw new Error(`task directory must be inside the target checkout: ${taskDir}`);
  }
  const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, '');
  return path.join(target, 'temp', 'recipe', 'runs', `${stamp}-${process.pid}`);
}

interface RunArtifactDisplay {
  absolutePath: string;
  basename: string;
  label: string;
}

function runArtifactInventory(manifestPathValue: unknown): RunArtifactDisplay[] {
  const manifestPath = path.resolve(String(manifestPathValue));
  const root = path.dirname(manifestPath);
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return [
      {
        absolutePath: manifestPath,
        basename: path.basename(manifestPath),
        label: 'Artifact manifest',
      },
    ];
  }
  const entries = isRecord(manifest) && Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const artifacts: RunArtifactDisplay[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || entry.path.length === 0) continue;
    const absolutePath = path.resolve(root, entry.path);
    const basename = path.basename(absolutePath);
    const label =
      typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : basename;
    artifacts.push({ absolutePath, basename, label });
  }
  artifacts.push({
    absolutePath: manifestPath,
    basename: path.basename(manifestPath),
    label: 'Artifact manifest',
  });
  const priority = new Map([
    ['diagnostics.json', 0],
    ['report.md', 1],
    ['summary.json', 2],
    ['trace.json', 3],
    ['recipe.json', 4],
    ['artifact-manifest.json', 100],
  ]);
  return artifacts
    .filter(
      (artifact, index, all) =>
        all.findIndex((candidate) => candidate.absolutePath === artifact.absolutePath) === index,
    )
    .sort(
      (left, right) => (priority.get(left.basename) ?? 50) - (priority.get(right.basename) ?? 50),
    );
}

function formatPreviewLine(line: string, out: (style: string, text: string) => string): string {
  const match = /^(PASS|FAIL)\s+(.+)$/u.exec(line);
  if (!match) return line;
  const status = match[1]!;
  const rest = match[2];
  return `${out(status === 'PASS' ? 'ok' : 'err', status)} ${rest}`;
}

async function handleRunPlan<TMutation, TAllowlist extends ConsoleAllowlist>(
  recipeArg: string,
  params: Record<string, unknown>,
  options: CliOptions,
  stream: JsonStreamWriter,
  commandOptions: RunCommandOptions<TMutation, TAllowlist>,
): Promise<number> {
  const { engine } = commandOptions;
  const json = optionFlag(options, 'json');
  const jsonOutput = json && !stream.enabled;
  const { adapter, target } = resolveAdapter(options);

  stream.phase('resolve', { adapter, target, recipe: recipeArg });
  stream.phase('validate');
  const validated = await validateRunRecipeStatic(engine, recipeArg, adapter, options, params);
  if (validated.usageError) {
    const userAction = runUsageRecovery(
      validated.usageError.code,
      validated.usageError.message,
      adapter,
      validated.recipeFile,
    );
    return emitPlanUsageError(
      jsonOutput,
      stream,
      adapter,
      validated.recipeFile,
      validated.usageError.code,
      validated.usageError.message,
      userAction,
    );
  }
  const {
    recipe,
    recipeFile,
    findings,
    errorCount,
    manifestOk,
    schemaValid,
    effectiveParams,
    librarySources,
  } = validated;

  const status: 'pass' | 'fail' = errorCount === 0 ? 'pass' : 'fail';
  const capabilityRefusals =
    status === 'fail' && !optionString(options, 'actionManifest')
      ? await validationCapabilityRefusals(engine, adapter, findings, librarySources)
      : [];
  const failureUserAction =
    capabilityRefusals.length > 0
      ? capabilityValidationUserAction(
          adapter,
          capabilityRefusals,
          actionLibraryContextArgs(engine, librarySources),
        )
      : runPlanProbe(adapter, recipeFile);
  const nodeCount = countRecipeNodes(recipe);
  const artifactsDir = optionString(options, 'artifactsDir');

  const plan: RunPlanStep[] = [
    { step: 'resolve.recipe', confidence: 'static', status: 'ok', detail: recipeFile },
    { step: 'resolve.adapter', confidence: 'static', status: 'ok', detail: adapter },
    {
      step: 'resolve.artifactsDir',
      confidence: 'static',
      status: 'ok',
      detail: artifactsDir
        ? path.resolve(artifactsDir)
        : '(resolved to the slot artifacts dir at run time)',
    },
    {
      step: 'validate.manifest',
      confidence: 'static',
      status: manifestOk ? 'ok' : 'error',
      detail: manifestOk ? 'action manifest is well-formed' : 'action manifest failed validation',
    },
    {
      step: 'validate.schema',
      confidence: 'static',
      status: manifestOk && schemaValid ? 'ok' : 'error',
      detail: 'recipe document schema + action existence/platform vs the adapter manifest',
    },
    ...(optionFlag(options, 'proof')
      ? [
          {
            step: 'validate.proofBindings',
            confidence: 'static' as const,
            status: findings.some((finding) => finding.code.startsWith('proof.'))
              ? ('error' as const)
              : errorCount
                ? ('planned' as const)
                : ('ok' as const),
            detail:
              'checks possible behavioral assertion bindings only; runtime order, branches, results and proof artifact indexing remain unverified',
          },
        ]
      : []),
    ...(commandOptions.plan?.steps?.(target) ?? []),
    {
      step: 'overlay.ensure',
      confidence: 'conditional',
      status: 'planned',
      detail: 'would auto-ensure the runtime overlay if missing (install phase)',
    },
    ...(harnessAdapter(adapter).headless
      ? []
      : [
          {
            step: 'launch.app',
            confidence: 'conditional' as const,
            status: 'planned' as const,
            detail:
              commandOptions.plan?.launchDetail ??
              'would launch/attach the app + heal transport before executing',
          },
        ]),
    {
      step: 'execute.nodes',
      confidence: 'conditional',
      status: 'planned',
      detail:
        nodeCount === undefined
          ? 'would execute the recipe nodes'
          : `would execute ${nodeCount} recipe node(s)`,
    },
  ];

  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    command: 'run',
    mode: 'plan',
    status,
    adapter,
    recipe: recipeFile,
    params: redactRecipeParams(effectiveParams, isRecord(recipe) ? recipe.paramsSchema : undefined)
      .params,
    findings,
    plan,
  };
  if (status === 'fail') {
    payload.error = {
      code: 'RECIPE_VALIDATION_FAILED',
      message: `recipe validation found ${errorCount} error(s)`,
      ...(capabilityRefusals.length > 0 ? { missingCapabilities: capabilityRefusals } : {}),
      userAction: failureUserAction,
    };
  }
  if (stream.enabled) {
    if (status === 'fail') stream.error(payload.error as Record<string, unknown>);
    stream.complete(status, status === 'pass' ? EXIT.ok : EXIT.validation, {
      mode: 'plan',
      adapter,
      recipe: recipeFile,
      findings,
      plan,
    });
  } else if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`plan ${status} — ${adapter} — ${recipeFile}`);
    for (const item of plan) {
      const mark = item.status === 'error' ? '✗' : item.status === 'ok' ? '✓' : '·';
      console.log(`  ${mark} [${item.confidence}] ${item.step}: ${item.detail}`);
    }
    if (findings.length) {
      console.log('findings:');
      for (const finding of findings) {
        console.log(
          `  ${finding.severity === 'error' ? '✗' : '⚠'} ${finding.code} ${finding.path} — ${finding.message}`,
        );
      }
    }
    if (status === 'fail') console.error(`  Next: ${failureUserAction}`);
  }
  return status === 'pass' ? EXIT.ok : EXIT.validation;
}

function emitPlanUsageError(
  json: boolean,
  stream: JsonStreamWriter,
  adapter: string,
  recipeFile: string,
  code: string,
  message: string,
  userAction: string,
): number {
  stream.error({ code, message, userAction, mode: 'plan', adapter, recipe: recipeFile });
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'run',
          mode: 'plan',
          status: 'fail',
          adapter,
          recipe: recipeFile,
          error: { code, message, userAction },
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`✗ run --plan: ${message}\n  Next: ${userAction}`);
  }
  return EXIT.usage;
}

function emitRunRecipeRunning(json: boolean, stream: JsonStreamWriter, target: string): number {
  const host = harnessHost().name;
  const { message, userAction } = recipeRunningRefusal(shellQuote(target));
  stream.error({ code: 'RECIPE_RUNNING', message, userAction, recoverable: false });
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          status: 'fail',
          recoverable: false,
          error: { code: 'RECIPE_RUNNING', message, userAction },
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`✗ ${host}: ${message}\n  Next: ${userAction}`);
  }
  return EXIT.bounded;
}

function emitRunUsageError(
  json: boolean,
  stream: JsonStreamWriter,
  adapter: string,
  recipeFile: string,
  code: string,
  message: string,
  userAction: string,
): number {
  stream.error({ code, message, userAction });
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'run',
          adapter,
          status: 'fail',
          exitCode: EXIT.usage,
          recipe: recipeFile,
          error: { code, message, userAction },
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`✗ run: ${message}`);
    console.error(`  Next: ${userAction}`);
  }
  return EXIT.usage;
}

function emitRunValidationError(
  json: boolean,
  stream: JsonStreamWriter,
  adapter: string,
  recipeFile: string,
  findings: RecipeValidationFinding[],
  errorCount: number,
  capabilityRefusals: ActionCapabilityRefusal[],
  libraryContextArgs: string,
): number {
  const message = `recipe validation found ${errorCount} error(s)`;
  const userAction =
    capabilityRefusals.length > 0
      ? capabilityValidationUserAction(adapter, capabilityRefusals, libraryContextArgs)
      : runPlanProbe(adapter, recipeFile);
  const capabilityDetails =
    capabilityRefusals.length > 0 ? { missingCapabilities: capabilityRefusals } : {};
  stream.error({
    code: 'RECIPE_VALIDATION_FAILED',
    message,
    userAction,
    findings,
    ...capabilityDetails,
  });
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'run',
          adapter,
          status: 'fail',
          exitCode: EXIT.validation,
          recovered: [],
          mutations: [],
          recipe: recipeFile,
          findings,
          error: {
            code: 'RECIPE_VALIDATION_FAILED',
            message,
            userAction,
            ...capabilityDetails,
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`✗ run: ${message}`);
    for (const finding of findings) {
      if (finding.severity === 'error')
        console.error(`  ${finding.code} ${finding.path} — ${finding.message}`);
    }
    console.error(`  Next: ${userAction}`);
  }
  return EXIT.validation;
}

function runPlanProbe(adapter: string, recipeFile: string): string {
  return `${harnessHost().name} run --plan ${shellQuote(recipeFile)} --adapter ${adapter} --json`;
}

function runUsageRecovery(
  code: string,
  message: string,
  adapter: string,
  recipeFile: string,
): string {
  const host = harnessHost().name;
  const actionCommand = new RegExp(
    `This is an action, not a recipe\\. Use: (${escapeRegExp(host)} call .+)\\.$`,
    'u',
  ).exec(message)?.[1];
  if (actionCommand) return actionCommand;
  if (code === 'RECIPE_NOT_FOUND') return `${host} run --list --adapter ${adapter} --json`;
  if (code === 'RECIPE_UNPARSEABLE') {
    return `fix the JSON syntax in ${shellQuote(recipeFile)}, then retry: ${runPlanProbe(adapter, recipeFile)}`;
  }
  return runPlanProbe(adapter, recipeFile);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

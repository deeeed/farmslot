// run — validate a recipe, then execute it through the engine with bounded
// healing, observation, and the run report; or describe its plan (--plan).

import fs from 'node:fs';
import path from 'node:path';

import type { RecipeNodeEvent } from '@farmslot/adapter-sdk';
import type { RecipeValidationFinding } from '@farmslot/protocol';
import { type RecipeLibrarySource, redactRecipeParams } from '@farmslot/recipe-runner';

import { type ActionCapabilityRefusal, missingActionCapabilities } from '../../action-catalog.js';
import { recordRecipeAcceptance } from '../acceptance-ledger.js';
import { harnessAdapter } from '../adapters.js';
import {
  actionLibraryContextArgs,
  type RecipeCatalog,
  resolveActionCapabilityMatrix,
} from '../catalog.js';
import { acquireCheckoutLock } from '../checkout-lock.js';
import { color } from '../cli-color.js';
import { recordCommandEvidence } from '../command-journal.js';
import { harnessContextField } from '../context-state.js';
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
  type ParsedArgs,
  parseRecipeParamAssignments,
  resolveAdapter,
  shellQuote,
  targetPath,
  usageError,
} from '../parse-args.js';
import { validateRunRecipeStatic } from '../recipe-validation.js';
import { recordingUnsupported } from '../recording-target.js';
import {
  type ConsoleAllowlist,
  formatRunDiagnosticsForHuman,
  readRunDiagnosticsDocument,
} from '../run-diagnostics.js';
import {
  activateRecipeRuntimeEnvironment,
  countRecipeNodes,
  emitHealViolation,
  executeWithHealBounds,
  fallbackMarker,
  healViolationError,
  persistRunEffects,
  preflightRecipe,
  type PreparedRecipeExecution,
  prepareHeal,
  type RecipeEngine,
  type RecipeEngineRunOptions,
  type RunFallbackEvidence,
  runRecipe,
} from '../run-engine.js';
import { type RunObservers, startRunObservers } from '../run-observers.js';
import { recipeRunOptionsFromCli } from '../run-options.js';
import {
  indexProductProvenanceArtifact,
  writeRunReport,
  writeViolationReport,
} from '../run-report.js';
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
  /** Already checked against the bound provider's command grammar. */
  parsed?: ParsedArgs;
  librarySources?: RecipeLibrarySource[];
  /** Shared with the outer host so binding and finalization failures use the same terminal. */
  stream?: JsonStreamWriter;
  signal?: AbortSignal;
  beforeResult?(): Promise<void>;
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
  const parsed = commandOptions.parsed ?? parseArgs(argv);
  const host = harnessHost().name;
  const stream =
    commandOptions.stream ?? new JsonStreamWriter('run', optionFlag(parsed.options, 'jsonStream'));
  const restoreStdout = stream.isolateStdout();
  const target = targetPath(parsed.options);
  let resultReady: Promise<void> | undefined;
  const beforeResult = () =>
    (resultReady ??= Promise.resolve().then(() => commandOptions.beforeResult?.()));
  try {
    const exitCode = await handleRunInner(parsed.positional, parsed.options, stream, {
      ...commandOptions,
      beforeResult,
    });
    await beforeResult();
    stream.complete(exitCode === EXIT.ok ? 'pass' : 'fail', exitCode);
    return exitCode;
  } catch (error) {
    if (error instanceof ProvenanceDriftError) {
      const failure = provenanceFailure(error);
      if (stream.enabled) {
        stream.error(failure);
        await beforeResult();
        stream.complete('fail', error.exitCode);
      } else if (optionFlag(parsed.options, 'json')) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              command: 'run',
              ...harnessContextField(),
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
        await beforeResult();
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
    // The owning host finalizes after a throw and retains both failure causes.
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
          ...harnessContextField(),
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
    return handleListExecutables('run', options, {
      catalog: engine,
      librarySources: commandOptions.librarySources,
    });
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
    return handleDescribeRecipe(targetRecipe, options, {
      catalog: engine,
      librarySources: commandOptions.librarySources,
    });
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
  const recording = options.recordVideo === 'full-run' ? recordingUnsupported(adapter) : undefined;
  if (recording) {
    return emitRunUsageError(
      jsonOutput,
      stream,
      adapter,
      targetRecipe,
      recording.code,
      recording.message,
      recording.userAction,
    );
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
  const validated = await validateRunRecipeStatic(
    engine,
    targetRecipe,
    adapter,
    options,
    params,
    commandOptions.librarySources,
  );
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
    const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, '');
    artifactsDir = resolveRecipeArtifactsDir(target, optionString(options, 'artifactsDir'), {
      fresh: path.join('runs', `${stamp}-${process.pid}`),
    });
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
    signal: commandOptions.signal,
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
  // One environment scope for the run: preflight, the runtime check, the
  // observers and the execution all see the same ports.
  const restoreRuntimeEnvironment = activateRecipeRuntimeEnvironment(
    adapter,
    target,
    runtimeOptions,
  );
  try {
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

      const started = await startRunObservers(adapter, target, artifactsDir);
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
      await commandOptions.beforeResult?.();
      for (const mutation of state.mutations) stream.mutation(mutation);
      for (const recovery of state.recovered) stream.recovery(recovery);
      persistRunEffects(result.summaryPath, result.artifactManifestPath, state);
      indexProductProvenanceArtifact(
        result.artifactManifestPath,
        target,
        adapter,
        result.browser ?? null,
      );
      recordRunAcceptance(target, result);
      // Evidence an action produced through a fallback provider (for example a
      // screenshot from a second capture path), so an evidence gate sees it here,
      // on a failed run too.
      const fallbacks: RunFallbackEvidence[] = runArtifactInventory(
        result.artifactManifestPath,
      ).flatMap((artifact) =>
        artifact.fallback
          ? [{ path: artifact.absolutePath, label: artifact.label, ...artifact.fallback }]
          : [],
      );
      if (violation !== null) {
        const userAction =
          violation.userAction ??
          `inspect ${shellQuote(result.summaryPath)} and ${shellQuote(result.tracePath)}; fix the application or recipe failure before retrying`;
        const report = writeViolationReport(result);
        stream.error(healViolationError(violation, userAction));
        if (stream.enabled) {
          stream.complete('fail', violation.exitCode, {
            ...(fallbacks.length > 0 ? { fallbacks } : {}),
            ...(report ? { reportPath: report.path } : {}),
          });
        }
        return emitHealViolation(
          jsonOutput,
          'run',
          result,
          violation,
          state,
          adapter,
          fallbacks,
          report?.path,
        );
      }
      const report = writeRunReport(result);
      // Listed after the report is indexed, so the human list includes it.
      const artifacts = runArtifactInventory(result.artifactManifestPath);
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
          ...(fallbacks.length > 0 ? { fallbacks } : {}),
        });
      } else if (json) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              command: 'run',
              ...harnessContextField(),
              adapter,
              status: result.status,
              exitCode,
              recovered: state.recovered,
              mutations: state.mutations,
              reportPath: report.path,
              ...(fallbacks.length > 0 ? { fallbacks } : {}),
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
        console.log(out('label', `artifacts (${artifacts.length}):`));
        for (const artifact of artifacts) {
          const fallback = artifact.fallback
            ? ` ${out('warn', fallbackMarker(artifact.fallback))}`
            : '';
          console.log(
            `  ${out('dim', `${artifact.label}:`)} ${out('path', artifact.absolutePath)}${fallback}`,
          );
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
  } finally {
    restoreRuntimeEnvironment();
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

/** A run's or call's own directory: `fresh` under temp/recipe, `taskSubdir` under a task's artifacts. */
export interface RecipeArtifactsLayout {
  fresh: string;
  taskSubdir?: string;
}

/**
 * Where a run or call writes its artifacts: `--artifacts-dir`; else, inside a
 * task (RECIPE_TASK_DIR/FARMSLOT_TASK_DIR, which must be inside the checkout),
 * the task's `artifacts` directory plus `taskSubdir`; else `fresh` under the
 * checkout's temp/recipe.
 */
export function resolveRecipeArtifactsDir(
  target: string,
  explicit: string | undefined,
  layout: RecipeArtifactsLayout,
): string {
  if (explicit !== undefined) return path.resolve(explicit);
  const taskDir = runTaskDir(target);
  if (taskDir) return path.join(taskDir, 'artifacts', layout.taskSubdir ?? '');
  return path.join(target, 'temp', 'recipe', layout.fresh);
}

/** The run's task dir (RECIPE_TASK_DIR / FARMSLOT_TASK_DIR), resolved inside the checkout, or null. */
function runTaskDir(target: string): string | null {
  const taskDir = process.env.RECIPE_TASK_DIR || process.env.FARMSLOT_TASK_DIR;
  if (!taskDir) return null;
  const resolvedTask = path.resolve(target, taskDir);
  const relative = path.relative(path.resolve(target), resolvedTask);
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..') return resolvedTask;
  throw new Error(`task directory must be inside the target checkout: ${taskDir}`);
}

// The task's acceptance ledger from the recipe's proof targets. The run's result
// stands either way: a ledger the run can't write is a warning, not a failure.
function recordRunAcceptance(
  target: string,
  result: Parameters<typeof recordRecipeAcceptance>[2],
): void {
  try {
    const taskDir = runTaskDir(target);
    if (!taskDir) return;
    const { recorded, refused } = recordRecipeAcceptance(taskDir, target, result);
    for (const reason of refused) console.error(`acceptance ledger: not recorded ${reason}`);
    if (recorded.length > 0 && recorded.every((entry) => entry.evidence.length === 0)) {
      console.error(
        `acceptance ledger: verdicts recorded with no evidence inside the task dir (artifacts dir: ${path.dirname(result.tracePath)})`,
      );
    }
  } catch (error) {
    // The stack too: an unexpected error here is a bug, not a ledger state.
    console.error(
      `acceptance ledger: not written: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

type RunArtifactFallback = Pick<RunFallbackEvidence, 'fallbackFrom' | 'fallbackReason'>;

interface RunArtifactDisplay {
  absolutePath: string;
  basename: string;
  label: string;
  /** From the artifact's `metadata.fallbackFrom` / `metadata.fallbackReason`. */
  fallback?: RunArtifactFallback;
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
    const metadata = isRecord(entry.metadata) ? entry.metadata : {};
    const fallback: RunArtifactFallback | undefined =
      typeof metadata.fallbackFrom === 'string'
        ? {
            fallbackFrom: metadata.fallbackFrom,
            ...(typeof metadata.fallbackReason === 'string'
              ? { fallbackReason: metadata.fallbackReason }
              : {}),
          }
        : undefined;
    artifacts.push({ absolutePath, basename, label, ...(fallback ? { fallback } : {}) });
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
  const recording = options.recordVideo === 'full-run' ? recordingUnsupported(adapter) : undefined;
  if (recording) {
    return emitPlanFailure(
      jsonOutput,
      stream,
      adapter,
      recipeArg,
      recording.code,
      recording.message,
      recording.userAction,
    );
  }
  stream.phase('validate');
  const validated = await validateRunRecipeStatic(
    engine,
    recipeArg,
    adapter,
    options,
    params,
    commandOptions.librarySources,
  );
  if (validated.usageError) {
    const userAction = runUsageRecovery(
      validated.usageError.code,
      validated.usageError.message,
      adapter,
      validated.recipeFile,
    );
    return emitPlanFailure(
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
  let artifactsDir: string;
  try {
    artifactsDir = resolveRecipeArtifactsDir(target, optionString(options, 'artifactsDir'), {
      fresh: 'runs/planned',
    });
  } catch (error) {
    return emitPlanFailure(
      jsonOutput,
      stream,
      adapter,
      recipeFile,
      'ARTIFACT_DIR_INVALID',
      error instanceof Error ? error.message : String(error),
      'set RECIPE_TASK_DIR/FARMSLOT_TASK_DIR inside the checkout or pass --artifacts-dir <path>',
    );
  }
  let execution: PreparedRecipeExecution | undefined;
  if (status === 'pass') {
    const runtimeOptions: RecipeEngineRunOptions = {
      ...recipeRunOptionsFromCli(adapter, options),
      readOnly: true,
      cli: options,
      params: effectiveParams,
      librarySources,
      stdoutIsMachineContract: jsonOutput || stream.enabled,
    };
    const restoreEnvironment = activateRecipeRuntimeEnvironment(adapter, target, runtimeOptions);
    try {
      execution = await preflightRecipe(
        engine,
        adapter,
        recipeFile,
        artifactsDir,
        target,
        optionString(options, 'actionManifest'),
        runtimeOptions,
      );
    } catch (error) {
      const failure = recipeTrustFailure(error);
      if (failure) {
        stream.error(failure);
        if (!stream.enabled) reportTrustFailure('run', failure, jsonOutput);
        return EXIT.validation;
      }
      return emitPlanFailure(
        jsonOutput,
        stream,
        adapter,
        recipeFile,
        (error as { code?: string }).code ?? 'RECIPE_PREFLIGHT_FAILED',
        error instanceof Error ? error.message : String(error),
        (error as { userAction?: string }).userAction ?? runPlanProbe(adapter, recipeFile),
        (error as { exitCode?: number }).exitCode ?? EXIT.validation,
      );
    } finally {
      restoreEnvironment();
    }
  }

  const plan: RunPlanStep[] = [
    { step: 'resolve.recipe', confidence: 'static', status: 'ok', detail: recipeFile },
    { step: 'resolve.adapter', confidence: 'static', status: 'ok', detail: adapter },
    {
      step: 'resolve.artifactsDir',
      confidence: 'static',
      status: 'ok',
      detail:
        optionString(options, 'artifactsDir') || runTaskDir(target)
          ? artifactsDir
          : 'resolved at run time',
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
    {
      step: 'preflight.recipe',
      confidence: 'static',
      status: execution ? 'ok' : 'planned',
      detail: 'complete dependency, parameter, handler and authorization checks',
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

  await commandOptions.beforeResult?.();
  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    command: 'run',
    ...harnessContextField(),
    mode: 'plan',
    status,
    adapter,
    recipe: recipeFile,
    params: redactRecipeParams(effectiveParams, isRecord(recipe) ? recipe.paramsSchema : undefined)
      .params,
    findings,
    plan,
    ...(execution?.plan ? { executionPlan: execution.plan } : {}),
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
      ...(execution?.plan ? { executionPlan: execution.plan } : {}),
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

function emitPlanFailure(
  json: boolean,
  stream: JsonStreamWriter,
  adapter: string,
  recipeFile: string,
  code: string,
  message: string,
  userAction: string,
  exitCode: number = EXIT.usage,
): number {
  stream.error({ code, message, userAction, mode: 'plan', adapter, recipe: recipeFile });
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'run',
          ...harnessContextField(),
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
  return exitCode;
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
          ...harnessContextField(),
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
          ...harnessContextField(),
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

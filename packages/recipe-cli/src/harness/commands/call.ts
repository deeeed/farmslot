// call — run one action through the real engine path: resolve the action name,
// synthesize a one-node recipe, validate it, and execute it with bounded
// healing and observation.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { RecipeNodeEvent } from '@farmslot/adapter-sdk';
import { getRecipeActionManifestActionNames } from '@farmslot/protocol';
import type { RecipeLibrarySource } from '@farmslot/recipe-runner';

import { fuzzyResolveActions, resolveActionCapabilityRefusal } from '../../action-catalog.js';
import { harnessAdapter } from '../adapters.js';
import {
  actionExampleCommand,
  actionLibraryContextArgs,
  type DescribedAction,
  describeManifestActions,
  type RecipeCatalog,
  renderActionDetail,
  resolveActionCapabilityMatrix,
} from '../catalog.js';
import { acquireCheckoutLock } from '../checkout-lock.js';
import { color } from '../cli-color.js';
import {
  isSensitiveKey,
  recordCommandEvidence,
  redactStructuredValue,
} from '../command-journal.js';
import { harnessContextField } from '../context-state.js';
import { ProvenanceDriftError } from '../execution-provenance.js';
import { conciseFailureForHuman, recipeRunning, recipeRunningRefusal } from '../heal-bounds.js';
import { harnessHost, invokedHostCommand } from '../host.js';
import {
  applyRuntimeDirOption,
  isRecord,
  optionFlag,
  optionString,
  parseArgs,
  type ParsedArgs,
  resolveAdapter,
  shellQuote,
  usageError,
} from '../parse-args.js';
import { resolveCommandManifest } from '../recipe-library.js';
import { validateRecipeAdapterAware } from '../recipe-validation.js';
import { recordingUnsupported } from '../recording-target.js';
import {
  type ConsoleAllowlist,
  formatRunDiagnosticsForHuman,
  readRunDiagnosticsDocument,
} from '../run-diagnostics.js';
import {
  activateRecipeRuntimeEnvironment,
  emitHealViolation,
  executeWithHealBounds,
  persistRunEffects,
  preflightRecipe,
  type PreparedRecipeExecution,
  prepareHeal,
  type RecipeEngine,
  type RecipeEngineRunOptions,
  runRecipe,
  synthesizeOneNodeRecipe,
} from '../run-engine.js';
import { type RunObservers, startRunObservers } from '../run-observers.js';
import { recipeRunOptionsFromCli } from '../run-options.js';
import { checkoutBusyOut, EXIT, usageOut } from '../shared.js';
import { closest } from '../suggest.js';
import { recipeTrustFailure } from '../trust.js';

import { handleListExecutables } from './discover.js';
import {
  type DeviceTargeting,
  provenanceFailure,
  type RecipeArtifactsLayout,
  reportTrustFailure,
  resolveRecipeArtifactsDir,
} from './run.js';

export interface CallCommandOptions<TMutation, TAllowlist extends ConsoleAllowlist> {
  engine: RecipeEngine<TMutation, TAllowlist>;
  /** Already checked against the bound provider's command grammar. */
  parsed?: ParsedArgs;
  librarySources?: RecipeLibrarySource[];
  signal?: AbortSignal;
  beforeResult?(): Promise<void>;
  targetDevice?: DeviceTargeting;
  // The action the usage example names when no action is given; undefined
  // falls back to `command`, then the first action.
  exampleAction?(names: readonly string[]): string | undefined;
}

export async function handleCall<TMutation, TAllowlist extends ConsoleAllowlist>(
  argv: string[],
  commandOptions: CallCommandOptions<TMutation, TAllowlist>,
): Promise<number> {
  const { engine } = commandOptions;
  const host = harnessHost().name;
  // --list: actions accepted by `call` for the detected adapter (no <action>
  // required). Intercept before the "action first" grammar check.
  if (commandOptions.parsed?.options.list || argv.includes('--list')) {
    const { options } = commandOptions.parsed ?? parseArgs(argv);
    return handleListExecutables('call', options, {
      catalog: engine,
      librarySources: commandOptions.librarySources,
    });
  }
  if (!commandOptions.parsed && argv.length > 0 && argv[0]!.startsWith('--')) {
    // The public wrapper catches this with the structured grammar. Keep the
    // guard for direct callers: without it, parseCallArgs can mistake an
    // option value (for example `core`) for the action.
    const message = `call requires <action> first: ${host} call <action> [key=value ...] [flags]`;
    console.error(message);
    return EXIT.usage;
  }
  const {
    action: shortName,
    args,
    rest,
  } = parseCallArgs(commandOptions.parsed?.positional ?? argv);
  const { options } = commandOptions.parsed ?? parseArgs(rest);
  if (['domain', 'source', 'sort'].some((name) => optionString(options, name) !== undefined)) {
    throw usageError('--domain, --source, and --sort require call --list.');
  }
  const json = optionFlag(options, 'json');
  if (!shortName) {
    let example = `${host} call <action>`;
    let discovery = `${host} actions`;
    try {
      const { adapter } = resolveAdapter(options);
      const { manifest } = await resolveCommandManifest(
        engine,
        adapter,
        options,
        commandOptions.librarySources,
      );
      const names = getRecipeActionManifestActionNames(manifest);
      const exampleAction =
        commandOptions.exampleAction?.(names) ??
        (names.includes('command') ? 'command' : (names[0] ?? 'command'));
      example = `${host} call ${exampleAction} --adapter ${adapter}`;
      discovery = `${host} actions --adapter ${adapter}`;
    } catch {
      /* adapter/manifest unavailable — keep the generic example */
    }
    const message = `call requires <action>. Example: ${example}`;
    const userAction = `${example}   # see the vocabulary: ${discovery}`;
    if (json)
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'call',
            ...harnessContextField(),
            status: 'fail',
            error: { code: 'CLI_MISSING_POSITIONAL', message, userAction },
            exitCode: EXIT.usage,
          },
          null,
          2,
        ),
      );
    else console.error(`${message}\n  See the vocabulary: ${discovery}`);
    return EXIT.usage;
  }

  const { adapter, target } = resolveAdapter(options);

  if (!fs.existsSync(target)) {
    return usageOut(
      json,
      'call',
      `target does not exist: ${target}`,
      `pass --target <${harnessHost().product.toLowerCase()}-checkout> pointing to an existing checkout`,
    );
  }

  // The runtime directory names where the slot's context and the call's runtime
  // state live, so it applies before the slot resolves.
  applyRuntimeDirOption(options);

  const recording = options.recordVideo === 'full-run' ? recordingUnsupported(adapter) : undefined;
  if (recording) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'call',
            ...harnessContextField(),
            adapter,
            status: 'fail',
            exitCode: EXIT.usage,
            error: recording,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`✗ call: ${recording.message}`);
      console.error(`  Next: ${recording.userAction}`);
    }
    return EXIT.usage;
  }

  harnessAdapter(adapter).resolveSlotPorts(target);
  // Resolve/gate the device target before the engine reads process.env.
  const device = commandOptions.targetDevice?.('call', adapter, options);
  if (device && !device.ok) {
    if (json)
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'call',
            ...harnessContextField(),
            adapter,
            error: { code: device.code, message: device.message, userAction: device.userAction },
          },
          null,
          2,
        ),
      );
    else console.error(`✗ call: ${device.message}\n  Next: ${device.userAction}`);
    return EXIT.usage;
  }

  if (recipeRunning(target)) {
    const { message: msg, userAction } = recipeRunningRefusal(shellQuote(target));
    if (json) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'call',
            ...harnessContextField(),
            status: 'fail',
            recoverable: false,
            error: { code: 'RECIPE_RUNNING', message: msg, userAction },
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`✗ ${host} call: ${msg}\n  Next: ${userAction}`);
    }
    return EXIT.bounded;
  }

  const actionManifestOverride = optionString(options, 'actionManifest');
  const { manifest, actionSources, librarySources } = await resolveCommandManifest(
    engine,
    adapter,
    options,
    commandOptions.librarySources,
  );
  const names = getRecipeActionManifestActionNames(manifest);

  const resolution = resolveActionName(shortName, names);
  if (resolution.status === 'unknown') {
    const refusal = actionManifestOverride
      ? undefined
      : resolveActionCapabilityRefusal(
          shortName,
          adapter,
          await resolveActionCapabilityMatrix(engine, librarySources),
        );
    if (refusal) {
      const satisfying = refusal.satisfyingAdapters.join(', ');
      const message = `missing action capability "${refusal.capability}" for the ${adapter} adapter.`;
      const userAction =
        `Satisfying adapters for "${refusal.capability}": ${satisfying}. ` +
        `Inspect: ${host} actions --matrix ` +
        `--action ${shellQuote(refusal.capability)}` +
        `${actionLibraryContextArgs(engine, librarySources)} --json`;
      const error = {
        code: 'ACTION_CAPABILITY_UNAVAILABLE',
        message,
        capability: refusal.capability,
        satisfyingAdapters: refusal.satisfyingAdapters,
        userAction,
      };
      if (json) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              command: 'call',
              ...harnessContextField(),
              adapter,
              action: shortName,
              error,
            },
            null,
            2,
          ),
        );
      } else {
        console.error(`✗ call: ${message}\n  Next: ${userAction}`);
      }
      return EXIT.usage;
    }
    const message = `unknown action "${shortName}" for the ${adapter} adapter.`;
    const userAction = `${host} actions --adapter ${adapter} --json`;
    if (json)
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'call',
            ...harnessContextField(),
            adapter,
            action: shortName,
            error: { code: 'ACTION_UNKNOWN', message, userAction },
          },
          null,
          2,
        ),
      );
    else console.error(`✗ call: ${message}\n  Next: ${userAction}`);
    return EXIT.usage;
  }
  if (resolution.status === 'ambiguous') {
    const message = `"${shortName}" is ambiguous: ${resolution.candidates.join(', ')} — use the full name.`;
    const userAction = `${host} actions --action ${resolution.candidates[0]} --adapter ${adapter} --json`;
    if (json)
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'call',
            ...harnessContextField(),
            adapter,
            action: shortName,
            error: {
              code: 'ACTION_AMBIGUOUS',
              message,
              candidates: resolution.candidates,
              userAction,
            },
          },
          null,
          2,
        ),
      );
    else console.error(`✗ call: ${message}\n  Next: ${userAction}`);
    return EXIT.usage;
  }
  const resolvedAction = resolution.resolved;
  const describedAction = describeManifestActions(engine, manifest, actionSources).find(
    (entry) => entry.name === resolvedAction,
  );
  const defaultsUsed = actionDefaultsUsed(describedAction, args);
  const depsBlock =
    (await harnessAdapter(adapter).run?.dependencyBlock?.(target, { action: resolvedAction })) ??
    null;
  if (depsBlock) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'call',
            ...harnessContextField(),
            adapter,
            status: 'fail',
            exitCode: EXIT.usage,
            error: depsBlock,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`✗ call: ${depsBlock.message}`);
      console.error(`  Next: ${depsBlock.userAction}`);
    }
    return EXIT.usage;
  }

  const recipe = synthesizeOneNodeRecipe(resolvedAction, args);

  const validation = await validateRecipeAdapterAware(adapter, recipe, manifest, librarySources);
  if (validation.status === 'invalid') {
    const message = `call ${resolvedAction}: recipe validation failed`;
    const parameterHelp = parameterValidationHelp(describedAction, validation.findings, args);
    const actionsCommand = `${host} actions --action ${resolvedAction} --adapter ${adapter}`;
    const userAction = describedAction
      ? (actionExampleCommand(describedAction, adapter, target, invokedHostCommand(), args) ??
        actionsCommand)
      : actionsCommand;
    if (json)
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'call',
            ...harnessContextField(),
            adapter,
            action: shortName,
            resolvedAction,
            args: redactCallValue(args),
            findings: validation.findings,
            ...(parameterHelp.length > 0 ? { parameterHelp } : {}),
            error: { code: 'RECIPE_VALIDATION_FAILED', message, userAction },
          },
          null,
          2,
        ),
      );
    else {
      console.error(`✗ ${message}`);
      const taught = new Set(parameterHelp.map((entry) => `${entry.issue}:${entry.name}`));
      for (const entry of parameterHelp) console.error(renderParameterValidationHelp(entry));
      for (const finding of validation.findings) {
        const name = finding.path.split('.').at(-1);
        const issue = parameterIssue(finding.code);
        if (issue && name && taught.has(`${issue}:${name}`)) continue;
        console.error(`  ${finding.code} ${finding.path} — ${finding.message}`);
      }
      console.error(`  Next: ${userAction}`);
    }
    return EXIT.validation;
  }

  let artifactsDir: string;
  try {
    artifactsDir = resolveRecipeArtifactsDir(
      target,
      optionString(options, 'artifactsDir'),
      callArtifactsLayout(resolvedAction),
    );
  } catch (error) {
    return usageOut(
      json,
      'call',
      error instanceof Error ? error.message : String(error),
      'set RECIPE_TASK_DIR/FARMSLOT_TASK_DIR inside the checkout or pass --artifacts-dir <path>',
    );
  }
  recordCommandEvidence(artifactsDir);
  const requestedRuntimeOptions = recipeRunOptionsFromCli(adapter, options);
  const inheritedSource =
    process.env.FARMSLOT_RECIPE_SOURCE_TRUST ||
    process.env.FARMSLOT_RECIPE_SOURCE_KIND ||
    process.env.FARMSLOT_RECIPE_SOURCE_NAME ||
    process.env.FARMSLOT_RECIPE_SOURCE_DIGEST;
  let observers: RunObservers | undefined;
  // No `cli`: a call's trustedMutation.load gets no command line, so no funding
  // flag binds a mutation to a call (funded mutations run through `run`, bound
  // to a reviewed recipe). The HUD follows the run's policy, as for `run`: an
  // agent's `call ui.screenshot` is evidence too, so it carries the intent
  // unless --hud hide. A `call app.hud` drives the HUD itself, so the automatic
  // updates stay off: a completion update would redraw what `clear=true` removed.
  const callRuntimeOptions: RecipeEngineRunOptions = {
    signal: commandOptions.signal,
    ...requestedRuntimeOptions,
    ...(resolvedAction === 'app.hud' ? { autoHud: false } : {}),
    librarySources,
    suppressLibraryResolutionLogs: true,
    stdoutIsMachineContract: json,
    onActionEvent: ({ nodeId, action, status }: RecipeNodeEvent) => {
      observers?.onActionEvent({ nodeId, action, status });
    },
    ...(requestedRuntimeOptions.source
      ? { source: requestedRuntimeOptions.source }
      : inheritedSource
        ? {}
        : {
            source: {
              kind: 'operator' as const,
              trust: 'trusted' as const,
              name: `${host} call`,
            },
          }),
  };
  // One environment scope for the call: preflight, the runtime check, the
  // observers and the execution all see the same ports.
  const restoreRuntimeEnvironment = activateRecipeRuntimeEnvironment(
    adapter,
    target,
    callRuntimeOptions,
  );
  try {
    let preflightedExecution: PreparedRecipeExecution | undefined;
    try {
      preflightedExecution = await preflightRecipe(
        engine,
        adapter,
        recipe,
        artifactsDir,
        target,
        actionManifestOverride,
        callRuntimeOptions,
      );
    } catch (error) {
      const trustFailure = recipeTrustFailure(error);
      if (!trustFailure) throw error;
      const planDigest = trustFailure.details?.recipeDigest;
      if (planDigest) {
        trustFailure.userAction =
          `review the plan, then rerun this call with --artifacts-dir ${shellQuote(artifactsDir)} ` +
          `--approve-plan ${shellQuote(planDigest)}; managed callers must keep the same artifact ` +
          `directory and execution environment, then set ` +
          `FARMSLOT_RECIPE_APPROVE_PLAN=${shellQuote(planDigest)}`;
      }
      reportTrustFailure('call', trustFailure, json);
      return EXIT.validation;
    }

    const lock = acquireCheckoutLock(target, 'call');
    if ('message' in lock) {
      return checkoutBusyOut(json, 'call', lock.message, lock.path);
    }

    try {
      const prepared = await prepareHeal(adapter, target, options, json, {
        appRestartAuthored: resolvedAction === 'app.lifecycle' && args.command === 'restart',
      });
      if (typeof prepared === 'number') return prepared;
      const { state } = prepared;
      preflightedExecution = await preflightRecipe(
        engine,
        adapter,
        recipe,
        artifactsDir,
        target,
        actionManifestOverride,
        callRuntimeOptions,
      );

      const started = await startRunObservers(adapter, target, artifactsDir);
      observers = started;
      let executionResult;
      try {
        executionResult = await executeWithHealBounds(
          () => {
            const execution = preflightedExecution;
            preflightedExecution = undefined;
            return runRecipe(
              engine,
              adapter,
              recipe,
              artifactsDir,
              target,
              actionManifestOverride,
              callRuntimeOptions,
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
        if (error instanceof ProvenanceDriftError) {
          const failure = provenanceFailure(error);
          if (json) {
            console.log(
              JSON.stringify(
                {
                  schemaVersion: 1,
                  command: 'call',
                  ...harnessContextField(),
                  adapter,
                  action: shortName,
                  resolvedAction,
                  status: 'fail',
                  error: failure,
                  exitCode: error.exitCode,
                },
                null,
                2,
              ),
            );
          } else {
            console.error(`✗ ${host} call: ${error.message}`);
            console.error(`  Next: ${error.userAction}`);
          }
          return error.exitCode;
        }
        throw error;
      }
      const { result, violation } = executionResult;
      await started.finalize(result.artifactManifestPath);
      observers = undefined;
      await commandOptions.beforeResult?.();
      persistRunEffects(result.summaryPath, result.artifactManifestPath, state);
      if (violation !== null) {
        const conciseFailure = violation.originalError
          ? conciseFailureForHuman(violation.originalError)
          : '';
        const taughtViolation =
          violation.code === 'APP_LOGIC_FAILURE' &&
          conciseFailure.includes(' requires ') &&
          describedAction
            ? {
                ...violation,
                userAction: `${host} actions ${resolvedAction} --adapter ${adapter} --json`,
              }
            : violation;
        return emitHealViolation(json, 'call', result, taughtViolation, state, adapter);
      }
      const callOutput = readCallOutput(result.tracePath);
      const safeArgs = redactCallValue(args);
      const safeCallOutput = redactCallValue(callOutput);
      const failureUserAction = `${host} last --target ${shellQuote(target)} --json`;

      if (json) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              command: 'call',
              ...harnessContextField(),
              adapter,
              action: shortName,
              resolvedAction,
              args: safeArgs,
              ...(Object.keys(defaultsUsed).length > 0 ? { defaultsUsed } : {}),
              status: result.status,
              summaryPath: result.summaryPath,
              tracePath: result.tracePath,
              artifactManifestPath: result.artifactManifestPath,
              ...(result.diagnosticsPath ? { diagnosticsPath: result.diagnosticsPath } : {}),
              ...(result.sideFindings ? { sideFindings: result.sideFindings } : {}),
              ...(callOutput !== undefined ? { output: safeCallOutput } : {}),
              recovered: state.recovered,
              mutations: state.mutations,
              exitCode: result.status === 'pass' ? EXIT.ok : EXIT.runtime,
              ...(result.status === 'fail'
                ? {
                    error: {
                      code: 'ACTION_EXECUTION_FAILED',
                      message: `${resolvedAction} failed; inspect the persisted result and evidence paths`,
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
        const renderedInputs = Object.keys(args).length > 0 ? formatCallOutput(safeArgs) : '';
        const out = (style: string, text: string) => color(style, text, { stream: process.stdout });
        const diagnostics = formatRunDiagnosticsForHuman(
          readRunDiagnosticsDocument(result.diagnosticsPath),
          adapter,
        );
        const renderedDiagnostics = `${out('label', 'Diagnostics:')}\n${diagnostics.map((line) => `  ${line}`).join('\n')}\n`;
        console.log(
          `${out('label', 'call')} ${out('cmd', resolvedAction)}: ${out(result.status === 'pass' ? 'ok' : 'err', result.status)}` +
            `${renderedInputs ? `\n${out('label', 'Inputs:')}\n${renderedInputs}` : ''}` +
            `${Object.keys(defaultsUsed).length > 0 ? `\n${renderDefaultsUsed(defaultsUsed, process.stdout)}` : ''}` +
            `${callOutput !== undefined ? `\n${out('label', 'Result:')}\n${formatCallOutput(safeCallOutput)}` : ''}\n` +
            renderedDiagnostics +
            `${out('label', 'Artifacts:')} ${out('path', result.artifactManifestPath)}` +
            (result.status === 'fail' ? `\n  Next: ${failureUserAction}` : ''),
        );
      }
      return result.status === 'pass' ? EXIT.ok : EXIT.runtime;
    } finally {
      lock.release();
    }
  } finally {
    restoreRuntimeEnvironment();
  }
}

interface ParameterValidationHelp {
  issue: 'missing' | 'invalid';
  name: string;
  type?: string;
  validValues?: unknown[];
  description?: string;
  received?: unknown;
  suggestion?: string;
}

function parameterValidationHelp(
  action: DescribedAction | undefined,
  findings: ReadonlyArray<{ code: string; path: string }>,
  args: Record<string, unknown>,
): ParameterValidationHelp[] {
  const schema = isRecord(action?.schema) ? action.schema : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return findings.flatMap((finding) => {
    const issue = parameterIssue(finding.code);
    if (!issue) return [];
    const name = finding.path.split('.').at(-1);
    const property = name && isRecord(properties[name]) ? properties[name] : undefined;
    if (!name || !property) return [];
    const validValues = Array.isArray(property.enum) ? property.enum : undefined;
    const type =
      typeof property.type === 'string'
        ? property.type
        : Array.isArray(property.type)
          ? property.type.filter((value): value is string => typeof value === 'string').join('|')
          : undefined;
    const received = Object.hasOwn(args, name) ? args[name] : undefined;
    const suggestion =
      issue === 'invalid' && received !== undefined && validValues
        ? closest(String(received), validValues.map(String))
        : undefined;
    return [
      {
        issue,
        name,
        ...(type ? { type } : {}),
        ...(validValues ? { validValues } : {}),
        ...(typeof property.description === 'string' ? { description: property.description } : {}),
        ...(issue === 'invalid' && received !== undefined ? { received } : {}),
        ...(suggestion ? { suggestion } : {}),
      },
    ];
  });
}

function parameterIssue(code: string): ParameterValidationHelp['issue'] | undefined {
  if (code === 'recipe.missing_param') return 'missing';
  if (code === 'recipe.invalid_param_value_enum') return 'invalid';
  return undefined;
}

function renderParameterValidationHelp(parameter: ParameterValidationHelp): string {
  const out = (style: string, text: string) => color(style, text, { stream: process.stderr });
  const heading =
    parameter.issue === 'missing'
      ? `${out('cmd', parameter.name)}${parameter.type ? ` (${parameter.type}, required)` : ' (required)'}`
      : `${out('cmd', parameter.name)} received ${out('err', JSON.stringify(parameter.received) ?? String(parameter.received))}`;
  const values = parameter.validValues?.length
    ? ` Valid values: ${parameter.validValues.map((value) => out('accent', String(value))).join(', ')}.`
    : '';
  const suggestion = parameter.suggestion
    ? ` Did you mean ${out('accent', JSON.stringify(parameter.suggestion))}?`
    : '';
  const description = parameter.description ? ` ${parameter.description}` : '';
  return `  ${heading}.${values}${suggestion}${description}`;
}

function actionDefaultsUsed(
  action: DescribedAction | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const schema = isRecord(action?.schema) ? action.schema : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return Object.fromEntries(
    Object.entries(properties)
      .filter(
        ([name, entry]) =>
          !Object.hasOwn(args, name) && isRecord(entry) && Object.hasOwn(entry, 'default'),
      )
      .map(([name, entry]) => [name, (entry as Record<string, unknown>).default]),
  );
}

function renderDefaultsUsed(defaults: Record<string, unknown>, stream: NodeJS.WriteStream): string {
  const out = (style: string, text: string) => color(style, text, { stream });
  const values = Object.entries(defaults)
    .map(
      ([name, value]) =>
        `${out('cmd', name)}=${out('accent', JSON.stringify(value) ?? String(value))}`,
    )
    .join(', ');
  return `${out('label', 'Defaults used:')} ${values}`;
}

/** Each call writes to its own `calls/<action>-<uuid>`, under the task's artifacts or temp/recipe. */
export function callArtifactsLayout(action: string): RecipeArtifactsLayout {
  const own = path.join('calls', `${action.replace(/[^a-zA-Z0-9._-]/gu, '_')}-${randomUUID()}`);
  return { fresh: own, taskSubdir: own };
}

function readCallOutput(tracePath: string): unknown {
  try {
    const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    const entries = Array.isArray(trace)
      ? trace
      : isRecord(trace) && Array.isArray(trace.entries)
        ? trace.entries
        : [];
    const entry = entries.find((item: unknown) => isRecord(item) && item.nodeId === 'call');
    return isRecord(entry) && Object.prototype.hasOwnProperty.call(entry, 'output')
      ? entry.output
      : undefined;
  } catch {
    return undefined;
  }
}

function formatCallOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return String(value);
  return JSON.stringify(value, null, 2);
}

/** Call inputs and output with every sensitive-keyed value redacted. */
export function redactCallValue(value: unknown, key = ''): unknown {
  // Redact by semantic field name. Value-shape guesses are unsafe here: a
  // 32-byte transaction hash is indistinguishable from a private key, and a
  // mnemonic-shaped sentence can be legitimate proof output.
  return key && isSensitiveKey(key) ? '<redacted>' : redactStructuredValue(value);
}

// `call <action> --help` renders the named action's detail (the same block
// `actions --action <name>` prints) above the generic call flags, so parameter
// help for the action the user asked about is not hidden behind the generic call
// help. An unresolvable name falls back to the generic help plus a pointer to
// the vocabulary: exit 0. A refused input, such as the removed `--arg`, still
// exits 2.
export async function handleCallHelp(
  argv: string[],
  genericHelp: string,
  commandOptions: { catalog: RecipeCatalog },
): Promise<number> {
  const { catalog } = commandOptions;
  const host = harnessHost().name;
  const { action: shortName, rest } = parseCallArgs(
    argv.filter((arg) => arg !== '--help' && arg !== '-h'),
  );
  const { options } = parseArgs(rest);
  let adapter: string;
  let target: string;
  let manifest: unknown;
  let actionSources: Awaited<ReturnType<RecipeCatalog['resolveActionManifest']>>['actionSources'] =
    new Map();
  try {
    ({ adapter, target } = resolveAdapter(options));
    const resolution = await resolveCommandManifest(catalog, adapter, options);
    manifest = resolution.manifest;
    actionSources = resolution.actionSources;
  } catch {
    // No checkout/adapter context — the action schema is unavailable, so degrade to
    // the generic call help rather than failing a help request.
    process.stdout.write(`${genericHelp}\n`);
    return EXIT.ok;
  }
  const described = describeManifestActions(catalog, manifest, actionSources);
  const matches = shortName ? fuzzyResolveActions(described, shortName) : [];
  if (matches.length === 0) {
    process.stdout.write(`${genericHelp}\n`);
    if (shortName) {
      process.stdout.write(
        `\nNo action matches "${shortName}" for the ${adapter} adapter.\n` +
          `  Next: ${host} actions --adapter ${adapter}   # list the action vocabulary\n`,
      );
    }
    return EXIT.ok;
  }
  for (const entry of matches) {
    const detail = renderActionDetail(
      entry,
      adapter,
      target,
      invokedHostCommand(),
      described.map(({ name }) => name),
    );
    process.stdout.write(`${detail}\n\n`);
  }
  process.stdout.write(`${genericHelp}\n`);
  return EXIT.ok;
}

interface CallArgs {
  action: string | undefined;
  args: Record<string, unknown>;
  rest: string[];
}

function parseCallArgs(argv: string[]): CallArgs {
  const args: Record<string, unknown> = {};
  const rest: string[] = [];
  let action: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // Refuse rather than let parseArgs take the next token as its value.
    if (arg === '--arg' || arg.startsWith('--arg=')) {
      throw usageError('--arg was removed; pass the input as key=value');
    }
    if (!arg.startsWith('--') && action === undefined) {
      action = arg;
      continue;
    }
    if (action !== undefined && !isForwardedOptionValue(argv, i) && isArgPair(arg)) {
      const eq = arg.indexOf('=');
      args[arg.slice(0, eq)] = parseCallValue(arg.slice(eq + 1));
      continue;
    }
    rest.push(arg);
  }
  return { action, args, rest };
}

function parseCallValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  if (
    (value.startsWith('[') && value.endsWith(']')) ||
    (value.startsWith('{') && value.endsWith('}')) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      /* ordinary string containing brackets/braces */
    }
  }
  return value;
}

// An action input: `key=value`, never an inline `--flag=value`.
function isArgPair(value: string): boolean {
  return !value.startsWith('-') && value.indexOf('=') > 0;
}

function isForwardedOptionValue(argv: string[], index: number): boolean {
  if (index === 0) return false;
  const previous = argv[index - 1]!;
  if (!previous.startsWith('--') || previous.includes('=')) return false;
  const flag = previous.replace(/^--/u, '');
  return VALUE_TAKING_CALL_FLAGS.has(flag);
}

// Option flags whose next argument is their value, not a key=value input.
const VALUE_TAKING_CALL_FLAGS = new Set([
  'action-manifest',
  'approve-plan',
  'adapter',
  'artifacts-dir',
  'cdp-port',
  'device',
  'heal',
  'library',
  'platform',
  'runtime-dir',
  'slot',
  'source-digest',
  'source-kind',
  'source-name',
  'source-trust',
  'target',
  'validation-runtime-dir',
  'watcher-port',
]);

interface ActionResolution {
  status: 'ok' | 'ambiguous' | 'unknown';
  resolved: string;
  candidates: string[];
}

function resolveActionName(shortName: string, names: string[]): ActionResolution {
  const tier = fuzzyResolveActions(
    names.map((name) => ({ name })),
    shortName,
  ).map(({ name }) => name);
  if (tier.length === 1) return { status: 'ok', resolved: tier[0]!, candidates: tier };
  if (tier.length > 1) return { status: 'ambiguous', resolved: '', candidates: tier };
  return { status: 'unknown', resolved: '', candidates: [] };
}

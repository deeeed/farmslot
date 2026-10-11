// Shared argv/option parsing for dispatch-backed commands: positionals,
// camelCased options, repeatable `--library`, and the typed usage error.

import path from 'node:path';

import {
  adapterDetectNext,
  adapterFlags,
  adapterForPlatform,
  adapterPortEnv,
  assertAdapter,
  harnessAdapter,
  undetectedAdapterMessage,
} from './adapters.js';
import { CliError } from './cli-error.js';
import type { OptionSpec } from './command-contract.js';
import { contextAdapter } from './context-state.js';
import { EXIT } from './shared.js';

export type CliOptionValue = string | boolean | readonly string[];
export type CliOptions = Record<string, CliOptionValue>;

export interface ParsedArgs {
  positional: string[];
  options: CliOptions;
  rawArgv: string[];
}

export { CliError };

export function usageError(message: string): CliError {
  return new CliError(message, EXIT.usage);
}

export interface ParseArgsOptions {
  // `--record` is a plain flag instead of `--record-video=full-run`.
  recordIsFlag?: boolean;
  optionSpecs?: Readonly<Record<string, OptionSpec>>;
}

export function parseArgs(argv: string[], parse: ParseArgsOptions = {}): ParsedArgs {
  const positional: string[] = [];
  const options: CliOptions = {};
  const booleanOptions = new Set([
    'json',
    'jsonStream',
    'resetProfile',
    'preserveProfile',
    'record',
    'plan',
    'proof',
    'list',
    'describe',
    'raw',
    'matrix',
    'categories',
    'fix',
    'force',
    'expectLive',
    'printReady',
    'fast',
    'allDevices',
    'watch',
    'help',
    'noOpen',
    ...adapterFlags('commands'),
  ]);
  const repeatableOptions = new Set(['library']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const equalsIndex = body.indexOf('=');
    const rawKey = equalsIndex === -1 ? body : body.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : body.slice(equalsIndex + 1);
    const key = normalizeOptionKey(rawKey);
    const spec = parse.optionSpecs?.[`--${rawKey}`];
    if (key === 'recordVideo') {
      options.recordVideo = parseRecordVideoMode(inlineValue);
      continue;
    }
    if (key === 'recordBaseline') {
      options.record = true;
      continue;
    }
    if (key === 'record') {
      if (parse.recordIsFlag) {
        options.record = true;
        continue;
      }
      options.recordVideo = 'full-run';
      continue;
    }
    if (
      spec
        ? spec.kind === 'boolean' || (spec.kind === 'optional-value' && inlineValue === undefined)
        : booleanOptions.has(key)
    ) {
      options[key] = true;
      continue;
    }
    if (inlineValue !== undefined) {
      assignOption(options, key, inlineValue, repeatableOptions);
      continue;
    }
    if (i + 1 >= argv.length) throw usageError(`Missing value for ${arg}`);
    assignOption(options, key, argv[i + 1], repeatableOptions);
    i += 1;
  }
  return { positional, options, rawArgv: [...argv] };
}

function assignOption(
  options: CliOptions,
  key: string,
  value: string,
  repeatableOptions: ReadonlySet<string>,
): void {
  if (!repeatableOptions.has(key)) {
    options[key] = value;
    return;
  }
  const existing = options[key];
  if (existing === undefined) {
    options[key] = [value];
    return;
  }
  if (!Array.isArray(existing)) throw usageError(`--${key} has conflicting values.`);
  options[key] = [...existing, value];
}

export function parseRecipeParamAssignments(values: readonly string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const assignment of values) {
    const separator = assignment.indexOf('=');
    if (separator <= 0) {
      throw usageError(`recipe parameter ${JSON.stringify(assignment)} must use key=value.`);
    }
    const key = assignment.slice(0, separator).trim();
    if (!key) throw usageError(`recipe parameter ${JSON.stringify(assignment)} has an empty key.`);
    if (Object.hasOwn(params, key)) {
      throw usageError(`recipe parameter ${JSON.stringify(key)} was provided more than once.`);
    }
    const raw = assignment.slice(separator + 1);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    Object.defineProperty(params, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return params;
}

function parseRecordVideoMode(value: string | undefined): false | 'full-run' {
  if (value === undefined || value === '' || value === 'true') return 'full-run';
  if (value === 'off' || value === 'false') return false;
  if (value === 'proof-window' || value === 'proof_window') {
    throw usageError(
      '--record-video=proof-window is not supported yet; use --record-video=full-run.',
    );
  }
  if (value !== 'full-run') {
    throw usageError('--record-video must be full-run or off.');
  }
  return 'full-run';
}

function normalizeOptionKey(key: string): string {
  return key.replace(/-([a-z])/gu, (_, character: string) => character.toUpperCase());
}

export function optionString(options: CliOptions, key: string): string | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw usageError(`--${key} requires a value.`);
  return value;
}

export function optionStrings(options: CliOptions, key: string): readonly string[] | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw usageError(`--${key} requires a value.`);
  }
  return value;
}

export function optionFlag(options: CliOptions, key: string): boolean {
  const value = options[key];
  return value === true;
}

export function applyRuntimeDirOption(options: CliOptions): void {
  const runtimeDir = optionString(options, 'runtimeDir');
  if (runtimeDir) process.env.RECIPE_RUNTIME_DIR = runtimeDir;
}

export function applyWatcherPortOption(options: CliOptions): void {
  const watcherPort = optionString(options, 'watcherPort');
  if (!watcherPort) return;
  process.env.WATCHER_PORT = watcherPort;
  process.env.RECIPE_WATCHER_PORT = watcherPort;
  for (const name of adapterPortEnv()) process.env[name] = watcherPort;
}

export function requiredOption(options: CliOptions, key: string, message: string): string {
  const value = optionString(options, key);
  if (!value) throw usageError(message);
  return value;
}

// An unknown adapter is a usage error; an empty registry is an internal one
// and keeps its own error.
function adapterUsageError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith('internal:')) return error;
  return usageError(error instanceof Error ? error.message : String(error));
}

export function adapterOption(options: CliOptions): string {
  const adapter = optionString(options, 'adapter');
  try {
    assertAdapter(adapter);
  } catch (error) {
    throw adapterUsageError(error);
  }
  return adapter;
}

export function targetPath(options: CliOptions): string {
  return path.resolve(optionString(options, 'target') ?? process.cwd());
}

export function actionManifestPathOption(options: CliOptions, adapter: string): string {
  const configured = optionString(options, 'actionManifest');
  return configured ? path.resolve(configured) : harnessAdapter(adapter).actions.manifestPath();
}

export function parsePort(value: string | undefined, errorMessage: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0) throw usageError(errorMessage);
  return port;
}

// Shared adapter resolution: explicit --adapter/--platform, else the adapter the
// invocation's context resolved for --target/cwd (as doctor/verify/install
// take it). Lets `call`, `run --plan`, and `completion-candidates` work in a
// checkout without a flag.
export function resolveAdapter(options: CliOptions): { adapter: string; target: string } {
  const target = targetPath(options);
  const explicit =
    optionString(options, 'adapter') ?? adapterForPlatform(optionString(options, 'platform'));
  const adapter = explicit ?? contextAdapter(target);
  if (!adapter) {
    throw usageError(`${undetectedAdapterMessage(target)}\n  Next: ${adapterDetectNext()}`);
  }
  try {
    assertAdapter(adapter);
  } catch (error) {
    throw adapterUsageError(error);
  }
  return { adapter, target };
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function shellQuoteArg(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/u.test(value) ? value : shellQuote(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

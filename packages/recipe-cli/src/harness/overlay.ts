// install, verify and cleanup of the per-checkout runtime overlay. The command
// owns the grammar (adapter selection, --json, --quiet, `--` passthrough) and
// the envelope; the platform's `harness` member owns which leaf or in-process
// code runs.

import fs from 'node:fs';
import path from 'node:path';

import type { AdapterHarnessVerify, PlatformAdapter } from '@farmslot/adapter-sdk';

import {
  adapterDetectNext,
  detectAdapter,
  harnessAdapter,
  harnessAdapters,
  undetectedAdapterMessage,
} from './adapters.js';
import { colorHumanMessage } from './cli-color.js';
import { harnessHost } from './host.js';
import { missingShellLeafMessage, shellLeafMissing } from './leaf-invoke.js';
import { recipeHarnessPath, recipeRuntimeDir } from './paths.js';
import { spawnScriptStreaming } from './shared.js';

export type HarnessAction = 'install' | 'verify' | 'cleanup';

export interface OverlayInstallContext {
  adapter: string;
  target: string;
  // The arguments after the adapter selector, --json and --quiet.
  forward: string[];
  json: boolean;
}

export interface OverlayCommandOptions {
  // The full help text. Default: a generic one built from the host and registry.
  usage?: string;
  // Runs `install` itself when it returns an exit code (an install variant
  // selected by a flag); undefined falls through to the platform's leaf.
  install?(context: OverlayInstallContext): Promise<number> | undefined;
}

const HARNESS_ACTIONS: readonly HarnessAction[] = ['install', 'verify', 'cleanup'];

function defaultUsage(): string {
  const { name, product } = harnessHost();
  const adapters = harnessAdapters().list();
  return `${name} — install and validate the ${product} recipe runtime in a checkout.

Run it from inside a ${product} checkout; the platform (${adapters.join(' | ')})
is auto-detected from the repo. Pass --platform only to override.

Commands (one copy-pasteable example each):
  install   Install the recipe harness runtime overlay into the checkout.
              ${name} install
  verify    Check the harness/runtime is present and healthy (no app launch).
              ${name} verify
  cleanup   Remove the installed harness overlay and restore the checkout.
              ${name} cleanup

Options:
  --platform <${adapters.join('|')}>   Override auto-detection (alias: --adapter).
  --target <repo>                      Checkout to operate on (default: current dir).
  --json                               Machine-readable summary for agents/scripts.
  -- <args>                            Forward the rest verbatim to the underlying script.`;
}

function failureHint(surface: PlatformAdapter, action: HarnessAction): string {
  const restart = surface.harness.restart;
  if (!restart) {
    if (action === 'verify') {
      return `Install the ${surface.id} harness first: ${harnessHost().name} install --platform ${surface.id}`;
    }
    return 'Read the error above for the specific cause, then re-run this command.';
  }
  return `Read the error above for the specific cause. To (re)start the runtime, run: ${restart}`;
}

function successNext(adapter: string, action: HarnessAction, target: string): string {
  const { name } = harnessHost();
  const base = `--adapter ${adapter} --target ${shellQuote(target)}`;
  if (action === 'install') return `${name} verify ${base}`;
  if (action === 'cleanup') return `${name} install ${base}`;
  return `${name} status --target ${shellQuote(target)} --json`;
}

// has_arg: matches an exact flag or its `flag=value` form.
export function hasArg(args: string[], needle: string): boolean {
  return args.some((arg) => arg === needle || arg.startsWith(`${needle}=`));
}

// arg_value: value for `flag value` or `flag=value`, else undefined.
export function argValue(args: string[], needle: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === needle) return args[i + 1];
    if (args[i].startsWith(`${needle}=`)) return args[i].slice(needle.length + 1);
  }
  return undefined;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;
}

function isAdapter(value: string | undefined): value is string {
  return value !== undefined && harnessAdapters().has(value);
}

interface ParsedHarnessArgs {
  // Kept as raw string so invalid values (e.g. --adapter garbage) are not
  // silently accepted; narrowed via isAdapter() at the validation site.
  adapter?: string;
  json: boolean;
  quiet: boolean;
  forward: string[];
}

// Split the adapter selector and --json out of the remaining argv so they are not
// forwarded to the platform's leaf (leaves reject unknown flags, and a platform
// may take --platform itself, so only the first --platform whose value is an
// adapter is consumed here and a later one is passed through). `--` forces
// everything after it to passthrough.
function parseHarnessArgs(args: string[]): ParsedHarnessArgs {
  const forward: string[] = [];
  let adapter: string | undefined;
  let json = false;
  let quiet = false;
  let separator = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    // POSIX: everything after `--` is literal; check separator FIRST so that
    // --json appearing after `--` is forwarded verbatim to the delegate.
    if (separator) {
      forward.push(arg);
      continue;
    }
    if (arg === '--') {
      separator = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--quiet') {
      quiet = true;
      continue;
    }
    if (arg === '--adapter' || arg === '--platform') {
      const value = args[i + 1];
      if (arg === '--adapter') {
        adapter = value;
        i += 1;
        continue;
      }
      if (adapter === undefined && isAdapter(value)) {
        adapter = value;
        i += 1;
        continue;
      }
      forward.push(arg);
      continue;
    }
    if (arg.startsWith('--adapter=')) {
      adapter = arg.slice('--adapter='.length);
      continue;
    }
    if (arg.startsWith('--platform=')) {
      const value = arg.slice('--platform='.length);
      if (adapter === undefined && isAdapter(value)) {
        adapter = value;
        continue;
      }
      forward.push(arg);
      continue;
    }
    forward.push(arg);
  }
  return { adapter, json, quiet, forward };
}

// Resolve the agentic-runtime.json path for a checkout: the RECIPE_RUNTIME_CONTEXT
// override wins, else the per-checkout runtime dir. Single source shared by
// platform pre-dispatch hydration and doctor's runtime-context report.
export function resolveRuntimeContextPath(target: string): string {
  return (
    process.env.RECIPE_RUNTIME_CONTEXT ??
    path.join(target, recipeRuntimeDir(), 'agentic-runtime.json')
  );
}

// read_runtime_context_field: dotted lookup returning the value only when it is a
// present, non-empty scalar; undefined when the file/field is missing.
export function readRuntimeContextField(contextPath: string, field: string): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  } catch {
    return undefined;
  }
  let node: unknown = data;
  for (const key of field.split('.')) {
    if (node === undefined || node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  if (node === undefined || node === null || node === '') return undefined;
  return String(node);
}

// runner_executable_entry / runner_file_entry: first candidate that exists (as an
// executable, or as any file) wins; otherwise the first candidate is returned so
// the exec error names it.
function resolveEntry(base: string, candidates: string[], mode: 'exec' | 'file'): string {
  for (const candidate of candidates) {
    const full = path.resolve(base, candidate);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      if (mode === 'file' || (stat.mode & 0o111) !== 0) return full;
    } catch {
      // missing candidate; try the next one
    }
  }
  return path.resolve(base, candidates[0]);
}

// Content of an installed overlay's runner source pointer, if present. Command
// substitution in the skill stripped trailing newlines, so trim here too.
// Validates the path exists so stale stamps (e.g. from a renamed package dir)
// fall back to the host package root rather than producing ENOENT at cleanup.
function installedRunnerSource(target: string, adapter: string): string | undefined {
  const pointer = path.join(recipeHarnessPath(target, adapter), 'runner', '.runner-source');
  if (!fs.existsSync(pointer)) return undefined;
  const value = fs.readFileSync(pointer, 'utf8').trim();
  if (!value || !fs.existsSync(value)) return undefined;
  return value;
}

// Resolve the exact command + fixed prefix args to exec, mirroring
// recipe-harness.sh dispatch_adapter_action. forwardArgs are appended by the
// caller. install and cleanup run the platform's leaf (entry, then fallback);
// verify is whatever the platform dispatches: a leaf, a delegate, runner-owned
// code in this process, or an error to report.
function resolveHarnessDispatch(
  surface: PlatformAdapter,
  action: HarnessAction,
  target: string,
): AdapterHarnessVerify {
  if (action === 'verify') return surface.harness.verify(target);
  const leaf = action === 'install' ? surface.harness.install : surface.harness.cleanup;
  const { packageRoot } = harnessHost();
  const base =
    action === 'cleanup' && surface.harness.cleanup.fromInstalledRunner
      ? (installedRunnerSource(target, surface.id) ?? packageRoot)
      : packageRoot;
  const entry = resolveEntry(base, [leaf.entry, leaf.fallback], 'file');
  // Shell leaves are invoked through bash; file existence is the only requirement.
  return leaf.node
    ? { command: process.execPath, prefixArgs: [entry] }
    : { command: entry, prefixArgs: [] };
}

export async function handleHarness(
  argv: string[],
  commandOptions: OverlayCommandOptions = {},
): Promise<number> {
  const printUsage = (): void => console.error(commandOptions.usage ?? defaultUsage());
  const action = argv[0];
  if (!action || action === '-h' || action === '--help') {
    printUsage();
    return action ? 0 : 2;
  }
  if (!HARNESS_ACTIONS.includes(action as HarnessAction)) {
    printUsage();
    console.error(`unsupported harness subcommand: ${action}`);
    return 2;
  }
  const harnessAction = action as HarnessAction;

  const { adapter: parsedAdapter, json, quiet, forward } = parseHarnessArgs(argv.slice(1));
  const rawTarget = argValue(forward, '--target');
  const target = path.resolve(rawTarget ?? process.cwd());

  const adapter = parsedAdapter ?? detectAdapter(target);
  // isAdapter() narrows adapter to a registered id for all code below.
  if (!adapter || !isAdapter(adapter)) {
    if (quiet) {
      return 2;
    } else if (json) {
      // parsedAdapter is string|undefined here; not yet validated as a real
      // adapter, so pass undefined rather than forwarding a garbage string.
      const detectError = adapter
        ? {
            code: 'UNSUPPORTED_PLATFORM',
            message: `unsupported platform: ${adapter}`,
            userAction: `pass --adapter <${harnessAdapters().list().join('|')}> to specify a supported adapter`,
          }
        : {
            code: 'ADAPTER_DETECTION_FAILED',
            message: undetectedAdapterMessage(target),
            userAction: adapterDetectNext(),
          };
      console.log(harnessSummary(harnessAction, undefined, target, 'fail', 2, false, detectError));
    } else {
      printUsage();
      console.error(
        adapter
          ? `\n✗ unsupported platform: ${adapter}`
          : `\n✗ ${undetectedAdapterMessage(target)}\n  Next: ${adapterDetectNext()}`,
      );
    }
    return 2;
  }
  const autoDetected = parsedAdapter === undefined;

  // Forward args carry --target so the orchestration script resolves the same
  // checkout; inject the resolved path only when the caller omitted it.
  let forwardArgs = hasArg(forward, '--target') ? [...forward] : ['--target', target, ...forward];

  if (harnessAction === 'install' && commandOptions.install) {
    const handled = commandOptions.install({ adapter, target, forward, json });
    if (handled !== undefined) return handled;
  }

  const surface = harnessAdapter(adapter);
  if (harnessAction === 'verify' && surface.harness.verifyArgs) {
    forwardArgs = surface.harness.verifyArgs(target, forwardArgs);
  }

  const dispatch = resolveHarnessDispatch(surface, harnessAction, target);
  if ('error' in dispatch) {
    if (quiet) {
      return 1;
    } else if (json) {
      console.log(
        harnessSummary(harnessAction, adapter, target, 'fail', 1, autoDetected, {
          code: 'DISPATCH_UNAVAILABLE',
          message: dispatch.error,
          // The dispatch error embeds "Next: <hint>" — extract it so --json consumers
          // get a clean programmatic escape without parsing the human message.
          userAction:
            dispatch.error.split('\nNext: ')[1] ??
            `run ${harnessHost().name} install to complete setup, then retry`,
        }),
      );
    } else {
      console.error(
        `✗ ${harnessAction} ${adapter} failed\n  ${dispatch.error.replace(/\n/gu, '\n  ')}`,
      );
    }
    return 1;
  }

  if (!json && !quiet) {
    const detected = autoDetected ? ', auto-detected' : '';
    console.error(
      colorHumanMessage(`→ ${harnessAction} (${adapter}${detected}) — target: ${target}`),
    );
  }

  const start = Date.now();

  if ('inProcess' in dispatch) {
    const runVerify = await dispatch.inProcess();
    // --json keeps stdout for the summary alone, so the in-process report goes
    // to stderr exactly where a spawned leaf's stdout would have been routed.
    let exitCode: number;
    try {
      exitCode = await runVerify(forwardArgs, {
        out: quiet
          ? () => {}
          : (line) => {
              (json ? process.stderr : process.stdout).write(`${line}\n`);
            },
        err: quiet
          ? () => {}
          : (line) => {
              process.stderr.write(`${line}\n`);
            },
      });
    } catch (error) {
      // A spawned leaf could only exit non-zero; in-process code can throw. The
      // envelope contract (one JSON document on stdout, HARNESS_FAILED) holds
      // either way, and the cause goes where the leaf's stderr went.
      if (!quiet)
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      exitCode = 1;
    }
    return reportHarnessOutcome(
      harnessAction,
      surface,
      target,
      exitCode,
      autoDetected,
      json,
      quiet,
      start,
    );
  }

  // Shell leaves need bash invocation; bash exits 127 (not ENOENT) for missing files.
  if (shellLeafMissing(dispatch.command)) {
    const message = missingShellLeafMessage(dispatch.command);
    if (quiet) {
      return 1;
    } else if (json) {
      console.log(
        harnessSummary(harnessAction, adapter, target, 'fail', 1, autoDetected, {
          code: 'HARNESS_SPAWN_FAILED',
          message,
          userAction: failureHint(surface, harnessAction),
        }),
      );
    } else {
      console.error(`✗ ${message}`);
    }
    return 1;
  }

  const result = await spawnScriptStreaming(
    dispatch.command,
    [...dispatch.prefixArgs, ...forwardArgs],
    target,
    {
      forward: quiet ? 'none' : json ? 'stderr' : 'original',
      stdin: quiet ? 'ignore' : 'inherit',
      capture: false,
    },
  );

  if (result.error) {
    if (quiet) {
      return 1;
    } else if (json) {
      console.log(
        harnessSummary(harnessAction, adapter, target, 'fail', 1, autoDetected, {
          code: 'HARNESS_SPAWN_FAILED',
          message: `${harnessAction} ${adapter} could not start: ${result.error.message}`,
          userAction: failureHint(surface, harnessAction),
        }),
      );
    } else {
      console.error(
        `✗ ${harnessAction} ${adapter} could not start: ${result.error.message}\n  ${failureHint(surface, harnessAction)}`,
      );
    }
    return 1;
  }

  return reportHarnessOutcome(
    harnessAction,
    surface,
    target,
    result.status ?? 1,
    autoDetected,
    json,
    quiet,
    start,
  );
}

// One outcome report for both execution paths (spawned leaf and in-process
// adapter code) so their --json envelope and human lines cannot drift.
function reportHarnessOutcome(
  action: HarnessAction,
  surface: PlatformAdapter,
  target: string,
  exitCode: number,
  autoDetected: boolean,
  json: boolean,
  quiet: boolean,
  start: number,
): number {
  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  const adapter = surface.id;
  if (quiet) {
    return exitCode;
  } else if (json) {
    console.log(
      harnessSummary(
        action,
        adapter,
        target,
        exitCode === 0 ? 'pass' : 'fail',
        exitCode,
        autoDetected,
        exitCode === 0
          ? undefined
          : {
              code: 'HARNESS_FAILED',
              message: `${action} ${adapter} failed (exit ${exitCode})`,
              userAction: failureHint(surface, action),
            },
      ),
    );
  } else if (exitCode === 0) {
    console.error(
      colorHumanMessage(
        `✓ ${action} ${adapter} passed (${seconds}s)\n  Next: ${successNext(adapter, action, target)}`,
      ),
    );
  } else {
    console.error(
      colorHumanMessage(
        `✗ ${action} ${adapter} failed (exit ${exitCode}, ${seconds}s)\n  ${failureHint(surface, action)}`,
      ),
    );
  }
  return exitCode;
}

// userAction is required whenever an error object is present so every --json
// failure carries a machine-readable escape path — parallel to the `usageOut`
// enforcement on the CLI layer. Omitting userAction is a compile-time error.
function harnessSummary(
  action: HarnessAction,
  adapter: string | undefined,
  target: string,
  status: 'pass' | 'fail',
  exitCode: number,
  autoDetected: boolean,
  error?: { code: string; message: string; userAction: string },
): string {
  return JSON.stringify({
    schemaVersion: 1,
    command: 'harness',
    action,
    adapter: adapter ?? null,
    target,
    autoDetected,
    status,
    exitCode,
    // Error contract: every --json failure carries a stable machine code + human
    // message. userAction is included when present so callers
    // can surface the reachable escape without parsing the human message.
    ...(status === 'fail' && error ? { error } : {}),
    ...(status === 'pass' && adapter ? { next: successNext(adapter, action, target) } : {}),
  });
}

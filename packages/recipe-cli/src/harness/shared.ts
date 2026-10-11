// Shared helpers for the harness command modules: flag parsing, adapter
// resolution, leaf composition, and the teaching-error emitter.
//
// Composition seam (overridable for contract tests):
//   <envPrefix>_SCRIPT_BIN_<STEM>  — override a specific script by its basename.
//   For node invocations (bin === process.execPath) the stem is derived from the
//   script path in args[0], e.g. <envPrefix>_SCRIPT_BIN_OPEN_DEBUG_MJS.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { runOwnedRecipeProcess } from '@farmslot/recipe-runner/adapters/core';
import { OperationOutputTail } from '@farmslot/recipe-runner/runtime/operation';

import { adapterForPlatform, harnessAdapters } from './adapters.js';
import { trackCheckoutChild } from './checkout-lock.js';
import { colorHumanMessage } from './cli-color.js';
import { recordCommandOutput, recordCommandStage } from './command-journal.js';
import { contextAdapter, harnessContextField } from './context-state.js';
import { harnessHost, hostEnvName, recipeExecutionSignal, withRecipeSignals } from './host.js';
import { leafStartFailureMessage, resolveLeafInvoke, shellLeafMissing } from './leaf-invoke.js';

// Stable public exit-code taxonomy.
export const EXIT = { ok: 0, runtime: 1, usage: 2, infra: 3, bounded: 4, validation: 5 } as const;

export function writeInteractiveProgress(
  json: boolean,
  message: string,
  {
    stdoutIsTTY = Boolean(process.stdout.isTTY),
    stream = process.stderr,
  }: {
    stdoutIsTTY?: boolean;
    stream?: Pick<NodeJS.WriteStream, 'write'>;
  } = {},
): boolean {
  if (json || !stdoutIsTTY) return false;
  stream.write(`${colorHumanMessage(message, { stream: stream as NodeJS.WriteStream })}\n`);
  return true;
}

export interface ParsedFlags {
  positional: string[];
  options: Record<string, string | boolean>;
}

// Positionals + boolean/valued flags; camelCases --foo-bar to fooBar.
export function parseFlags(argv: string[], booleans: Set<string>): ParsedFlags {
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    const rawKey = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);
    const key = rawKey.replace(/-([a-z])/gu, (_, c: string) => c.toUpperCase());
    if (booleans.has(key)) {
      options[key] = inline === undefined ? true : inline !== 'false';
      continue;
    }
    if (inline !== undefined) {
      options[key] = inline;
      continue;
    }
    // Valued flag with a following token, unless the next token is itself a flag.
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return { positional, options };
}

export function str(options: Record<string, string | boolean>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' ? value : undefined;
}

export function flag(options: Record<string, string | boolean>, key: string): boolean {
  return options[key] === true;
}

export function targetOf(options: Record<string, string | boolean>): string {
  return path.resolve(str(options, 'target') ?? process.cwd());
}

// Explicit --adapter/--platform (a platform target selects its adapter), else
// an optional hint, else the adapter the invocation's context resolved.
export function resolveFlagsAdapter(
  options: Record<string, string | boolean>,
  target: string,
  hint?: string,
): string | undefined {
  const explicit = str(options, 'adapter') ?? adapterForPlatform(str(options, 'platform'));
  if (explicit && harnessAdapters().has(explicit)) return explicit;
  if (hint) return hint;
  return contextAdapter(target);
}

export interface ScriptResult {
  error?: Error;
  status: number;
  output: string;
  timedOut?: boolean;
  timeoutMs?: number;
}

export interface StreamingSpawnOptions {
  signal?: AbortSignal;
  stage?: string;
  capture?: boolean;
  stdin?: 'ignore' | 'inherit';
  forward?: 'stderr' | 'original' | 'none';
  env?: Record<string, string>;
  timeoutMs?: number;
}

// The composition-seam override path for a script, if set — same stem derivation
// spawnScript uses. Lets a caller pre-check the SAME bin that will actually run
// (and lets contract tests simulate a missing leaf by pointing the seam at a
// nonexistent path). Returns undefined when no override is set (production).
export function scriptOverride(scriptPath: string): string | undefined {
  const stem = path
    .basename(scriptPath)
    .replace(/[^A-Za-z0-9]/gu, '_')
    .toUpperCase();
  return process.env[hostEnvName(`SCRIPT_BIN_${stem}`)];
}

// Compose an adapters/ script directly. Output is always captured (needed for
// heal classification) and, in human mode, forwarded to stderr. --json keeps
// stdout clean for the machine summary. `env` overlays extra vars onto the
// inherited environment for spawns that need a scoped variable (e.g. color mode).
export function spawnScript(
  script: string,
  args: string[],
  cwd: string,
  json: boolean,
  env?: Record<string, string>,
): ScriptResult {
  // For node invocations (script === process.execPath) the seam stem is derived
  // from args[0] so each spawned script has its own override key.
  const isNodeScript = script === process.execPath && args.length > 0;
  // Seam stem: for node invocations derive from args[0] so each script has its
  // own override key; for shell and other leaves derive from the script basename.
  const stem = isNodeScript
    ? path
        .basename(args[0])
        .replace(/[^A-Za-z0-9]/gu, '_')
        .toUpperCase()
    : path
        .basename(script)
        .replace(/[^A-Za-z0-9]/gu, '_')
        .toUpperCase();
  const override = process.env[hostEnvName(`SCRIPT_BIN_${stem}`)];
  const bin = override ?? script;
  const directArgs = override !== undefined && isNodeScript ? args.slice(1) : args;

  // Shell leaves (.sh) run through bash so file mode need not be executable.
  // Bash exits 127 (not a Node spawn error) for a missing file, so pre-check.
  if (shellLeafMissing(bin)) {
    const message = leafStartFailureMessage(path.basename(bin), 'ENOENT');
    process.stderr.write(`${message}\n`);
    return { status: 1, output: message };
  }

  const { bin: invokeBin, args: spawnArgs } = resolveLeafInvoke(bin, directArgs);
  recordCommandStage(path.basename(isNodeScript ? args[0] : script));
  const result = spawnSync(invokeBin, spawnArgs, {
    cwd,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    // Spawn failure for non-shell leaves (ENOENT/EACCES) or when bash itself
    // cannot start. Always emit so a leaf that cannot start is never silent.
    // For node invocations the leaf name comes from args[0], not process.execPath.
    const leaf = isNodeScript ? path.basename(args[0]) : path.basename(script);
    const code = (result.error as NodeJS.ErrnoException).code ?? 'ESPAWN';
    const message = leafStartFailureMessage(leaf, code);
    process.stderr.write(`${message}\n`);
    return { status: 1, output: message };
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  recordCommandOutput(output);
  if (!json && output) process.stderr.write(output);
  return { status: result.status ?? 1, output };
}

// Inherit-stdio variant for interactive/streaming leaves (e.g. `logs` tailing a
// live file with tail -F / a follow viewer). spawnScript CAPTURES output, so a
// never-exiting follow shows the user nothing; this hands the terminal to the
// child so its output streams live. No capture, no envelope — the command owns
// its own --json handling.
export function spawnInherit(script: string, args: string[], cwd: string): number {
  // Honor the same <envPrefix>_SCRIPT_BIN_<STEM> override seam as spawnScript so
  // contract tests can stub tail/log-tui with a recorder (a real `tail -F`
  // follows forever and hangs the test). Stem/override logic mirrors spawnScript.
  const isNodeScript = script === process.execPath && args.length > 0;
  const stem = (isNodeScript ? path.basename(args[0]) : path.basename(script))
    .replace(/[^A-Za-z0-9]/gu, '_')
    .toUpperCase();
  const override = process.env[hostEnvName(`SCRIPT_BIN_${stem}`)];
  const bin = override ?? script;
  const directArgs = override !== undefined && isNodeScript ? args.slice(1) : args;
  const { bin: invokeBin, args: spawnArgs } = resolveLeafInvoke(bin, directArgs);
  const result = spawnSync(invokeBin, spawnArgs, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) {
    // Teach on spawn failure like spawnScript/spawnScriptStreaming do (errors
    // always teach escape) — the override-seam path can point at a missing bin.
    const leaf = isNodeScript ? path.basename(args[0]) : path.basename(script);
    const code = (result.error as NodeJS.ErrnoException).code ?? 'ESPAWN';
    process.stderr.write(`${leafStartFailureMessage(leaf, code, 'leaf')}\n`);
    return 1;
  }
  // Interactive follow: Ctrl-C (SIGINT) / SIGTERM is a normal user stop → success;
  // any other signal (crash) is a failure.
  if (result.status !== null) return result.status;
  return result.signal === 'SIGINT' || result.signal === 'SIGTERM' ? 0 : 1;
}

// Streaming variant of spawnScript for long-running leaves (mobile prepare:
// native build + Metro + health-bridge poll, minutes long). spawnScript buffers
// via spawnSync and, in --json mode, suppresses output entirely — so those leaves
// run with zero feedback until exit. This tees the child's stdout+stderr to the
// parent's STDERR live (so the --json envelope on stdout stays clean) while still
// capturing the combined output for heal classification. Same seam, leaf-invoke
// resolution, missing-leaf pre-check, and spawn-error contract as spawnScript.
export function spawnScriptStreaming(
  script: string,
  args: string[],
  cwd: string,
  options?: Record<string, string> | StreamingSpawnOptions,
): Promise<ScriptResult> {
  const spawnOptions: StreamingSpawnOptions =
    options &&
    ('env' in options ||
      'timeoutMs' in options ||
      'forward' in options ||
      'capture' in options ||
      'stdin' in options ||
      'stage' in options ||
      'signal' in options)
      ? (options as StreamingSpawnOptions)
      : { env: options as Record<string, string> | undefined };
  const isNodeScript = script === process.execPath && args.length > 0;
  const stem = isNodeScript
    ? path
        .basename(args[0])
        .replace(/[^A-Za-z0-9]/gu, '_')
        .toUpperCase()
    : path
        .basename(script)
        .replace(/[^A-Za-z0-9]/gu, '_')
        .toUpperCase();
  const override = process.env[hostEnvName(`SCRIPT_BIN_${stem}`)];
  const bin = override ?? script;
  const directArgs = override !== undefined && isNodeScript ? args.slice(1) : args;

  if (shellLeafMissing(bin)) {
    const message = leafStartFailureMessage(path.basename(bin), 'ENOENT');
    if (spawnOptions.forward !== 'none') process.stderr.write(`${message}\n`);
    return Promise.resolve({ status: 1, output: message });
  }

  const { bin: invokeBin, args: spawnArgs } = resolveLeafInvoke(bin, directArgs);
  recordCommandStage(spawnOptions.stage ?? path.basename(isNodeScript ? args[0] : script));
  const signal = spawnOptions.signal ?? recipeExecutionSignal();
  let forwardedParentSignal: NodeJS.Signals | undefined;
  const captured = new OperationOutputTail();
  let spawnError: NodeJS.ErrnoException | undefined;
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  return withRecipeSignals(
    (scoped) =>
      runOwnedRecipeProcess(invokeBin, spawnArgs, {
        cwd,
        env: spawnOptions.env ? { ...process.env, ...spawnOptions.env } : process.env,
        signal: scoped,
        timeoutMs: spawnOptions.timeoutMs,
        stdin: spawnOptions.stdin,
        capture: false,
        onSpawn: (pid, ownsGroup) => trackCheckoutChild(cwd, pid, ownsGroup),
        onSpawnError: (error) => {
          spawnError = error;
        },
        onOutput: (chunk, stream) => {
          if (spawnOptions.capture !== false) captured.append(decoders[stream].write(chunk));
          recordCommandOutput(chunk);
          if (spawnOptions.forward !== 'none') {
            (stream === 'stdout' && spawnOptions.forward === 'original'
              ? process.stdout
              : process.stderr
            ).write(chunk);
          }
        },
      })
        .then((result) => {
          if (spawnOptions.capture !== false) {
            captured.append(decoders.stdout.end());
            captured.append(decoders.stderr.end());
          }
          if (result.timedOut) {
            const message = `leaf timed out after ${String(spawnOptions.timeoutMs)}ms: ${path.basename(script)}`;
            captured.append(`\n${message}\n`);
            if (spawnOptions.forward !== 'none') process.stderr.write(`${message}\n`);
          }
          return {
            status: result.timedOut ? 1 : result.exitCode,
            output: captured.toString(),
            ...(result.timedOut
              ? { timedOut: true, timeoutMs: Number(spawnOptions.timeoutMs) }
              : {}),
          };
        })
        .catch((error: NodeJS.ErrnoException) => {
          if (signal?.aborted) throw error;
          if (scoped.aborted) {
            forwardedParentSignal = scoped.reason as NodeJS.Signals;
            return { status: 1, output: captured.toString() };
          }
          if (error !== spawnError) throw error;
          const leaf = isNodeScript ? path.basename(args[0]) : path.basename(script);
          const message = leafStartFailureMessage(leaf, error.code ?? 'ESPAWN');
          if (spawnOptions.forward !== 'none') process.stderr.write(`${message}\n`);
          return { status: 1, output: message, error };
        }),
    signal ?? (process.platform === 'win32' ? new AbortController().signal : undefined),
  ).finally(() => {
    if (forwardedParentSignal) process.kill(process.pid, forwardedParentSignal);
  });
}

// Teaching-error emitter (exit 2, machine-readable in --json). `userAction` is
// REQUIRED: a teaching error without a reachable escape must not compile, so the
// escape is a typed parameter rather than free-form prose spliced into `message`.
export function usageOut(
  json: boolean,
  command: string,
  message: string,
  userAction: string,
): number {
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command,
          ...harnessContextField(),
          status: 'fail',
          exitCode: EXIT.usage,
          error: { code: 'USAGE', message, userAction },
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`✗ ${harnessHost().name} ${command}: ${message}\n  Next: ${userAction}`);
  }
  return EXIT.usage;
}

export function checkoutBusyOut(
  json: boolean,
  command: string,
  message: string,
  lockPath: string,
): number {
  const userAction = `wait for the current owner, or inspect ${lockPath} if its process has exited`;
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command,
          status: 'fail',
          exitCode: EXIT.bounded,
          recoverable: false,
          error: { code: 'SANDBOX_BUSY', message, userAction },
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`✗ ${harnessHost().name} ${command}: ${message}\n  Next: ${userAction}`);
  }
  return EXIT.bounded;
}

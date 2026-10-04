// launch — start the app (dev server/build + surface), auto-ensure the runtime
// overlay, and heal transport within bounds. Owns the launch grammar shared by
// every platform (--heal, adapter resolution, the checkout lock) and the
// --json-stream envelope; each platform's `launch` owns the rest.

import fs from 'node:fs';

import {
  adapterDetectNext,
  adapterFlags,
  adapterForPlatform,
  harnessAdapter,
  isPlatformTarget,
  undetectedAdapterMessage,
} from '../adapters.js';
import { acquireCheckoutLock } from '../checkout-lock.js';
import { parseHeal } from '../heal-bounds.js';
import { harnessHost } from '../host.js';
import { JsonStreamWriter } from '../json-stream.js';
import {
  checkoutBusyOut,
  EXIT,
  flag,
  parseFlags,
  resolveFlagsAdapter,
  str,
  targetOf,
  usageOut,
} from '../shared.js';

function launchBooleans(): Set<string> {
  return new Set(['json', 'jsonStream', ...adapterFlags('launch')]);
}

export async function handleLaunch(argv: string[]): Promise<number> {
  const { options } = parseFlags(argv, launchBooleans());
  const json = flag(options, 'json');
  const stream = new JsonStreamWriter('launch', flag(options, 'jsonStream'));
  const jsonOutput = json && !stream.enabled;
  const restoreStdout = stream.isolateStdout();
  const target = targetOf(options);
  try {
    let exitCode: number;
    if (!fs.existsSync(target)) {
      exitCode = await handleLaunchLocked(argv, stream);
    } else {
      const lock = acquireCheckoutLock(target, 'launch');
      if ('message' in lock) {
        const userAction = `wait for the current owner, or inspect ${lock.path} if its process has exited`;
        stream.error({ code: 'SANDBOX_BUSY', message: lock.message, userAction });
        exitCode = checkoutBusyOut(jsonOutput, 'launch', lock.message, lock.path);
      } else {
        try {
          exitCode = await handleLaunchLocked(argv, stream);
        } finally {
          lock.release();
        }
      }
    }
    stream.complete(exitCode === EXIT.ok ? 'pass' : 'fail', exitCode);
    return exitCode;
  } catch (error) {
    const exitCode =
      error !== null &&
      typeof error === 'object' &&
      'exitCode' in error &&
      typeof (error as { exitCode?: unknown }).exitCode === 'number'
        ? (error as { exitCode: number }).exitCode
        : EXIT.runtime;
    stream.error({
      code: exitCode === EXIT.usage ? 'CLI_USAGE_ERROR' : 'LAUNCH_FAILED',
      message: error instanceof Error ? error.message : String(error),
      userAction: `${harnessHost().name} doctor --target ${quoteWord(target)} --json`,
    });
    stream.complete('fail', exitCode);
    throw error;
  } finally {
    restoreStdout();
  }
}

async function handleLaunchLocked(argv: string[], stream: JsonStreamWriter): Promise<number> {
  const { positional, options } = parseFlags(argv, launchBooleans());
  const json = flag(options, 'json');
  const jsonOutput = json && !stream.enabled;
  const machine = json || stream.enabled;
  const target = targetOf(options);

  const heal = parseHeal(options, 'auto');
  if (typeof heal !== 'string')
    return launchUsage(jsonOutput, stream, heal.error, 'use --heal off|infra-only|auto');

  // A platform target (`launch ios`, or --platform ios) also selects its adapter.
  const positionalTarget = isPlatformTarget(positional[0]) ? positional[0] : undefined;
  const platformFlag = str(options, 'platform');
  const platformTarget =
    positionalTarget ?? (isPlatformTarget(platformFlag) ? platformFlag : undefined);
  const adapter = resolveFlagsAdapter(options, target, adapterForPlatform(platformTarget));

  if (!adapter) {
    return launchUsage(jsonOutput, stream, undetectedAdapterMessage(target), adapterDetectNext());
  }
  stream.phase('resolve', { target, adapter, platform: platformTarget ?? null });
  return harnessAdapter(adapter).launch({
    adapter,
    target,
    options,
    platformTarget,
    heal,
    jsonOutput,
    machine,
    stream,
    usage: (message, userAction) => launchUsage(jsonOutput, stream, message, userAction),
  });
}

function launchUsage(
  json: boolean,
  stream: JsonStreamWriter,
  message: string,
  userAction: string,
): number {
  stream.error({ code: 'USAGE', message, userAction });
  return usageOut(json, 'launch', message, userAction);
}

// Shell-quote one word for a launch `userAction`, leaving plain paths bare.
function quoteWord(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replace(/'/gu, "'\"'\"'")}'`;
}

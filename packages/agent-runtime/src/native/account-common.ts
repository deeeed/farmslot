import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

import type {
  NativeAccountObservation,
  NativeAccountProbeOptions,
  NativeAccountState,
} from './account-types.js';

export class AccountProbeError extends Error {
  constructor(readonly reason: NonNullable<NativeAccountObservation['reason']>) {
    super(reason);
  }
}
export function accountObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AccountProbeError('malformed-status');
  return value as Record<string, unknown>;
}
/** Bound native public fields; unsupported values are unavailable rather than coerced. */
export function accountString(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.trim() &&
    value.length <= 320 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value.trim()
    : undefined;
}
export function accountId(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : accountString(value);
}
export const unavailableAccount = (): NativeAccountState => ({
  login: 'unavailable',
  mode: 'unknown',
  identityQuality: 'unavailable',
});
export const signedOutAccount = (): NativeAccountState => ({
  login: 'signed-out',
  mode: 'unknown',
  identityQuality: 'unavailable',
});

/** Some native status commands return exit1 with a valid signed-out JSON response. */
export function accountCommand(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  allowStatusExit = false,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      executable,
      args,
      {
        ...options,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        killSignal: 'SIGKILL',
      },
      (error, stdout) => {
        if (error && !(allowStatusExit && error.code === 1 && !error.killed && !error.signal)) {
          reject(new AccountProbeError('status-unavailable'));
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
}
export async function accountJsonCommand(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<unknown> {
  const text = await accountCommand(executable, args, options, true);
  try {
    return JSON.parse(text);
  } catch {
    throw new AccountProbeError('malformed-status');
  }
}

async function executablePath(
  binary: string,
  options: NativeAccountProbeOptions,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const requested = binary.startsWith('~/') ? join(env.HOME ?? homedir(), binary.slice(2)) : binary;
  const candidates = isAbsolute(requested)
    ? [requested]
    : requested.includes('/')
      ? [resolve(options.cwd, requested)]
      : (env.PATH ?? '').split(delimiter).map((dir) => resolve(options.cwd, dir, requested));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
    } catch (error) {
      if (['ENOENT', 'EACCES', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        continue;
      throw new AccountProbeError('executable-unavailable');
    }
    // Keep configured shims/wrappers intact: the explicit environment selects their profile/version.
    try {
      return await realpath(candidate);
    } catch {
      throw new AccountProbeError('executable-unavailable');
    }
  }
}

export async function observeNativeAccount(
  runner: NativeAccountObservation['runner'],
  binary: string,
  options: NativeAccountProbeOptions,
  probe: (options: {
    cwd: string;
    executable: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<NativeAccountState>,
): Promise<NativeAccountObservation> {
  const base: NativeAccountObservation = {
    runner,
    installed: false,
    ...unavailableAccount(),
    observedAt: new Date().toISOString(),
  };
  const env = { ...(options.env ?? process.env) };
  delete env.CLAUDECODE;
  try {
    const executable = await executablePath(options.executable ?? binary, options, env);
    if (!executable) return { ...base, reason: 'not-installed' };
    base.installed = true;
    base.executable = executable;
    env.PATH = `${dirname(executable)}${delimiter}${env.PATH ?? ''}`;
    const context = { cwd: options.cwd, executable, env };
    let version;
    try {
      version = accountString((await accountCommand(executable, ['--version'], context)).trim());
    } catch {
      throw new AccountProbeError('version-unavailable');
    }
    if (!version) throw new AccountProbeError('version-unavailable');
    base.version = version;
    return { ...base, ...(await probe(context)), observedAt: new Date().toISOString() };
  } catch (error) {
    return {
      ...base,
      ...unavailableAccount(),
      reason: error instanceof AccountProbeError ? error.reason : 'status-unavailable',
      observedAt: new Date().toISOString(),
    };
  }
}

/** Cleanup failure overrides a status result, so a leaked probe never appears ready. */
export async function accountProtocolProbe(
  process: { close(): Promise<void> },
  probe: () => Promise<NativeAccountState>,
  stopped: () => boolean,
): Promise<NativeAccountState> {
  let result: NativeAccountState | undefined;
  let failure: unknown;
  try {
    result = await probe();
  } catch (error) {
    failure = error;
  }
  try {
    await process.close();
  } catch {
    throw new AccountProbeError('cleanup-unconfirmed');
  }
  if (!stopped()) throw new AccountProbeError('cleanup-unconfirmed');
  if (failure) throw failure;
  if (!result) throw new AccountProbeError('status-unavailable');
  return result;
}

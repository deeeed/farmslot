import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  accountId,
  accountJsonCommand,
  accountObject,
  accountString,
  observeNativeAccount,
  signedOutAccount,
  unavailableAccount,
} from './account-common.js';
import type { NativeAccountProbeOptions, NativeAccountState } from './account-types.js';

export function cursorProfileEnvironment(
  directory: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const defaultHome = base.HOME || homedir();
  const canonicalDefault = existsSync(defaultHome)
    ? realpathSync(defaultHome)
    : resolve(defaultHome);
  // The normal home must retain the runner's native credential backend.
  if (directory === canonicalDefault) return {};
  return {
    HOME: directory,
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    GIT_CONFIG_GLOBAL: base.GIT_CONFIG_GLOBAL ?? join(defaultHome, '.gitconfig'),
  };
}

export function cursorAccountState(value: unknown): NativeAccountState {
  const status = accountObject(value);
  if (status.isAuthenticated === false) return signedOutAccount();
  if (status.isAuthenticated !== true)
    return { ...unavailableAccount(), reason: 'malformed-status' };
  const user =
    status.userInfo === undefined || status.userInfo === null ? {} : accountObject(status.userInfo);
  const subjectId = accountId(user.userId);
  const organizationId = accountId(user.teamId);
  const email = accountString(user.email);
  return {
    login: 'authenticated',
    // The status command exposes login identity, not an effective billing/auth mode.
    mode: 'unknown',
    ...(subjectId || email || organizationId
      ? {
          identity: {
            ...(subjectId ? { subjectId } : {}),
            ...(email ? { email } : {}),
            ...(organizationId ? { organizationId } : {}),
          },
        }
      : {}),
    identityQuality: subjectId ? 'stable-subject' : email ? 'display-only' : 'unavailable',
  };
}
export function observeCursorAccount(options: NativeAccountProbeOptions) {
  return observeNativeAccount('cursor', 'cursor-agent', options, async (context) =>
    cursorAccountState(
      await accountJsonCommand(context.executable, ['status', '--format', 'json'], context),
    ),
  );
}

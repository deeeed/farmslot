import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  accountJsonCommand,
  accountObject,
  accountString,
  observeNativeAccount,
  signedOutAccount,
  unavailableAccount,
} from './account-common.js';
import type { NativeAccountProbeOptions, NativeAccountState } from './account-types.js';

export function claudeProfileEnvironment(
  directory: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const defaultDirectory = join(base.HOME || homedir(), '.claude');
  const canonicalDefault = existsSync(defaultDirectory)
    ? realpathSync(defaultDirectory)
    : resolve(defaultDirectory);
  // Either override selects a different native credential store, even for ~/.claude.
  if (directory === canonicalDefault) return {};
  return { CLAUDE_CONFIG_DIR: directory, CLAUDE_SECURESTORAGE_CONFIG_DIR: directory };
}

export function claudeAccountState(value: unknown): NativeAccountState {
  const status = accountObject(value);
  if (status.loggedIn === false) return signedOutAccount();
  if (status.loggedIn !== true) return { ...unavailableAccount(), reason: 'malformed-status' };
  const email = accountString(status.email);
  const organizationId = accountString(status.orgId);
  const mode =
    status.authMethod === 'claude.ai'
      ? 'subscription'
      : status.authMethod === 'api_key'
        ? 'api'
        : ['bedrock', 'vertex', 'foundry'].includes(String(status.apiProvider))
          ? 'other'
          : 'unknown';
  return {
    login: 'authenticated',
    mode,
    ...(email || organizationId
      ? { identity: { ...(email ? { email } : {}), ...(organizationId ? { organizationId } : {}) } }
      : {}),
    identityQuality: email ? 'display-only' : 'unavailable',
  };
}
export function observeClaudeAccount(options: NativeAccountProbeOptions) {
  return observeNativeAccount('claude', 'claude', options, async (context) =>
    claudeAccountState(
      await accountJsonCommand(context.executable, ['auth', 'status', '--json'], context),
    ),
  );
}

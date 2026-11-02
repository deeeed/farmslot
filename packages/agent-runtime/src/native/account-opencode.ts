import { observeAcpAccount } from './account-common.js';
import type { NativeAccountProbeOptions } from './account-types.js';

/** OpenCode keeps its logins and sessions under `$XDG_DATA_HOME/opencode`. */
export const opencodeProfileEnvironment = (directory: string): Record<string, string> => ({
  XDG_DATA_HOME: directory,
});

/**
 * OpenCode signs in per provider and has no account status command. Its ACP `authenticate`
 * succeeds unconditionally, so this proves only that OpenCode's ACP server starts; OpenCode's
 * own free models need no sign-in, so it reads as signed in.
 */
export function observeOpenCodeAccount(options: NativeAccountProbeOptions) {
  return observeAcpAccount('opencode', 'opencode', options, {
    args: ['acp'],
    env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
    authMethod: 'opencode-login',
    state: () => ({ login: 'authenticated', mode: 'unknown', identityQuality: 'unavailable' }),
  });
}

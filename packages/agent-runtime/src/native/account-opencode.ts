import { accountCommand, observeNativeAccount } from './account-common.js';
import type { NativeAccountProbeOptions, NativeAccountState } from './account-types.js';

/** OpenCode keeps its logins and sessions under `$XDG_DATA_HOME/opencode`. */
export const opencodeProfileEnvironment = (directory: string): Record<string, string> => ({
  XDG_DATA_HOME: directory,
});

/**
 * OpenCode signs in per provider and has no account status command. A model it can use
 * proves a login; OpenCode's own free models need none.
 */
export function opencodeAccountState(listing: string): NativeAccountState {
  return listing.split('\n').some((line) => /^\S+\/\S+$/.test(line.trim()))
    ? { login: 'authenticated', mode: 'unknown', identityQuality: 'unavailable' }
    : { login: 'signed-out', mode: 'unknown', identityQuality: 'unavailable' };
}
export function observeOpenCodeAccount(options: NativeAccountProbeOptions) {
  return observeNativeAccount('opencode', 'opencode', options, async (context) =>
    opencodeAccountState(await accountCommand(context.executable, ['models'], context)),
  );
}

import { accountCommand, AccountProbeError, observeNativeAccount } from './account-common.js';
import type { NativeAccountProbeOptions, NativeAccountState } from './account-types.js';

/** Pi keeps logins, models and settings in its agent directory. */
export const piProfileEnvironment = (directory: string): Record<string, string> => ({
  PI_CODING_AGENT_DIR: directory,
});

/**
 * Pi signs in per provider and has no account status command. A model it can use proves
 * a login; Pi reports none when no provider is signed in.
 */
export function piAccountState(listing: string): NativeAccountState {
  const lines = listing.split('\n').filter((line) => line.trim());
  if (lines[0]?.startsWith('No models available'))
    return { login: 'signed-out', mode: 'unknown', identityQuality: 'unavailable' };
  if (!/^provider\s+model\b/.test(lines[0] ?? '') || lines.length < 2)
    throw new AccountProbeError('malformed-status');
  return { login: 'authenticated', mode: 'unknown', identityQuality: 'unavailable' };
}
export function observePiAccount(options: NativeAccountProbeOptions) {
  return observeNativeAccount('pi', 'pi', options, async (context) =>
    piAccountState(await accountCommand(context.executable, ['--list-models'], context)),
  );
}

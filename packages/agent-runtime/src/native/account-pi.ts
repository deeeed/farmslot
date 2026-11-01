import {
  accountObject,
  AccountProbeError,
  accountProtocolProbe,
  observeNativeAccount,
  signedOutAccount,
} from './account-common.js';
import type { NativeAccountProbeOptions, NativeAccountState } from './account-types.js';
import { PiRpc } from './pi-rpc.js';

/** Pi keeps logins, models and settings in its agent directory. */
export const piProfileEnvironment = (directory: string): Record<string, string> => ({
  PI_CODING_AGENT_DIR: directory,
});

/**
 * Pi signs in per provider and has no account status command. Its RPC model list holds only
 * models it holds credentials for, so any model proves a login.
 */
export function piAccountState(data: unknown): NativeAccountState {
  const models = accountObject(data).models;
  if (!Array.isArray(models)) throw new AccountProbeError('malformed-status');
  return models.length
    ? { login: 'authenticated', mode: 'unknown', identityQuality: 'unavailable' }
    : signedOutAccount();
}
export function observePiAccount(options: NativeAccountProbeOptions) {
  return observeNativeAccount('pi', 'pi', options, async (context) => {
    let exited = false;
    let cleanupConfirmed = false;
    const child = new PiRpc(
      context,
      ['--mode', 'rpc', '--no-session', '--no-extensions'],
      () => undefined,
      (_error, stopped) => {
        exited = true;
        cleanupConfirmed = stopped;
      },
    );
    return accountProtocolProbe(
      child,
      async () => piAccountState(await child.request({ type: 'get_available_models' }, 15_000)),
      () => exited && cleanupConfirmed,
    );
  });
}

import {
  accountObject,
  AccountProbeError,
  accountProtocolProbe,
  observeNativeAccount,
  signedOutAccount,
} from './account-common.js';
import type { NativeAccountProbeOptions, NativeAccountState } from './account-types.js';
import { JsonLineProcess } from './process.js';

/** Pi keeps logins, models and settings in its agent directory. */
export const piProfileEnvironment = (directory: string): Record<string, string> => ({
  PI_CODING_AGENT_DIR: directory,
});

/**
 * Pi signs in per provider and has no account status command. Its RPC model list holds only
 * models it holds credentials for, so any model proves a login.
 */
export function piAccountState(response: unknown): NativeAccountState {
  const record = accountObject(response);
  const models = record.success === true ? accountObject(record.data).models : undefined;
  if (!Array.isArray(models)) throw new AccountProbeError('malformed-status');
  return models.length
    ? { login: 'authenticated', mode: 'unknown', identityQuality: 'unavailable' }
    : signedOutAccount();
}
export function observePiAccount(options: NativeAccountProbeOptions) {
  return observeNativeAccount('pi', 'pi', options, async (context) => {
    let exited = false;
    let cleanupConfirmed = false;
    let listed!: (response: unknown) => void;
    const response = new Promise<unknown>((resolve) => (listed = resolve));
    const child = new JsonLineProcess(
      context.executable,
      ['--mode', 'rpc', '--no-session', '--no-extensions'],
      context,
      (message) => {
        if (message.type === 'response' && message.id === 'account-models') listed(message);
      },
      (_error, stopped) => {
        exited = true;
        cleanupConfirmed = stopped;
      },
    );
    return accountProtocolProbe(
      child,
      async () => {
        child.write({ id: 'account-models', type: 'get_available_models' });
        let timer: NodeJS.Timeout | undefined;
        try {
          return piAccountState(
            await Promise.race([
              response,
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new AccountProbeError('status-unavailable')),
                  15_000,
                );
              }),
            ]),
          );
        } finally {
          clearTimeout(timer);
        }
      },
      () => exited && cleanupConfirmed,
    );
  });
}

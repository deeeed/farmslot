import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  accountObject,
  AccountProbeError,
  accountProtocolProbe,
  observeNativeAccount,
  signedOutAccount,
} from './account-common.js';
import type { NativeAccountProbeOptions } from './account-types.js';
import { acpRunsToolsUnasked, createAcpAdapter } from './acp.js';
import {
  acpConfigChoices,
  type AcpObject,
  acpObject,
  type AcpRequest,
  AcpRpc,
  AcpRpcError,
  setAcpConfigOption,
} from './acp-rpc.js';

const ACP_AUTH_REQUIRED_CODE = -32000;

export function antigravityBinary(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.FARMSLOT_AGY_EXECUTABLE || 'agy';
}

export function antigravityProfileEnvironment(
  directory: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const defaultHome = base.HOME || homedir();
  const canonicalDefault = existsSync(defaultHome)
    ? realpathSync(defaultHome)
    : resolve(defaultHome);
  if (directory === canonicalDefault) return {};
  return {
    HOME: directory,
    GIT_CONFIG_GLOBAL: base.GIT_CONFIG_GLOBAL ?? join(defaultHome, '.gitconfig'),
  };
}

function advertisedAntigravityModelIds(session: AcpObject): string[] {
  const models =
    session.models && typeof session.models === 'object' && !Array.isArray(session.models)
      ? (session.models as AcpObject)
      : undefined;
  const available = Array.isArray(models?.availableModels) ? models.availableModels : [];
  const ids: string[] = [];
  for (const entry of available) {
    const model = acpObject(entry);
    if (typeof model.modelId === 'string' && model.modelId.trim()) {
      ids.push(model.modelId);
    }
  }
  return ids;
}

/**
 * Antigravity advertises concrete model+thinking IDs in `session.models.availableModels`
 * (matching `agy models`) and model families + `thought_level` in `configOptions`.
 * Setting `configId: "model"` with a concrete ID selects both family and thinking level
 * and confirms both in the returned `configOptions`. Never silently falls back to default.
 */
export async function configureAntigravityModel(
  sessionId: string,
  session: AcpObject,
  requested: string,
  request: AcpRequest,
): Promise<string> {
  const availableModelIds = advertisedAntigravityModelIds(session);
  const familyIds = acpConfigChoices(session, 'model') ?? [];
  if (!availableModelIds.length && !familyIds.length) {
    throw new Error('Antigravity did not advertise available models for this account');
  }
  if (!availableModelIds.includes(requested) && !familyIds.includes(requested)) {
    throw new Error(
      `Antigravity model ${JSON.stringify(requested)} is not available for the selected account`,
    );
  }
  const configOptions = await setAcpConfigOption(
    request,
    sessionId,
    'model',
    requested,
    'Antigravity',
  );
  const modelOption = configOptions.find((entry) => entry.id === 'model');
  const thoughtOption = configOptions.find((entry) => entry.id === 'thought_level');
  const confirmedModel =
    typeof modelOption?.currentValue === 'string' ? modelOption.currentValue : undefined;
  const confirmedThought =
    typeof thoughtOption?.currentValue === 'string' ? thoughtOption.currentValue : undefined;
  const exactFamilyMatch = confirmedModel === requested;
  const combinedMatch =
    confirmedModel !== undefined &&
    confirmedThought !== undefined &&
    `${confirmedModel}-${confirmedThought}` === requested;
  if (!exactFamilyMatch && !combinedMatch) {
    throw new Error(
      `Antigravity did not confirm model ${JSON.stringify(requested)} (reported model=${JSON.stringify(confirmedModel ?? null)}, thought_level=${JSON.stringify(confirmedThought ?? null)})`,
    );
  }
  return requested;
}

export const antigravityNativeAdapter = createAcpAdapter({
  configureModel: configureAntigravityModel,
  defaultModeId: 'default',
  modes: ['default', 'plan'],
  args(options) {
    if (options.effort && options.effort !== 'auto') {
      throw new Error('Antigravity effort must be selected through the model ID');
    }
    const addDirs = options.filesystemPolicy
      ? options.filesystemPolicy.writableRoots.flatMap((root) => ['--add-dir', root])
      : [];
    const autonomousWorker = options.approvalMode === undefined && acpRunsToolsUnasked(options);
    const useSandbox =
      Boolean(options.filesystemPolicy) ||
      (autonomousWorker && (Boolean(options.processSandbox) || options.safetyTier === 'full-auto'));
    return [
      'acp',
      ...addDirs,
      ...(useSandbox ? ['--sandbox'] : []),
      ...(autonomousWorker ? ['--dangerously-skip-permissions'] : []),
    ];
  },
});

/**
 * Structured Antigravity account check over ACP `initialize` + read-only `session/list`.
 * Never opens a new conversation or parses CLI text.
 */
export function observeAntigravityAccount(options: NativeAccountProbeOptions) {
  return observeNativeAccount(
    'antigravity',
    antigravityBinary(options.env),
    options,
    async (context) => {
      let exited = false;
      let cleanupConfirmed = false;
      const child = new AcpRpc(
        context,
        ['acp'],
        (message) => {
          if (message.id !== undefined && message.method) {
            child.write({
              id: message.id,
              error: {
                code: -32601,
                message: 'Account observation does not implement client operations',
              },
            });
          }
        },
        (_error, stopped) => {
          exited = true;
          cleanupConfirmed = stopped;
        },
      );
      return accountProtocolProbe(
        child,
        async () => {
          const init = accountObject(
            await child.request('initialize', {
              protocolVersion: 1,
              clientCapabilities: {},
              clientInfo: { name: 'farmslot-account-status', version: '1' },
            }),
          );
          if (init.protocolVersion !== 1) throw new AccountProbeError('malformed-status');
          try {
            const listed = accountObject(await child.request('session/list', { cwd: context.cwd }));
            if (!Array.isArray(listed.sessions)) throw new AccountProbeError('malformed-status');
            return {
              login: 'authenticated',
              mode: 'unknown',
              identityQuality: 'unavailable',
            };
          } catch (error) {
            if (error instanceof AcpRpcError && error.code === ACP_AUTH_REQUIRED_CODE) {
              return signedOutAccount();
            }
            if (error instanceof AccountProbeError) throw error;
            throw new AccountProbeError('status-unavailable');
          }
        },
        () => exited && cleanupConfirmed,
      );
    },
  );
}

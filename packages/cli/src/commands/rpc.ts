import { once } from 'node:events';

import type { Command } from 'commander';

import {
  type EventFrame,
  Methods,
  RUN_REFRESH_PUBLISH_PACKAGE_TIMEOUT_MS,
} from '@farmslot/protocol';

import { resolveContext } from '../context.js';

import { followNativeSession } from './native-session-follow.js';

const RESOURCE_CONTROL_BOOT_RPC_TIMEOUT_MS = 150_000;
export const RUNTIME_CAPABILITY_ACQUIRE_RPC_TIMEOUT_MS = 420_000;

/** The least time a call waits for its reply, for calls that can outlast the default. */
function minimumRpcTimeoutMs(method: string, params: unknown): number | undefined {
  // The gateway may wait for a busy worker before refreshing.
  if (method === Methods.RUN_REFRESH_PUBLISH_PACKAGE) return RUN_REFRESH_PUBLISH_PACKAGE_TIMEOUT_MS;
  if (method === Methods.RUNTIME_CAPABILITY_ACQUIRE)
    return RUNTIME_CAPABILITY_ACQUIRE_RPC_TIMEOUT_MS;
  if (
    method === Methods.RESOURCE_CONTROL &&
    typeof params === 'object' &&
    params !== null &&
    'action' in params &&
    params.action === 'boot'
  )
    return RESOURCE_CONTROL_BOOT_RPC_TIMEOUT_MS;
  return undefined;
}

export function resolveRpcGatewayTimeoutMs(
  method: string,
  params: unknown,
  globalTimeout: unknown,
): number | undefined {
  const minimum = minimumRpcTimeoutMs(method, params);
  return minimum === undefined ? undefined : Math.max(Number(globalTimeout) || 0, minimum);
}

export function registerRpcCommand(program: Command): void {
  program
    .command('rpc')
    .description('Raw gateway RPC call')
    .argument('<method>', 'RPC method name')
    .argument('[params]', 'JSON params')
    .option('--follow', 'Follow native.session.subscribe as NDJSON until Ctrl-C')
    .option('--stream', 'Show streaming events on stderr')
    .action(async (method: string, paramsStr: string | undefined, opts: any, cmd: Command) => {
      let params: unknown = {};
      if (paramsStr) {
        try {
          params = JSON.parse(paramsStr);
        } catch {
          process.stderr.write(`Invalid JSON params: ${paramsStr}\n`);
          process.exit(1);
        }
      }

      const { client } = resolveContext(cmd, {
        timeout: resolveRpcGatewayTimeoutMs(method, params, cmd.optsWithGlobals().timeout),
      });

      if (opts.follow) {
        if (
          method !== Methods.NATIVE_SESSION_SUBSCRIBE ||
          !params ||
          typeof params !== 'object' ||
          !('sessionId' in params) ||
          typeof params.sessionId !== 'string'
        )
          throw new Error('--follow requires native.session.subscribe and a sessionId');
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        try {
          await followNativeSession(client, params, controller.signal, async (frame, signal) => {
            if (!process.stdout.write(JSON.stringify(frame) + '\n'))
              await once(process.stdout, 'drain', { signal });
          });
        } finally {
          process.removeListener('SIGINT', stop);
          process.removeListener('SIGTERM', stop);
        }
        return;
      }

      const onEvent = opts.stream
        ? (event: EventFrame) => {
            const payload = event.payload as any;
            if (payload?.data) {
              process.stderr.write(payload.data);
            }
          }
        : undefined;

      try {
        const result = await client.callWithEvents(method, params, onEvent);
        process.stdout.write(JSON.stringify(result) + '\n');
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
        process.exit(1);
      }
    });
}

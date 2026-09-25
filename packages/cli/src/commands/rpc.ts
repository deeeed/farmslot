import type { Command } from 'commander';

import { type EventFrame, Methods } from '@farmslot/protocol';

import { resolveContext } from '../context.js';

const RESOURCE_CONTROL_BOOT_RPC_TIMEOUT_MS = 150_000;
export const RUNTIME_CAPABILITY_ACQUIRE_RPC_TIMEOUT_MS = 300_000;

export function resolveRpcGatewayTimeoutMs(
  method: string,
  params: unknown,
  globalTimeout: unknown,
): number | undefined {
  if (
    method !== Methods.RUNTIME_CAPABILITY_ACQUIRE &&
    !(
      method === Methods.RESOURCE_CONTROL &&
      typeof params === 'object' &&
      params !== null &&
      'action' in params &&
      params.action === 'boot'
    )
  ) {
    return undefined;
  }
  return Math.max(
    Number(globalTimeout) || 0,
    method === Methods.RESOURCE_CONTROL
      ? RESOURCE_CONTROL_BOOT_RPC_TIMEOUT_MS
      : RUNTIME_CAPABILITY_ACQUIRE_RPC_TIMEOUT_MS,
  );
}

export function registerRpcCommand(program: Command): void {
  program
    .command('rpc')
    .description('Raw gateway RPC call')
    .argument('<method>', 'RPC method name')
    .argument('[params]', 'JSON params')
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

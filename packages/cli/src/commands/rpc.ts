import type { Command } from 'commander';

import type { EventFrame } from '@farmslot/protocol';

import { resolveContext } from '../context.js';

export function registerRpcCommand(program: Command): void {
  program
    .command('rpc')
    .description('Raw gateway RPC call')
    .argument('<method>', 'RPC method name')
    .argument('[params]', 'JSON params')
    .option('--stream', 'Show streaming events on stderr')
    .action(async (method: string, paramsStr: string | undefined, opts: any, cmd: Command) => {
      const { client } = resolveContext(cmd);

      let params: unknown = {};
      if (paramsStr) {
        try {
          params = JSON.parse(paramsStr);
        } catch {
          process.stderr.write(`Invalid JSON params: ${paramsStr}\n`);
          process.exit(1);
        }
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

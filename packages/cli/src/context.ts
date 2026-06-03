import type { Command } from 'commander';

import { GatewayClient } from './gateway-client.js';
import { OutputContext } from './output.js';

interface ResolveContextOptions {
  timeout?: number;
}

export function resolveContext(cmd: Command, options: ResolveContextOptions = {}) {
  const opts = cmd.optsWithGlobals();
  return {
    client: new GatewayClient({ url: opts.url, timeout: options.timeout ?? Number(opts.timeout) }),
    output: new OutputContext(opts.json ?? false),
  };
}

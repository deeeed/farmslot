import type { Command } from 'commander';

import { GatewayClient } from './gateway-client.js';
import { type GatewayTarget, resolveGatewayTarget } from './gateway-profiles.js';
import { OutputContext } from './output.js';

interface ResolveContextOptions {
  timeout?: number;
}

export interface CommandContext {
  client: GatewayClient;
  output: OutputContext;
  /** Which gateway this invocation targets (profile resolution, ADR-036). */
  target: GatewayTarget;
}

export function resolveContext(cmd: Command, options: ResolveContextOptions = {}): CommandContext {
  const opts = cmd.optsWithGlobals();
  const output = new OutputContext(opts.json ?? false);
  let target: GatewayTarget;
  try {
    target = resolveGatewayTarget({ url: opts.url, gateway: opts.gateway });
  } catch (err) {
    // Unknown --gateway etc. must print like every other CLI failure, not as a
    // raw stack trace out of commander's action wrapper.
    output.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  return {
    client: new GatewayClient({
      url: target.url,
      timeout: options.timeout ?? Number(opts.timeout),
      credential: target.credential,
    }),
    output,
    target,
  };
}

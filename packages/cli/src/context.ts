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
    // Unknown --gateway etc. must fail like every other CLI error: enrich and
    // rethrow so the action's emitter (or the entry-level fallback) prints one
    // envelope / teach-the-escape line — never print-and-exit here, which can
    // truncate stdout and double-report.
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      code: 'GATEWAY_PROFILE_ERROR',
      userAction:
        'List gateway profiles with `farmslot gateway list`, or pass an explicit --url. Diagnose with `farmslot doctor`.',
    });
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

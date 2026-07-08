// gateway-tls.ts — CLI-side view of the gateway's optional TLS (wss://) support.
//
// `farmslot certs setup` provisions a locally-trusted cert here and `farmslot up`
// reads it to (a) pass the TLS env vars to the gateway it spawns and (b) emit a
// wss:// candidate first in the hosted Command Center connect payload. The gateway
// itself only consumes the FARMSLOT_GATEWAY_TLS_* env vars (see
// services/gateway/src/core/gateway-tls.ts); the default-path convention lives
// here because both cert provisioning and the connect payload are CLI concerns.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

/** Must match services/gateway DEFAULT_GATEWAY_TLS_PORT. */
export const DEFAULT_GATEWAY_TLS_PORT = 7778;

export function gatewayCertsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(farmslotHome(env), 'certs');
}

export function defaultGatewayCertPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(gatewayCertsDir(env), 'farmslot-local.pem');
}

export function defaultGatewayKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(gatewayCertsDir(env), 'farmslot-local-key.pem');
}

export interface ResolvedGatewayTls {
  certPath: string;
  keyPath: string;
  port: number;
}

/**
 * Resolve the TLS material `farmslot up` should hand the gateway, or null when
 * TLS is not set up. Priority: explicit FARMSLOT_GATEWAY_TLS_CERT/KEY env (when
 * both point at existing files) → the default `certs setup` output (when both
 * exist) → null (ws:// only).
 */
export function resolveGatewayTls(env: NodeJS.ProcessEnv = process.env): ResolvedGatewayTls | null {
  const port = Number(env.FARMSLOT_GATEWAY_TLS_PORT?.trim()) || DEFAULT_GATEWAY_TLS_PORT;

  const envCert = env.FARMSLOT_GATEWAY_TLS_CERT?.trim();
  const envKey = env.FARMSLOT_GATEWAY_TLS_KEY?.trim();
  if (envCert && envKey && existsSync(envCert) && existsSync(envKey)) {
    return { certPath: envCert, keyPath: envKey, port };
  }

  const certPath = defaultGatewayCertPath(env);
  const keyPath = defaultGatewayKeyPath(env);
  if (existsSync(certPath) && existsSync(keyPath)) {
    return { certPath, keyPath, port };
  }

  return null;
}

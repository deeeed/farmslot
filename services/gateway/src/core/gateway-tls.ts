// gateway-tls.ts — optional TLS for the gateway so the same daemon can serve
// wss:// (in addition to plaintext ws://). A hosted HTTPS Command Center
// (https://farmslot.io/cc) cannot open a ws:// socket to a local gateway —
// Chrome 150 blocks it as mixed content and the per-site "Insecure content"
// setting does not override it — but wss:// is not mixed content, so a
// locally-trusted TLS websocket restores the hosted-CC → local-gateway path.
//
// TLS is env-driven and purely additive: with no cert configured the gateway
// behaves exactly as before (ws:// only). `farmslot certs setup` provisions a
// locally-trusted cert (mkcert) and `farmslot up` wires these env vars.

import { readFileSync } from 'node:fs';

/** Default TLS listen port. Separate from the plaintext port (7777) because a
 * single TCP port cannot serve both plaintext ws:// and TLS wss:// at once, and
 * the loopback ecosystem (local node, health probes, local UI) stays on ws://. */
export const DEFAULT_GATEWAY_TLS_PORT = 7778;

export interface GatewayTlsConfig {
  certPath: string;
  keyPath: string;
  port: number;
}

export interface GatewayTlsMaterial {
  cert: Buffer;
  key: Buffer;
  certPath: string;
  keyPath: string;
  port: number;
}

/**
 * Parse TLS config from env without touching the filesystem (pure — unit-testable).
 * Returns null when TLS is disabled (neither cert nor key set). Throws a teaching
 * error when the config is half-set, since that is always an operator mistake.
 */
export function parseGatewayTlsConfig(env: NodeJS.ProcessEnv): GatewayTlsConfig | null {
  const certPath = env.FARMSLOT_GATEWAY_TLS_CERT?.trim();
  const keyPath = env.FARMSLOT_GATEWAY_TLS_KEY?.trim();

  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    const missing = certPath ? 'FARMSLOT_GATEWAY_TLS_KEY' : 'FARMSLOT_GATEWAY_TLS_CERT';
    throw new Error(
      `Gateway TLS is half-configured — ${missing} is not set. ` +
        'Next: set both FARMSLOT_GATEWAY_TLS_CERT and FARMSLOT_GATEWAY_TLS_KEY (or run `farmslot certs setup`), then restart the gateway.',
    );
  }

  const rawPort = env.FARMSLOT_GATEWAY_TLS_PORT?.trim();
  const port = rawPort ? Number(rawPort) : DEFAULT_GATEWAY_TLS_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Gateway TLS port is invalid: "${rawPort}". ` +
        'Next: set FARMSLOT_GATEWAY_TLS_PORT to a number between 1 and 65535, or unset it to use the default 7778.',
    );
  }

  return { certPath, keyPath, port };
}

/**
 * Resolve TLS material (reads cert + key from disk). Returns null when TLS is
 * disabled. Throws a teaching error when configured paths cannot be read so the
 * operator learns the exact escape instead of getting a raw ENOENT.
 */
export function loadGatewayTlsMaterial(
  env: NodeJS.ProcessEnv = process.env,
): GatewayTlsMaterial | null {
  const config = parseGatewayTlsConfig(env);
  if (!config) return null;

  let cert: Buffer;
  let key: Buffer;
  try {
    cert = readFileSync(config.certPath);
  } catch (err) {
    throw new Error(
      `Gateway TLS cert not readable at ${config.certPath}: ${(err as Error).message}. ` +
        'Next: run `farmslot certs setup` to provision it, or point FARMSLOT_GATEWAY_TLS_CERT at an existing PEM.',
    );
  }
  try {
    key = readFileSync(config.keyPath);
  } catch (err) {
    throw new Error(
      `Gateway TLS key not readable at ${config.keyPath}: ${(err as Error).message}. ` +
        'Next: run `farmslot certs setup` to provision it, or point FARMSLOT_GATEWAY_TLS_KEY at an existing PEM.',
    );
  }

  return { cert, key, certPath: config.certPath, keyPath: config.keyPath, port: config.port };
}

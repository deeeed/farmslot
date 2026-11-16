import type { IncomingMessage, ServerResponse } from 'node:http';

import { explicitDevHosts } from '@farmslot/protocol/explicit-dev-host';

const EXTRA_ORIGINS_ENV = 'FARMSLOT_GATEWAY_ALLOWED_ORIGINS';
const UI_ALLOWED_HOSTS_ENV = 'FARMSLOT_UI_ALLOWED_HOSTS';
const UI_PORT_ENV = 'VITE_PORT';
const HOSTED_ORIGINS = new Set(['https://farmslot.io', 'https://www.farmslot.io']);

export function isGatewayOriginAllowed(
  origin: string | undefined,
  hostHeader: string | undefined,
): boolean {
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    // Malformed Origin headers are not browser-valid, so fail closed.
    return false;
  }
  if (HOSTED_ORIGINS.has(parsed.origin)) return true;
  if (isLocalDevOrigin(parsed)) return true;
  if (hostHeader && parsed.host === hostHeader) return true;
  return configuredOrigins().has(parsed.origin);
}

export function applyGatewayCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!isGatewayOriginAllowed(origin, req.headers.host)) return false;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  return true;
}

function isLocalDevOrigin(origin: URL): boolean {
  const host = origin.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  if (host.startsWith('127.')) return true;
  return false;
}

function configuredOrigins(): Set<string> {
  return new Set([...splitCsv(process.env[EXTRA_ORIGINS_ENV]), ...devLanPageOrigins()]);
}

/** Dev page origins for hosts the operator already listed. Other ports and hosts stay out. */
function devLanPageOrigins(): string[] {
  // An installed gateway leaves NODE_ENV unset, so inherited UI hosts do not
  // open it. scripts/dev.sh sets development for the dev stack.
  if (process.env.NODE_ENV !== 'development') return [];
  const port = process.env[UI_PORT_ENV]?.trim() ?? '';
  if (!/^\d+$/.test(port)) return [];
  return explicitDevHosts(process.env[UI_ALLOWED_HOSTS_ENV]).map(
    (host) => `http://${host}:${port}`,
  );
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

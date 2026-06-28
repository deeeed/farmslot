import type { IncomingMessage, ServerResponse } from 'node:http';

const EXTRA_ORIGINS_ENV = 'FARMSLOT_GATEWAY_ALLOWED_ORIGINS';
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
  return new Set(
    (process.env[EXTRA_ORIGINS_ENV] ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

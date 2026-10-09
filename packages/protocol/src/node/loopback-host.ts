import net from 'node:net';

/**
 * True for a host only this machine can reach: `localhost`, `::1` (bracketed or
 * not) or any 127.x IPv4 address. Shared by the gateway's bind/auth checks and
 * the CLI's choice of which gateways may use secrets from local `.env` files.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost') return true;
  if (normalized === '::1' || normalized === '[::1]') return true;
  if (net.isIP(normalized) === 4) return normalized.startsWith('127.');
  return false;
}

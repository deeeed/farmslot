import net from 'node:net';

export interface GatewayListenSnapshot {
  host: string;
  port: number;
  remotePairingAllowed: boolean;
}

let listenSnapshot: GatewayListenSnapshot | null = null;

export function setGatewayListenAddress(host: string | undefined, port: number): void {
  const normalizedHost = normalizeListenHost(host);
  listenSnapshot = {
    host: normalizedHost,
    port,
    remotePairingAllowed: isRemoteGatewayListenAllowed(normalizedHost),
  };
}

export function getGatewayListenSnapshot(): GatewayListenSnapshot | null {
  return listenSnapshot;
}

export function normalizeListenHost(host: string | undefined): string {
  const trimmed = host?.trim();
  if (!trimmed) return '0.0.0.0';
  return trimmed;
}

export function isLoopbackGatewayHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost') return true;
  if (normalized === '::1' || normalized === '[::1]') return true;
  if (net.isIP(normalized) === 4) return normalized.startsWith('127.');
  return false;
}

/** True when the gateway accepts connections from non-loopback peers (LAN/Tailscale pairing). */
export function isRemoteGatewayListenAllowed(host: string): boolean {
  const normalized = normalizeListenHost(host);
  if (normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]') return true;
  return !isLoopbackGatewayHost(normalized);
}

export function remotePairingBlockedHint(host: string, port: number): string {
  return (
    `Gateway is listening on ${host}:${port} only — phones on your LAN cannot reach it. ` +
    'Restart with GATEWAY_HOST=0.0.0.0 (yarn farmdev does this when .env.local-auth is present) or run farmslot up.'
  );
}

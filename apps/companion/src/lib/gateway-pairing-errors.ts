function pairingUrlHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isLoopbackPairingHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized.startsWith('127.')
  );
}

/** Actionable pairing transport error when the phone cannot open a gateway WebSocket. */
export function pairingWebSocketConnectionError(url: string): Error {
  const host = pairingUrlHost(url);
  if (host && !isLoopbackPairingHost(host)) {
    return new Error(
      `Could not connect to ${url}. If you are pairing from another device, the gateway must listen on all interfaces (GATEWAY_HOST=0.0.0.0 or farmslot up), not localhost only.`,
    );
  }
  return new Error('Pairing WebSocket connection failed');
}

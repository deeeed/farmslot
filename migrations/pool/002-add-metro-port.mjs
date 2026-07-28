// Migration 002 — give every dev-server resource its own Metro port.
// Ports are allocated above the pool's existing highest port so user choices
// stay untouched and Metro can never alias the gateway port.
export const id = '002-add-metro-port';
export const toVersion = 2;
export const description = 'Allocate distinct Metro ports for legacy dev-server resources';

export function migrate(pool) {
  const used = new Set();
  for (const slot of pool.slots ?? []) {
    for (const resource of Object.values(slot.resources ?? {})) {
      for (const [key, value] of Object.entries(resource ?? {})) {
        if (/(^|_)port$/.test(key) && Number.isInteger(value)) used.add(value);
      }
    }
  }

  let nextPort = Math.max(0, ...used) + 1;
  for (const slot of pool.slots ?? []) {
    const devServer = slot.resources?.['dev-server'];
    if (!devServer || devServer.metro_port !== undefined) continue;
    while (used.has(nextPort)) nextPort += 1;
    if (nextPort > 65_535) {
      throw new Error(
        `Cannot allocate resources.dev-server.metro_port for slot ${slot.id}: no valid port remains above the pool's configured ports.`,
      );
    }
    devServer.metro_port = nextPort;
    used.add(nextPort);
    nextPort += 1;
  }
  return pool;
}

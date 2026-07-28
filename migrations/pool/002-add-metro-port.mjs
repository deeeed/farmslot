// Migration 002 — give every dev-server resource its own Metro port.
// Ports use the same high block as onboarding so migrations and new slots
// produce the same deterministic layout without privileged ports.
export const id = '002-add-metro-port';
export const toVersion = 2;
export const description = 'Allocate distinct Metro ports for legacy dev-server resources';
export const repairsInvariant = true;

const PORT_BLOCK_START = 9300;
const MAX_PORT = 65_535;

export function migrate(pool) {
  const used = new Set();
  for (const slot of pool.slots ?? []) {
    for (const resource of Object.values(slot.resources ?? {})) {
      for (const [key, value] of Object.entries(resource ?? {})) {
        if (/(^|_)port$/.test(key) && Number.isInteger(value) && value >= 1 && value <= MAX_PORT) {
          used.add(value);
        }
      }
    }
  }

  let nextPort = PORT_BLOCK_START;
  for (const slot of pool.slots ?? []) {
    const devServer = slot.resources?.['dev-server'];
    if (
      !devServer ||
      (Number.isInteger(devServer.metro_port) &&
        devServer.metro_port >= 1 &&
        devServer.metro_port <= MAX_PORT)
    ) {
      continue;
    }
    while (used.has(nextPort)) nextPort += 1;
    if (nextPort > MAX_PORT) {
      throw new Error(
        `Cannot allocate resources.dev-server.metro_port for slot ${slot.id}: no port remains in the canonical ${PORT_BLOCK_START}-${MAX_PORT} block.`,
      );
    }
    devServer.metro_port = nextPort;
    used.add(nextPort);
    nextPort += 1;
  }
  return pool;
}

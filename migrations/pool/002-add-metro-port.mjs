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
  const slots = pool.slots ?? [];
  for (const [slotIndex, slot] of slots.entries()) {
    const devServer = slot.resources?.['dev-server'];
    if (!devServer || isUsableMetroPort(slots, slot, slotIndex, devServer.metro_port)) continue;
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

function isUsableMetroPort(slots, slot, slotIndex, value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PORT) return false;
  for (const [candidateIndex, candidate] of slots.entries()) {
    for (const [resourceName, resource] of Object.entries(candidate.resources ?? {})) {
      for (const [key, candidateValue] of Object.entries(resource ?? {})) {
        if (candidateValue !== value) continue;
        const isCurrentMetro =
          candidate === slot && resourceName === 'dev-server' && key === 'metro_port';
        if (isCurrentMetro) continue;
        const isLaterMetro =
          candidateIndex > slotIndex && resourceName === 'dev-server' && key === 'metro_port';
        if (!isLaterMetro) return false;
      }
    }
  }
  return true;
}

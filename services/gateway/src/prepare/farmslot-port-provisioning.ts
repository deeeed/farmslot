// farmslot-port-provisioning.ts — materialize checkout-local .env.ports from
// pool-owned slot resources (MANUAL-000085).
//
// A sandbox slot opts in by declaring resources.dev-server.vite_port next to
// its gateway port. Prepare then guarantees .env.ports exists in the slot
// checkout with the pool values BEFORE the sandbox preflight, so a fresh
// checkout never fails on hand-created state. Slots without vite_port are
// untouched. Ports collide with the operator stack → prepare fails loudly.

export interface SandboxPorts {
  gatewayPort: number;
  vitePort: number;
}

export interface OperatorPorts {
  gatewayPort?: number;
  vitePort?: number;
}

function parsePort(raw: string | undefined, field: string, slotId: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      `Slot ${slotId}: resources.dev-server.${field} must be a port number 1-65535 (got "${raw ?? ''}")`,
    );
  }
  return value;
}

/**
 * Read the sandbox port pair from flattened slot resources. Returns null when
 * the slot does not declare vite_port (not opted in). Throws when vite_port is
 * declared but the pair is unusable — a half-configured slot must fail loudly,
 * not fall back.
 */
export function resolveSandboxPorts(
  resourceVars: Record<string, string>,
  slotId: string,
): SandboxPorts | null {
  const rawVite = resourceVars.vite_port?.trim();
  if (!rawVite) return null;
  const vitePort = parsePort(rawVite, 'vite_port', slotId);
  const gatewayPort = parsePort(resourceVars.port?.trim(), 'port', slotId);
  if (vitePort === gatewayPort) {
    throw new Error(
      `Slot ${slotId}: vite_port and port are both ${vitePort} — the sandbox UI and gateway cannot share a port`,
    );
  }
  return { gatewayPort, vitePort };
}

/** The operator stack's own ports, from the gateway process env (dev.sh
 * exports both). Absent values simply skip that side of the collision check. */
export function operatorPortsFromEnv(env: NodeJS.ProcessEnv = process.env): OperatorPorts {
  const parse = (raw: string | undefined) => {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };
  return {
    gatewayPort: parse(env.GATEWAY_PORT),
    vitePort: parse(env.VITE_PORT),
  };
}

/** Refuse slot ports that would reuse the operator gateway or operator UI —
 * a sandbox stack on those ports would fail to bind or, worse, register onto
 * the operator stack under the slot's identity. */
export function assertNoOperatorCollision(
  ports: SandboxPorts,
  operator: OperatorPorts,
  slotId: string,
): void {
  const taken = new Map<number, string>();
  if (operator.gatewayPort) taken.set(operator.gatewayPort, 'operator gateway');
  if (operator.vitePort) taken.set(operator.vitePort, 'operator UI');
  for (const [name, port] of [
    ['gateway port', ports.gatewayPort],
    ['vite port', ports.vitePort],
  ] as const) {
    const owner = taken.get(port);
    if (owner) {
      throw new Error(
        `Slot ${slotId}: sandbox ${name} ${port} collides with the ${owner} port — fix the pool allocation`,
      );
    }
  }
}

const GATEWAY_LINE_RE = /^GATEWAY_PORT=/;
const VITE_LINE_RE = /^VITE_PORT=/;

/**
 * Render .env.ports content: pool values win for GATEWAY_PORT and VITE_PORT,
 * every other existing line (comments, METRO_PORT, FARMSLOT_HOME, …) is kept.
 * A fresh file gets a header naming the slot so hand-editors know its owner.
 */
export function renderEnvPorts(
  existing: string | null,
  ports: SandboxPorts,
  slotId: string,
): string {
  const gatewayLine = `GATEWAY_PORT=${ports.gatewayPort}`;
  const viteLine = `VITE_PORT=${ports.vitePort}`;
  if (existing === null || existing.trim() === '') {
    return `# ${slotId} sandbox ports — provisioned from the pool by farmslot prepare\n${gatewayLine}\n${viteLine}\n`;
  }
  const lines = existing.replace(/\r\n?/g, '\n').split('\n');
  const kept = lines.filter((line) => !GATEWAY_LINE_RE.test(line) && !VITE_LINE_RE.test(line));
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop();
  return `${[...kept, gatewayLine, viteLine].join('\n')}\n`;
}

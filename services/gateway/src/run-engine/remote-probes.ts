// run-engine/remote-probes.ts — remote readiness probes used by run-engine prepare/recovery seams.

import { execFileArgv } from '../core/exec.js';
import { getNode } from '../fleet/machine-registry.js';
import { getSlotLocality, sendNodeRequest } from '../fleet/node-rpc.js';

const REMOTE_PATH_CRITICAL = ['tmux', 'lsof', 'node'] as const;

export async function probeRemotePath(
  slotId: string,
): Promise<{ ok: true } | { ok: false; missing: string[]; machine: string; detail?: string }> {
  let locality: Awaited<ReturnType<typeof getSlotLocality>>;
  try {
    locality = await getSlotLocality(slotId);
  } catch (err) {
    console.warn(
      `[run-engine] skipping remote PATH probe for ${slotId}: ${(err as Error).message.slice(0, 200)}`,
    );
    return { ok: true };
  }
  if (locality.isLocal) return { ok: true };
  const { machine, sshTarget } = locality;
  const cmd = REMOTE_PATH_CRITICAL.map(
    (b) => `printf '%s=%s\\n' '${b}' "$(command -v '${b}' 2>/dev/null || echo MISSING)"`,
  ).join('; ');
  let stdout = '';
  const node = getNode(machine);
  if (node) {
    try {
      const response = await sendNodeRequest(node, 'exec', { cmd, timeout: 5_000 });
      if (
        response &&
        typeof response === 'object' &&
        'stdout' in response &&
        typeof response.stdout === 'string'
      ) {
        stdout = response.stdout;
      }
    } catch (err) {
      console.warn(
        `[run-engine] remote PATH probe via node failed machine=${machine}: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }
  if (!stdout && sshTarget) {
    try {
      const r = await execFileArgv([
        'ssh',
        '-n',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=5',
        sshTarget,
        cmd,
      ]);
      stdout = r.stdout || '';
    } catch (err) {
      return {
        ok: false,
        missing: [...REMOTE_PATH_CRITICAL],
        machine,
        detail: `probe failed: ${(err as Error).message.slice(0, 200)}`,
      };
    }
  }
  if (!stdout) {
    return {
      ok: false,
      missing: [...REMOTE_PATH_CRITICAL],
      machine,
      detail: 'no output from remote probe (node offline + no ssh target)',
    };
  }
  const missing: string[] = [];
  for (const line of stdout.split('\n')) {
    const [bin, resolved] = line.split('=');
    if (!bin) continue;
    if (!resolved || resolved.trim() === 'MISSING') missing.push(bin.trim());
  }
  if (missing.length === 0) return { ok: true };
  return { ok: false, missing, machine };
}

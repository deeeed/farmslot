import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { WorkerCliHealth } from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

export async function readWorkerCliHealth(
  home = farmslotHome(),
): Promise<WorkerCliHealth | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(path.join(home, 'node-worker-cli-health.json'), 'utf8'),
    );
    if (
      !value ||
      typeof value !== 'object' ||
      !('ok' in value) ||
      typeof value.ok !== 'boolean' ||
      !('checkedAt' in value) ||
      typeof value.checkedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.checkedAt)) ||
      ('reason' in value && typeof value.reason !== 'string')
    ) {
      throw new Error('Invalid worker CLI verification receipt');
    }
    return {
      ok: value.ok,
      checkedAt: value.checkedAt,
      ...('reason' in value && typeof value.reason === 'string' ? { reason: value.reason } : {}),
    };
  } catch (error) {
    // A node without a completed deploy probe has no receipt yet.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      reason: 'Worker CLI verification receipt is unreadable or invalid',
    };
  }
}

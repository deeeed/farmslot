import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SourceLock, SourcesSyncParams, SourcesSyncResult } from '@farmslot/protocol';
import { sourceDigest } from '@farmslot/slot-config/sources';

export interface SourceSyncPlan {
  locks: SourceLock[];
  nodeIds: string[];
  errors?: SourcesSyncResult['errors'];
}

interface SyncOperation {
  schemaVersion: 1;
  requestDigest: string;
  plan: SourceSyncPlan;
  result?: SourcesSyncResult;
}

/** Persist a complete exact-input plan before the first node mutation. */
export class SourceSyncOperations {
  private pending = Promise.resolve();

  constructor(private readonly root: string) {}

  execute(
    params: SourcesSyncParams,
    prepare: () => Promise<SourceSyncPlan>,
    apply: (plan: SourceSyncPlan) => Promise<SourcesSyncResult>,
  ): Promise<SourcesSyncResult> {
    const work = this.pending.then(async () => {
      if (!params.operationId || params.operationId.length > 128)
        throw new Error('Invalid source operation identity');
      const file = path.join(this.root, `${sourceDigest(params.operationId)}.json`);
      const requestDigest = sourceDigest(params);
      let record: SyncOperation | undefined;
      try {
        record = JSON.parse(await readFile(file, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (record && (record.schemaVersion !== 1 || record.requestDigest !== requestDigest))
        throw new Error('Source operation identity was reused with a changed request');
      if (record?.result) return record.result;
      if (!record) {
        record = { schemaVersion: 1, requestDigest, plan: await prepare() };
        await this.persist(file, record);
      }
      // Lost acknowledgements repeat only exact-lock materialization. Node receipts
      // reconcile the same digest; branch movement cannot replace this saved plan.
      const result = await apply(record.plan);
      await this.persist(file, { ...record, result });
      return result;
    });
    this.pending = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  private async persist(file: string, value: SyncOperation): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { MachineParkRecord } from '@farmslot/protocol';

export type MachineParkingIntentKind = 'pause' | 'restore';

export interface MachineParkingIntentJournal {
  version: 1;
  kind: MachineParkingIntentKind;
  machine: string;
  operationId: string;
  records: MachineParkRecord[];
}

export interface MachineParkingJournalLoadResult {
  journals: MachineParkingIntentJournal[];
  quarantined: Array<{ file: string; reason: string; quarantineFile: string }>;
}

export class MachineParkingIntentJournalStore {
  private readonly directory: string;

  constructor(runsDirectory: string) {
    this.directory = path.join(runsDirectory, 'machine-parking-batches');
  }

  pathFor(machine: string, kind: MachineParkingIntentKind, operationId: string): string {
    const digest = createHash('sha256').update(`${machine}\0${kind}\0${operationId}`).digest('hex');
    return path.join(this.directory, `${digest}.json`);
  }

  async write(kind: MachineParkingIntentKind, records: MachineParkRecord[]): Promise<void> {
    const first = records[0];
    if (!first) throw new Error('machine parking intent journal requires records');
    if (
      records.some(
        (record) => record.machine !== first.machine || record.operationId !== first.operationId,
      )
    ) {
      throw new Error('machine parking intent journal records must share machine and operation id');
    }
    await mkdir(this.directory, { recursive: true });
    const target = this.pathFor(first.machine, kind, first.operationId);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const journal: MachineParkingIntentJournal = {
      version: 1,
      kind,
      machine: first.machine,
      operationId: first.operationId,
      records,
    };
    await writeFile(temp, JSON.stringify(journal, null, 2), 'utf8');
    await rename(temp, target);
  }

  async delete(
    machine: string,
    kind: MachineParkingIntentKind,
    operationId: string,
  ): Promise<void> {
    try {
      await unlink(this.pathFor(machine, kind, operationId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async load(): Promise<MachineParkingJournalLoadResult> {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { journals: [], quarantined: [] };
      }
      throw error;
    }
    const journals: MachineParkingIntentJournal[] = [];
    const quarantined: MachineParkingJournalLoadResult['quarantined'] = [];
    for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
      const source = path.join(this.directory, file);
      try {
        const parsed = JSON.parse(await readFile(source, 'utf8')) as MachineParkingIntentJournal;
        validateJournal(parsed);
        if (
          path.basename(source) !==
          path.basename(this.pathFor(parsed.machine, parsed.kind, parsed.operationId))
        ) {
          throw new Error('machine parking intent journal filename does not match identity');
        }
        journals.push(parsed);
      } catch (error) {
        const quarantineFile = `${source}.invalid-${randomUUID()}`;
        await rename(source, quarantineFile);
        quarantined.push({ file: source, reason: messageOf(error), quarantineFile });
      }
    }
    return { journals, quarantined };
  }
}

function validateJournal(value: MachineParkingIntentJournal): void {
  if (
    value?.version !== 1 ||
    (value.kind !== 'pause' && value.kind !== 'restore') ||
    typeof value.machine !== 'string' ||
    !value.machine ||
    typeof value.operationId !== 'string' ||
    !value.operationId ||
    !Array.isArray(value.records) ||
    value.records.length === 0 ||
    value.records.some(
      (record) =>
        record.machine !== value.machine ||
        record.operationId !== value.operationId ||
        !validRecord(record),
    )
  ) {
    throw new Error('invalid machine parking intent journal');
  }
}

function validRecord(record: MachineParkRecord): boolean {
  const handle = record.recoveryHandle;
  return (
    record?.version === 1 &&
    typeof record.runId === 'string' &&
    Boolean(record.runId) &&
    Number.isInteger(record.generation) &&
    typeof record.slotId === 'string' &&
    Boolean(record.slotId) &&
    (record.mode === 'orchestration' || record.mode === 'release') &&
    typeof record.phase === 'string' &&
    typeof record.prePauseStatus === 'string' &&
    Array.isArray(record.errors) &&
    Array.isArray(record.resourceManifest?.resources) &&
    Array.isArray(record.resourceManifest?.capabilityLeases) &&
    typeof record.resourceManifest?.capturedAt === 'string' &&
    (handle === null ||
      (handle?.version === 1 &&
        typeof handle.runnerId === 'string' &&
        Boolean(handle.runnerId) &&
        typeof handle.contextId === 'string' &&
        Boolean(handle.contextId) &&
        typeof handle.sessionId === 'string' &&
        Boolean(handle.sessionId) &&
        typeof handle.sessionPath === 'string' &&
        Boolean(handle.sessionPath) &&
        typeof handle.target?.session === 'string' &&
        typeof handle.target?.target === 'string' &&
        typeof handle.target?.paneId === 'string' &&
        Boolean(handle.target.paneId))) &&
    (record.restoreDisposition === undefined ||
      record.restoreDisposition === 'zero-effect' ||
      record.restoreDisposition === 'effectful') &&
    (record.residuals?.runner === 'running' ||
      record.residuals?.runner === 'stopped' ||
      record.residuals?.runner === 'unknown') &&
    Array.isArray(record.residuals?.resources)
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

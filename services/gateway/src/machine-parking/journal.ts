import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { MachineParkRecord } from '@farmslot/protocol';

/**
 * `free-slot` is its own kind: the slot release and the `slotFreedAt` write
 * that records it are two writes, and a crash between them leaves the record
 * `parked` with the slot already handed to dispatch. Recovery cannot tell that
 * from a park that never freed anything, so the intent is journalled around
 * exactly that window.
 */
export type MachineParkingIntentKind = 'pause' | 'restore' | 'free-slot';

export interface MachineParkingIntentJournal {
  version: 1;
  kind: MachineParkingIntentKind;
  machine: string;
  operationId: string;
  /**
   * Narrows a journal's identity below the operation. A batch shares one
   * `operationId`, so kinds whose repair is PER RUN must not share one file:
   * the second run's write would overwrite the first, and the first run's
   * completion would delete a sibling's still-pending repair. `free-slot`
   * passes the run id here; batch-wide kinds leave it unset.
   */
  scopeId?: string;
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

  pathFor(
    machine: string,
    kind: MachineParkingIntentKind,
    operationId: string,
    scopeId?: string,
  ): string {
    // The scope segment is APPENDED only when present, so an unscoped journal
    // keeps the exact digest it had before scoping existed and a file already
    // on disk across an upgrade still matches its own identity check.
    const identity = scopeId
      ? `${machine}\0${kind}\0${operationId}\0${scopeId}`
      : `${machine}\0${kind}\0${operationId}`;
    const digest = createHash('sha256').update(identity).digest('hex');
    return path.join(this.directory, `${digest}.json`);
  }

  async write(
    kind: MachineParkingIntentKind,
    records: MachineParkRecord[],
    scopeId?: string,
  ): Promise<void> {
    const first = records[0];
    if (!first) throw new Error('machine parking intent journal requires records');
    if (
      records.some(
        (record) => record.machine !== first.machine || record.operationId !== first.operationId,
      )
    ) {
      throw new Error('machine parking intent journal records must share machine and operation id');
    }
    const journal: MachineParkingIntentJournal = {
      version: 1,
      kind,
      machine: first.machine,
      operationId: first.operationId,
      ...(scopeId ? { scopeId } : {}),
      records,
    };
    // Validate at WRITE time, not only at load. An unvalidated write lands a
    // file that `load()` then quarantines, so a writer/validator disagreement
    // disables recovery silently and only shows up as a lost repair after a
    // crash. Here it fails the park loudly instead, at the point that can still
    // record the failure on the record.
    assertValidJournal(journal);
    await mkdir(this.directory, { recursive: true });
    const target = this.pathFor(first.machine, kind, first.operationId, scopeId);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(journal, null, 2), 'utf8');
    await rename(temp, target);
  }

  async delete(
    machine: string,
    kind: MachineParkingIntentKind,
    operationId: string,
    scopeId?: string,
  ): Promise<void> {
    try {
      await unlink(this.pathFor(machine, kind, operationId, scopeId));
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
        assertValidJournal(parsed);
        if (
          path.basename(source) !==
          path.basename(
            this.pathFor(parsed.machine, parsed.kind, parsed.operationId, parsed.scopeId),
          )
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

/**
 * The one validator both the writer and the loader use. Exported so a test
 * double can enforce the same contract the store does — an in-memory double
 * that skips it lets a writer/validator mismatch pass every unit test and fail
 * only on a real restart.
 */
export function assertValidJournal(value: MachineParkingIntentJournal): void {
  if (
    value?.version !== 1 ||
    (value.kind !== 'pause' && value.kind !== 'restore' && value.kind !== 'free-slot') ||
    typeof value.machine !== 'string' ||
    !value.machine ||
    typeof value.operationId !== 'string' ||
    !value.operationId ||
    !optionalString(value.scopeId, true) ||
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

const PARK_PHASES = new Set([
  'intent-persisted',
  'orchestration-pausing',
  'orchestration-paused',
  'runner-stopping',
  'runner-stopped',
  'resources-stopping',
  'parked',
  'resources-restoring',
  'runner-reloading',
  'orchestration-resuming',
  'restored',
  'cancelling',
  'partial',
  'failed',
  'cancelled',
]);
const RUN_STATUSES = new Set([
  'created',
  'grading',
  'writing-task',
  'slot-finding',
  'preparing',
  'dispatching',
  'monitoring',
  'self-reviewing',
  'completing',
  'human-gating',
  'ci-watching',
  'paused',
  'done',
  'blocked',
  'failed',
  'cancelled',
]);
const STEP_STATUSES = new Set(['pending', 'running', 'done', 'failed', 'skipped']);
const RESOURCE_TYPES = new Set(['device', 'browser', 'dev-server', 'service']);
const RESOURCE_PHASES = new Set([
  'observed-running',
  'stopping',
  'stopped',
  'restoring',
  'restored',
  'failed',
]);
const LEASE_STATES = new Set([
  'held',
  'releasing',
  'released',
  'reacquiring',
  'reacquired',
  'failed',
]);
const RESIDUAL_STATES = new Set(['running', 'stopped', 'unknown']);

function validRecord(record: MachineParkRecord): boolean {
  if (!isRecord(record)) return false;
  const manifest = record.resourceManifest;
  return (
    record.version === 1 &&
    nonEmpty(record.operationId) &&
    nonEmpty(record.previewId) &&
    nonEmpty(record.runId) &&
    nonNegativeInteger(record.generation) &&
    optionalNonNegativeInteger(record.restoredGeneration) &&
    nonEmpty(record.machine) &&
    nonEmpty(record.slotId) &&
    (record.mode === 'orchestration' || record.mode === 'release') &&
    PARK_PHASES.has(record.phase) &&
    RUN_STATUSES.has(record.prePauseStatus) &&
    validCurrentStep(record.prePauseCurrentStep) &&
    isRecord(manifest) &&
    iso(manifest.capturedAt) &&
    Array.isArray(manifest.resources) &&
    manifest.resources.every(validResource) &&
    Array.isArray(manifest.capabilityLeases) &&
    manifest.capabilityLeases.every(validCapabilityLease) &&
    validRecoveryHandle(record.recoveryHandle) &&
    (record.restoreDisposition === undefined ||
      record.restoreDisposition === 'zero-effect' ||
      record.restoreDisposition === 'effectful') &&
    validRecoveryProof(record.recoveryProof) &&
    (record.slotDisposition === undefined ||
      record.slotDisposition === 'retained' ||
      record.slotDisposition === 'freed') &&
    optionalIso(record.slotFreedAt) &&
    validPreservedWorkspace(record.preservedWorkspace) &&
    Array.isArray(record.errors) &&
    record.errors.every(validParkError) &&
    validResiduals(record.residuals) &&
    iso(record.createdAt) &&
    iso(record.updatedAt) &&
    optionalIso(record.parkedAt) &&
    optionalIso(record.restoredAt) &&
    optionalIso(record.cancelledAt)
  );
}

function validResource(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    nonEmpty(value.resourceId) &&
    nonEmpty(value.label) &&
    RESOURCE_TYPES.has(value.type as string) &&
    value.observedStatus === 'running' &&
    RESOURCE_PHASES.has(value.phase as string) &&
    Array.isArray(value.capabilityLeaseIds) &&
    value.capabilityLeaseIds.every(nonEmpty) &&
    optionalIso(value.stoppedAt) &&
    optionalIso(value.restoredAt) &&
    optionalString(value.error)
  );
}

function validCapabilityLease(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const proof = value.proofRequirement;
  return (
    nonEmpty(value.leaseId) &&
    optionalString(value.restoredLeaseId, true) &&
    nonEmpty(value.capabilityId) &&
    LEASE_STATES.has(value.state as string) &&
    isRecord(value.parameters) &&
    isRecord(proof) &&
    proof.capabilityId === value.capabilityId &&
    nonEmpty(proof.reason) &&
    (proof.mode === 'state' || proof.mode === 'visual' || proof.mode === 'mixed') &&
    (proof.parameters === undefined || isRecord(proof.parameters)) &&
    optionalString(value.ownerFamilyId, true) &&
    optionalString(value.resourceId, true) &&
    optionalString(value.error)
  );
}

function validParkError(value: unknown): boolean {
  return (
    isRecord(value) &&
    PARK_PHASES.has(value.phase as string) &&
    nonEmpty(value.action) &&
    nonEmpty(value.code) &&
    nonEmpty(value.message) &&
    iso(value.occurredAt) &&
    typeof value.retryable === 'boolean' &&
    optionalString(value.resourceId, true)
  );
}

function validResiduals(value: unknown): boolean {
  return (
    isRecord(value) &&
    RESIDUAL_STATES.has(value.runner as string) &&
    Array.isArray(value.resources) &&
    value.resources.every(
      (resource) =>
        isRecord(resource) &&
        nonEmpty(resource.resourceId) &&
        RESIDUAL_STATES.has(resource.state as string) &&
        optionalString(resource.detail),
    )
  );
}

function validCurrentStep(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      nonNegativeInteger(value.index) &&
      nonEmpty(value.name) &&
      STEP_STATUSES.has(value.status as string))
  );
}

function validRecoveryHandle(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || !isRecord(value.target)) return false;
  return (
    value.version === 1 &&
    nonEmpty(value.runnerId) &&
    nonEmpty(value.contextId) &&
    nonEmpty(value.sessionId) &&
    nonEmpty(value.sessionPath) &&
    nonEmpty(value.target.session) &&
    nonEmpty(value.target.target) &&
    typeof value.target.paneId === 'string' &&
    /^%\d+$/.test(value.target.paneId) &&
    (value.target.window === undefined ||
      value.target.window === null ||
      typeof value.target.window === 'string') &&
    (value.target.pane === undefined ||
      value.target.pane === null ||
      typeof value.target.pane === 'string') &&
    (value.model === null || typeof value.model === 'string') &&
    optionalString(value.effort) &&
    (value.safetyTier === undefined ||
      value.safetyTier === 'sandboxed' ||
      value.safetyTier === 'full-auto' ||
      value.safetyTier === 'dangerous') &&
    optionalString(value.runtimeDir) &&
    optionalString(value.taskDir) &&
    iso(value.capturedAt)
  );
}

function validPreservedWorkspace(value: unknown): boolean {
  if (value === undefined) return true;
  // `detachedAt` is the FACT, written only once the detach lands. Every record
  // that reaches a journal is written BEFORE that — the pause intent captures
  // `{branch, headSha}` at preview, and the free-slot intent is the pre-detach
  // snapshot. Requiring it here quarantined every park journal on reload and
  // silently disabled repair.
  return (
    isRecord(value) &&
    nonEmpty(value.branch) &&
    nonEmpty(value.headSha) &&
    optionalIso(value.detachedAt)
  );
}

function validRecoveryProof(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !isRecord(value.acknowledgement)) return false;
  return (
    nonEmpty(value.sessionId) &&
    value.live === true &&
    value.acknowledgement.kind === 'structured' &&
    nonEmpty(value.acknowledgement.source) &&
    nonEmpty(value.acknowledgement.reason) &&
    optionalString(value.acknowledgement.turnToken, true) &&
    iso(value.acceptedAt)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function optionalString(value: unknown, requireNonEmpty = false): boolean {
  return (
    value === undefined || (typeof value === 'string' && (!requireNonEmpty || value.length > 0))
  );
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || nonNegativeInteger(value);
}

function iso(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function optionalIso(value: unknown): boolean {
  return value === undefined || iso(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

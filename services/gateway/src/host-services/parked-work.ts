import { type ExecResult, isRecord, type ParkedRunCommits } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { withFarmGitConfig } from '../core/farm-git.js';
import { GatewayMethodError } from '../core/method-error.js';
import { shellQuote } from '../core/tmux.js';
import { registerHostOperations, withHostOperation } from '../observability/performance.js';

import { PARKED_WORK_PROGRAM } from './parked-work-program.js';

const OPS = {
  park: 'parkedWork.park',
  list: 'parkedWork.list',
  lookup: 'parkedWork.lookup',
  mutate: 'parkedWork.mutate',
  restore: 'parkedWork.restore',
  prune: 'parkedWork.prune',
} as const;
registerHostOperations(Object.values(OPS));

export class ParkedWorkError extends GatewayMethodError {
  constructor(code: string, message: string) {
    super(`PARKED_WORK_${code}`, message, {
      userAction:
        'Work was not discarded. Repair the named storage or Git state, then retry the same operation.',
    });
    this.name = 'ParkedWorkError';
  }
}

export interface ParkedSourceHead {
  branch: string;
  headSha: string;
}

export interface ParkedCaptureOptions {
  slotId: string;
  operationKey: string;
  defaultBranch: string;
  purpose: 'checkpoint' | 'prior-work';
  at: string;
  runId?: string;
  extraRefs?: string[];
  targetTrees?: string[];
  sourceHeads?: ParkedSourceHead[];
  includeWorktree?: boolean;
  onlyThreatened?: boolean;
  baseSha?: string;
  notRevs?: string[];
  checks?: { branch?: string; headSha?: string; baseSha?: string };
}

export interface ParkedCapture {
  receipts: ParkedRunCommits[];
  fingerprint: string | null;
  repoKey: string;
  namespace: string;
}

export interface ParkedInventory {
  repoKey: string;
  namespace: string;
  receipts: ParkedRunCommits[];
  legacy: Array<{ ref: string; headSha: string }>;
}

export interface ParkedInspection {
  head: string;
  branch: string;
  fingerprint: string;
  worktreeTreeSha: string;
  repoKey: string;
  namespace: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new ParkedWorkError('INVALID_METADATA', 'The parked-work response is not valid JSON');
    throw error;
  }
}

/** One boundary decoder; no unchecked domain assertion crosses the slot transport. */
export function decodeParkedReceipt(value: unknown): ParkedRunCommits | undefined {
  if (!isRecord(value) || (value.storageVersion !== undefined && value.storageVersion !== 1))
    return undefined;
  const { slotId, ref, branch, baseSha, headSha, parkedAt, commits } = value;
  if (
    typeof slotId !== 'string' ||
    typeof ref !== 'string' ||
    typeof branch !== 'string' ||
    typeof baseSha !== 'string' ||
    typeof headSha !== 'string' ||
    typeof parkedAt !== 'string' ||
    !Array.isArray(commits)
  )
    return undefined;
  const shas: string[] = [];
  for (const commit of commits) {
    if (typeof commit !== 'string') return undefined;
    shas.push(commit);
  }
  const result: ParkedRunCommits = {
    slotId,
    ref,
    branch,
    baseSha,
    headSha,
    parkedAt,
    commits: shas,
  };
  if (value.kind === 'commits' || value.kind === 'worktree') result.kind = value.kind;
  if (value.purpose === 'checkpoint' || value.purpose === 'prior-work')
    result.purpose = value.purpose;
  if (typeof value.sourceHeadSha === 'string') result.sourceHeadSha = value.sourceHeadSha;
  if (typeof value.indexArchiveSha === 'string') result.indexArchiveSha = value.indexArchiveSha;
  if (typeof value.fingerprint === 'string') result.fingerprint = value.fingerprint;
  if (typeof value.operationKey === 'string') result.operationKey = value.operationKey;
  if (typeof value.repoKey === 'string') result.repoKey = value.repoKey;
  if (typeof value.metadataRef === 'string') result.metadataRef = value.metadataRef;
  if (typeof value.worktreeTreeSha === 'string') result.worktreeTreeSha = value.worktreeTreeSha;
  if (typeof value.runId === 'string') result.runId = value.runId;
  if (value.storageVersion === 1) result.storageVersion = 1;
  if (typeof value.prunedAt === 'string') result.prunedAt = value.prunedAt;
  if (value.pruneReason === 'age' || value.pruneReason === 'remote')
    result.pruneReason = value.pruneReason;
  if (
    result.kind === 'worktree' &&
    (!result.sourceHeadSha || !result.indexArchiveSha || !result.worktreeTreeSha)
  )
    return undefined;
  return result;
}

type Executor = typeof execOnSlot;

async function request(
  vars: SlotVars,
  op: keyof typeof OPS,
  parameters: Record<string, unknown>,
  exec: Executor,
): Promise<unknown> {
  return withHostOperation(OPS[op], async () => {
    const command = `node -e ${shellQuote(PARKED_WORK_PROGRAM)} ${shellQuote(JSON.stringify({ ...parameters, op, repo: vars.remoteRepo }))}`;
    const result = await exec(vars, withFarmGitConfig(command), {
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      noRetry: true,
      selectNodeSupport: false,
    });
    const envelope = parseJson(result.stdout);
    if (!isRecord(envelope) || typeof envelope.ok !== 'boolean')
      throw new ParkedWorkError('INVALID_METADATA', 'The parked-work response has no result');
    if (!envelope.ok)
      throw new ParkedWorkError(
        typeof envelope.code === 'string' ? envelope.code : 'PARK_FAILED',
        typeof envelope.message === 'string' ? envelope.message : 'Parked-work operation failed',
      );
    if (result.exitCode !== 0)
      throw new ParkedWorkError('PARK_FAILED', 'The parked-work process did not complete');
    return envelope.value;
  });
}

function receiptsFromRows(rows: unknown, repoKey: string, namespace: string): ParkedInventory {
  if (!Array.isArray(rows))
    throw new ParkedWorkError('INVALID_METADATA', 'Missing parked inventory');
  const receipts: ParkedRunCommits[] = [];
  const legacy: ParkedInventory['legacy'] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.ref !== 'string' || typeof row.headSha !== 'string')
      throw new ParkedWorkError('INVALID_METADATA', 'Invalid parked ref observation');
    if (row.metadata === null) {
      legacy.push({ ref: row.ref, headSha: row.headSha });
      continue;
    }
    if (typeof row.metadata !== 'string')
      throw new ParkedWorkError('INVALID_METADATA', 'Missing parked receipt');
    const record = decodeParkedReceipt(parseJson(row.metadata));
    if (
      !record ||
      record.ref !== row.ref ||
      record.headSha !== row.headSha ||
      (record.repoKey && record.repoKey !== repoKey)
    )
      throw new ParkedWorkError(
        'INVALID_METADATA',
        'Parked receipt does not match its actual Git ref',
      );
    receipts.push(record);
  }
  return { repoKey, namespace, receipts, legacy };
}

export async function parkGitWork(
  vars: SlotVars,
  options: ParkedCaptureOptions,
  exec: Executor = execOnSlot,
): Promise<ParkedCapture> {
  const value = await request(vars, 'park', { ...options }, exec);
  if (
    !isRecord(value) ||
    typeof value.repoKey !== 'string' ||
    typeof value.namespace !== 'string' ||
    !(value.fingerprint === null || typeof value.fingerprint === 'string')
  )
    throw new ParkedWorkError('INVALID_METADATA', 'Invalid parking result');
  const inventory = receiptsFromRows(value.receipts, value.repoKey, value.namespace);
  if (inventory.legacy.length)
    throw new ParkedWorkError('INVALID_METADATA', 'New parking has no canonical receipt');
  return {
    receipts: inventory.receipts,
    fingerprint: value.fingerprint,
    repoKey: value.repoKey,
    namespace: value.namespace,
  };
}

export async function readParkedGitWork(
  vars: SlotVars,
  slotId: string,
  exec: Executor = execOnSlot,
): Promise<ParkedInventory> {
  const value = await request(vars, 'list', { slotId }, exec);
  if (!isRecord(value) || typeof value.repoKey !== 'string' || typeof value.namespace !== 'string')
    throw new ParkedWorkError('INVALID_METADATA', 'Invalid parked inventory result');
  return receiptsFromRows(value.items, value.repoKey, value.namespace);
}

export async function executeParkedGitMutation(
  vars: SlotVars,
  options: Pick<ParkedCaptureOptions, 'slotId' | 'extraRefs' | 'targetTrees'>,
  capture: ParkedCapture,
  command: string,
  exec: Executor = execOnSlot,
): Promise<ExecResult> {
  const value = await request(
    vars,
    'mutate',
    { ...options, expectedFingerprint: capture.fingerprint, saved: capture.receipts, command },
    exec,
  );
  if (
    !isRecord(value) ||
    typeof value.stdout !== 'string' ||
    typeof value.stderr !== 'string' ||
    typeof value.exitCode !== 'number'
  )
    throw new ParkedWorkError('INVALID_METADATA', 'Invalid Git mutation result');
  return { stdout: value.stdout, stderr: value.stderr, exitCode: value.exitCode };
}

export type ParkedRestoreSource = Pick<ParkedRunCommits, 'ref' | 'headSha'> &
  Partial<ParkedRunCommits>;

/** Restore visits the source commit before applying a saved working tree. */
export function parkedRestoreTargets(receipt: ParkedRestoreSource): string[] {
  const targets = [receipt.sourceHeadSha ?? receipt.headSha];
  if (receipt.kind === 'worktree' && receipt.worktreeTreeSha) targets.push(receipt.worktreeTreeSha);
  return targets;
}

export async function restoreParkedGitWork(
  vars: SlotVars,
  options: Pick<ParkedCaptureOptions, 'slotId' | 'extraRefs' | 'targetTrees'> & {
    restoreBranch?: string;
  },
  capture: ParkedCapture,
  receipt: ParkedRestoreSource,
  exec: Executor = execOnSlot,
): Promise<ParkedInspection> {
  const value = await request(
    vars,
    'restore',
    { ...options, expectedFingerprint: capture.fingerprint, saved: capture.receipts, receipt },
    exec,
  );
  if (
    !isRecord(value) ||
    typeof value.branch !== 'string' ||
    typeof value.headSha !== 'string' ||
    typeof value.fingerprint !== 'string'
  )
    throw new ParkedWorkError('INVALID_METADATA', 'Invalid restore result');
  return {
    branch: value.branch,
    head: value.headSha,
    fingerprint: value.fingerprint,
    worktreeTreeSha: receipt.worktreeTreeSha ?? '',
    repoKey: capture.repoKey,
    namespace: capture.namespace,
  };
}

export async function pruneParkedGitWork(
  vars: SlotVars,
  slotId: string,
  receipts: ParkedRunCommits[],
  protectedRefs: string[],
  before: string,
  at: string,
  exec: Executor = execOnSlot,
): Promise<ParkedRunCommits[]> {
  const value = await request(vars, 'prune', { slotId, receipts, protectedRefs, before, at }, exec);
  if (!isRecord(value) || !Array.isArray(value.pruned))
    throw new ParkedWorkError('INVALID_METADATA', 'Invalid parked retention result');
  const result: ParkedRunCommits[] = [];
  for (const candidate of value.pruned) {
    const receipt = decodeParkedReceipt(candidate);
    if (!receipt) throw new ParkedWorkError('INVALID_METADATA', 'Invalid pruned receipt');
    result.push(receipt);
  }
  return result;
}

export async function lookupParkedGitWork(
  vars: SlotVars,
  slotId: string,
  ref: string,
  exec: Executor = execOnSlot,
): Promise<{ headSha: string | null; receipt: ParkedRunCommits | undefined }> {
  if (!ref.startsWith('refs/farmslot/parked/') || ref.includes('..') || ref.includes('\n'))
    throw new ParkedWorkError('INVALID_REF', 'Select a retained parked-work ref');
  const value = await request(vars, 'lookup', { slotId, ref }, exec);
  if (!isRecord(value) || !(value.headSha === null || typeof value.headSha === 'string'))
    throw new ParkedWorkError('INVALID_METADATA', 'Invalid parked ref lookup');
  const receipt =
    typeof value.metadata === 'string' ? decodeParkedReceipt(parseJson(value.metadata)) : undefined;
  return { headSha: value.headSha, receipt };
}

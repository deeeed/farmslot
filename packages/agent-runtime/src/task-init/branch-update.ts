import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { BranchMaintenanceOperation } from '@farmslot/protocol';

export interface BranchMaintenanceRequest {
  id: string;
  ownerRunId: string;
  project: string;
  repo: string;
  branch: string;
  baseRef: string;
  kind: BranchMaintenanceOperation['kind'];
  authority: { headSha: string; comparisonBaseSha: string; replayBoundarySha: string };
  expectedCheckpoint?: BranchMaintenanceOperation['expectedCheckpoint'];
  upstreamMergeSha?: string;
}

export interface OrdinaryBranchMaintenanceRequest {
  kind: 'ordinary';
  repo: string;
  branch: string;
  baseRef: string;
}

interface BranchUpdateReceipt {
  operationHash: string;
  operation: BranchMaintenanceOperation;
  sourceHeadSha: string;
  replayHeadSha: string;
  boundarySha: string;
  phase: 'prepared' | 'rebasing' | 'completed';
  observedHeadSha?: string;
  resultHeadSha?: string;
  rebaseResultSha?: string;
  pushedHeadSha?: string;
}

export class BranchMaintenanceRefusal extends Error {
  constructor(
    public readonly code: string,
    cause?: unknown,
  ) {
    super(`Branch maintenance refused: ${code}`, { cause });
  }
}

function refuse(code: string): never {
  throw new BranchMaintenanceRefusal(code);
}
const sha = (value: string): string =>
  /^[a-f0-9]{40}$/i.test(value) ? value : refuse('INVALID_COMMIT');
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function normalizeMaintenanceBranch(value: string): string {
  return value.replace(/^(?:refs\/remotes\/origin\/|refs\/heads\/|origin\/)/, '');
}

function git(repo: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input,
    maxBuffer: 16 * 1024 * 1024,
  }).trimEnd();
}

function ancestor(repo: string, left: string, right: string): boolean {
  try {
    git(repo, ['merge-base', '--is-ancestor', sha(left), sha(right)]);
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

function fetchHeads(repo: string, branch: string, base: string): void {
  for (const value of [branch, base]) git(repo, ['check-ref-format', `refs/heads/${value}`]);
  try {
    git(repo, [
      'fetch',
      'origin',
      ...new Set(
        [branch, base].map((value) => `+refs/heads/${value}:refs/remotes/origin/${value}`),
      ),
    ]);
  } catch (error) {
    throw new BranchMaintenanceRefusal('FETCH_FAILED', error);
  }
}

function ref(repo: string, branch: string): string {
  return sha(git(repo, ['rev-parse', `refs/remotes/origin/${branch}`]).trim());
}

function assertSource(operation: BranchMaintenanceOperation, source: string): void {
  if (!ancestor(operation.repo, operation.authorityHeadSha, source))
    refuse('PARENT_SOURCE_CHANGED');
  if (!ancestor(operation.repo, operation.replayBoundarySha, source))
    refuse('PARENT_BOUNDARY_MISSING');
  if (!ancestor(operation.repo, operation.remoteHeadSha, source))
    refuse('REMOTE_CHILD_COMMITS_MISSING');
  if (git(operation.repo, ['rev-list', '--merges', `${operation.authorityHeadSha}..${source}`]))
    refuse('UNVERIFIED_MERGE');
}

export function inspectBranchMaintenance(
  request: BranchMaintenanceRequest,
): BranchMaintenanceOperation {
  const branch = normalizeMaintenanceBranch(request.branch);
  const baseRef = normalizeMaintenanceBranch(request.baseRef);
  fetchHeads(request.repo, branch, baseRef);
  const remoteHeadSha = ref(request.repo, branch);
  const targetSha = ref(request.repo, baseRef);
  // Handoff can precede prepare, so pin the remote source without relying
  // on the checkout currently occupying the slot. Execute verifies that checkout.
  const sourceHeadSha = remoteHeadSha;
  const { authority, ...input } = request;
  const operation: BranchMaintenanceOperation = {
    ...input,
    branch,
    baseRef,
    sourceHeadSha,
    remoteHeadSha,
    targetSha,
    comparisonBaseSha: sha(authority.comparisonBaseSha),
    replayBoundarySha: sha(authority.replayBoundarySha),
    authorityHeadSha: sha(authority.headSha),
    preparedAt: new Date().toISOString(),
  };
  assertSource(operation, sourceHeadSha);
  if (!request.expectedCheckpoint) {
    // Recorded prepare provenance prevents a rewound parent's live merge-base from
    // reclassifying removed parent commits as child work.
    if (
      ancestor(request.repo, operation.replayBoundarySha, operation.comparisonBaseSha) &&
      ancestor(request.repo, operation.comparisonBaseSha, sourceHeadSha)
    )
      operation.replayBoundarySha = operation.comparisonBaseSha;
    else operation.comparisonBaseSha = operation.replayBoundarySha;
    if (request.upstreamMergeSha && ancestor(request.repo, request.upstreamMergeSha, sourceHeadSha))
      operation.comparisonBaseSha = sha(
        git(request.repo, ['merge-base', targetSha, sourceHeadSha]).trim(),
      );
  }
  if (request.upstreamMergeSha && !ancestor(request.repo, request.upstreamMergeSha, targetSha))
    refuse('RETARGET_PROVENANCE_MISSING');
  return operation;
}

function operationHash(operation: BranchMaintenanceOperation): string {
  return digest(JSON.stringify(operation));
}

function receiptPath(operation: Pick<BranchMaintenanceOperation, 'repo' | 'id'>): string {
  return path.resolve(
    operation.repo,
    git(operation.repo, [
      'rev-parse',
      '--git-path',
      `farmslot-branch-${digest(operation.id)}.json`,
    ]).trim(),
  );
}

function readReceipt(operation: BranchMaintenanceOperation): BranchUpdateReceipt | undefined {
  const file = receiptPath(operation);
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, 'utf8')) as BranchUpdateReceipt;
  if (value.operationHash !== operationHash(operation)) refuse('OPERATION_CHANGED');
  assertSource(operation, sha(value.sourceHeadSha));
  sha(value.replayHeadSha);
  sha(value.boundarySha);
  if (!['prepared', 'rebasing', 'completed'].includes(value.phase)) refuse('RECEIPT_INVALID');
  return value;
}

function recordReceipt(operation: BranchMaintenanceOperation, value: BranchUpdateReceipt): void {
  const file = receiptPath(operation);
  const temp = `${file}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  const directory = openSync(path.dirname(file), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function rebaseActive(repo: string): boolean {
  return ['rebase-merge', 'rebase-apply'].some((name) =>
    existsSync(path.resolve(repo, git(repo, ['rev-parse', '--git-path', name]).trim())),
  );
}

function fenceTarget(operation: BranchMaintenanceOperation): string {
  fetchHeads(operation.repo, operation.branch, operation.baseRef);
  if (ref(operation.repo, operation.baseRef) !== sha(operation.targetSha)) refuse('TARGET_CHANGED');
  return ref(operation.repo, operation.branch);
}

function assertCheckout(operation: BranchMaintenanceOperation): void {
  if (git(operation.repo, ['branch', '--show-current']).trim() !== operation.branch)
    refuse('BRANCH_CHANGED');
  if (git(operation.repo, ['status', '--porcelain'])) refuse('UNCOMMITTED_CHANGES');
}

function assertOwnedResult(
  operation: BranchMaintenanceOperation,
  receipt: BranchUpdateReceipt,
  head: string,
): void {
  if (!ancestor(operation.repo, operation.targetSha, head)) refuse('RESULT_TARGET_MISSING');
  if (git(operation.repo, ['rev-list', '--merges', `${operation.targetSha}..${head}`]))
    refuse('UNVERIFIED_RESULT_MERGE');
  const paths = (base: string, result: string) =>
    git(operation.repo, ['diff', '--name-only', '-z', base, result, '--'])
      .split('\0')
      .filter(Boolean);
  const owned = new Set([
    ...paths(operation.comparisonBaseSha, receipt.sourceHeadSha),
    ...(receipt.rebaseResultSha ? paths(receipt.rebaseResultSha, head) : []),
  ]);
  if (paths(operation.targetSha, head).some((value) => !owned.has(value)))
    refuse('INHERITED_CHANGES_REPLAYED');
}

function journalCommand(operation: BranchMaintenanceOperation): string {
  // Rebase runs this after each applied commit, including `rebase --continue`.
  // The durable result journal closes the successful-rebase/pre-renewal crash gap.
  const code = `const f=require('node:fs'),p=require('node:path'),c=require('node:child_process');const file=process.argv[1],v=JSON.parse(f.readFileSync(file,'utf8'));if(v.operationHash!==process.argv[2]||v.phase!=='rebasing')throw Error('OPERATION_CHANGED');v.observedHeadSha=c.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();const tmp=file+'.'+process.pid+'.tmp',fd=f.openSync(tmp,'w',384);try{f.writeFileSync(fd,JSON.stringify(v));f.fsyncSync(fd)}finally{f.closeSync(fd)}f.renameSync(tmp,file);const d=f.openSync(p.dirname(file),'r');try{f.fsyncSync(d)}finally{f.closeSync(d)}`;
  return `${quote(process.execPath)} -e ${quote(code)} ${quote(receiptPath(operation))} ${quote(operationHash(operation))}`;
}

function prepareReceipt(operation: BranchMaintenanceOperation, head: string): BranchUpdateReceipt {
  const repo = operation.repo;
  assertSource(operation, head);
  let boundary = operation.replayBoundarySha;
  let replay = head;
  if (git(repo, ['rev-list', '--merges', `${boundary}..${head}`])) {
    // A single committed child delta preserves merge resolutions without
    // replaying inherited squash/default commits removed by the new target.
    boundary = operation.comparisonBaseSha;
    const signing =
      git(repo, ['config', '--type=bool', '--default=false', '--get', 'commit.gpgsign']).trim() ===
      'true';
    replay = sha(
      git(
        repo,
        [
          'commit-tree',
          git(repo, ['rev-parse', `${head}^{tree}`]).trim(),
          '-p',
          boundary,
          ...(signing ? ['-S'] : []),
        ],
        'fix: retain verified child changes during branch maintenance\n',
      ).trim(),
    );
  }
  const receipt: BranchUpdateReceipt = {
    operationHash: operationHash(operation),
    operation,
    sourceHeadSha: head,
    replayHeadSha: replay,
    boundarySha: boundary,
    phase: 'prepared',
  };
  // Persist before reset or rebase can alter the branch.
  recordReceipt(operation, receipt);
  return receipt;
}

export function executeBranchMaintenance(operation: BranchMaintenanceOperation): string {
  if (operation.kind !== 'rebase') refuse('WRONG_OPERATION_KIND');
  const repo = operation.repo;
  let receipt = readReceipt(operation);
  const remote = fenceTarget(operation);
  if (remote !== operation.remoteHeadSha && remote !== receipt?.resultHeadSha)
    refuse('REMOTE_CHILD_CHANGED');
  if (rebaseActive(repo)) refuse('RESOLVE_REBASE_CONFLICT');
  assertCheckout(operation);
  let head = sha(git(repo, ['rev-parse', 'HEAD']).trim());
  if (receipt?.phase === 'completed') {
    if (head !== receipt.resultHeadSha) refuse('LOCAL_RESULT_CHANGED');
    assertOwnedResult(operation, receipt, head);
    return head;
  }
  if (!receipt) receipt = prepareReceipt(operation, head);
  if (
    receipt.phase === 'rebasing' &&
    head !== receipt.replayHeadSha &&
    head !== receipt.sourceHeadSha
  ) {
    const allAlreadyPresent =
      head === operation.targetSha &&
      !git(repo, ['cherry', operation.targetSha, receipt.replayHeadSha, receipt.boundarySha])
        .split('\n')
        .some((line) => line.startsWith('+'));
    if (head !== receipt.observedHeadSha && !allAlreadyPresent) refuse('REBASE_RESULT_UNVERIFIED');
  } else {
    if (head !== receipt.sourceHeadSha && head !== receipt.replayHeadSha)
      refuse('LOCAL_SOURCE_CHANGED');
    receipt = { ...receipt, phase: 'rebasing' };
    recordReceipt(operation, receipt);
    if (head !== receipt.replayHeadSha) git(repo, ['reset', '--soft', receipt.replayHeadSha]);
    try {
      git(repo, [
        'rebase',
        '--onto',
        operation.targetSha,
        receipt.boundarySha,
        '--exec',
        journalCommand(operation),
        operation.branch,
      ]);
    } catch (error) {
      if (rebaseActive(repo)) throw new BranchMaintenanceRefusal('RESOLVE_REBASE_CONFLICT', error);
      throw new BranchMaintenanceRefusal('REBASE_REFUSED', error);
    }
    head = sha(git(repo, ['rev-parse', 'HEAD']).trim());
    receipt = readReceipt(operation)!;
  }
  assertOwnedResult(operation, receipt, head);
  recordReceipt(operation, {
    ...receipt,
    phase: 'completed',
    rebaseResultSha: head,
    resultHeadSha: head,
  });
  return head;
}

export function pushBranchMaintenance(operation: BranchMaintenanceOperation): void {
  let receipt = readReceipt(operation);
  const remote = fenceTarget(operation);
  if (!receipt?.resultHeadSha || receipt.phase !== 'completed') refuse('GUARDED_RESULT_MISSING');
  assertCheckout(operation);
  const head = sha(git(operation.repo, ['rev-parse', 'HEAD']).trim());
  if (remote !== operation.remoteHeadSha && remote !== head) refuse('REMOTE_CHILD_CHANGED');
  if (head !== receipt.resultHeadSha) {
    if (
      !ancestor(operation.repo, receipt.resultHeadSha, head) ||
      git(operation.repo, ['rev-list', '--merges', `${receipt.resultHeadSha}..${head}`])
    )
      refuse('LOCAL_RESULT_CHANGED');
    // Inline fixes may append worker-owned commits after the guarded rebase.
    // Bind that verified continuation before any remote write.
    receipt = { ...receipt, resultHeadSha: head };
    assertOwnedResult(operation, receipt, head);
    recordReceipt(operation, receipt);
  }
  assertOwnedResult(operation, receipt, head);
  if (remote === head) {
    recordReceipt(operation, { ...receipt, pushedHeadSha: head });
    return;
  }
  if (remote !== operation.remoteHeadSha) refuse('REMOTE_CHILD_CHANGED');
  try {
    git(operation.repo, [
      'push',
      'origin',
      `${receipt.resultHeadSha}:refs/heads/${operation.branch}`,
      `--force-with-lease=refs/heads/${operation.branch}:${operation.remoteHeadSha}`,
    ]);
  } catch (error) {
    throw new BranchMaintenanceRefusal('PUSH_REFUSED', error);
  }
  recordReceipt(operation, { ...receipt, pushedHeadSha: head });
}

export function verifyBranchMaintenance(operation: BranchMaintenanceOperation): {
  headSha: string;
  replayBoundarySha: string;
} {
  const receipt = operation.kind === 'rebase' ? readReceipt(operation) : undefined;
  fetchHeads(operation.repo, operation.branch, operation.baseRef);
  const headSha = ref(operation.repo, operation.branch);
  const targetChanged = ref(operation.repo, operation.baseRef) !== operation.targetSha;
  if (operation.kind === 'graph-merge') {
    if (headSha === operation.remoteHeadSha) {
      if (targetChanged) refuse('TARGET_CHANGED');
      if (!ancestor(operation.repo, operation.targetSha, headSha)) refuse('GRAPH_UPDATE_PENDING');
      return { headSha, replayBoundarySha: operation.replayBoundarySha };
    }
    if (!ancestor(operation.repo, operation.targetSha, headSha)) refuse('RESULT_TARGET_MISSING');
    const parents = git(operation.repo, ['rev-list', '--parents', '-n', '1', headSha])
      .split(/\s+/)
      .slice(1);
    if (
      parents.length !== 2 ||
      parents[0] !== operation.remoteHeadSha ||
      parents[1] !== operation.targetSha
    )
      refuse('GRAPH_MERGE_CHANGED');
    const expectedTree = git(operation.repo, [
      'merge-tree',
      '--write-tree',
      operation.remoteHeadSha,
      operation.targetSha,
    ]).trim();
    if (git(operation.repo, ['rev-parse', `${headSha}^{tree}`]).trim() !== expectedTree)
      refuse('GRAPH_MERGE_TREE_CHANGED');
    return { headSha, replayBoundarySha: operation.replayBoundarySha };
  }
  if (!receipt?.resultHeadSha || receipt.phase !== 'completed') {
    if (targetChanged) refuse('TARGET_CHANGED');
    refuse('GUARDED_RESULT_MISSING');
  }
  if (receipt.resultHeadSha !== headSha) {
    if (targetChanged) refuse('TARGET_CHANGED');
    refuse('REMOTE_RESULT_CHANGED');
  }
  // Exact remote equality to a changed guarded result also recovers a crash
  // after the leased push and before its local success mark. A no-op requires
  // the shared push's explicit mark because its remote head never changed.
  if (headSha === operation.remoteHeadSha && receipt.pushedHeadSha !== headSha) {
    if (targetChanged) refuse('TARGET_CHANGED');
    refuse('RESULT_NOT_PUSHED');
  }
  assertOwnedResult(operation, receipt, headSha);
  return { headSha, replayBoundarySha: operation.targetSha };
}

function ordinaryIdentity(
  request: OrdinaryBranchMaintenanceRequest,
): Pick<BranchMaintenanceOperation, 'repo' | 'id'> {
  return {
    repo: request.repo,
    id: `ordinary-${digest(JSON.stringify([path.resolve(request.repo), normalizeMaintenanceBranch(request.branch), normalizeMaintenanceBranch(request.baseRef)]))}`,
  };
}

export function executeOrdinaryBranchMaintenance(
  request: OrdinaryBranchMaintenanceRequest,
): string {
  const identity = ordinaryIdentity(request);
  const file = receiptPath(identity);
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as BranchUpdateReceipt;
    if (saved.operation.id !== identity.id || saved.operation.repo !== identity.repo)
      refuse('OPERATION_CHANGED');
    // An unfinished attempt keeps its original lease and target. A completed,
    // published attempt may start a subsequent normal maintenance operation.
    if (saved.phase !== 'completed' || rebaseActive(request.repo))
      return executeBranchMaintenance(saved.operation);
    fetchHeads(request.repo, saved.operation.branch, saved.operation.baseRef);
    if (
      ref(request.repo, saved.operation.baseRef) === saved.operation.targetSha &&
      git(request.repo, ['rev-parse', 'HEAD']).trim() === saved.resultHeadSha
    )
      return executeBranchMaintenance(saved.operation);
    if (ref(request.repo, saved.operation.branch) !== saved.resultHeadSha)
      refuse('REMOTE_CHILD_CHANGED');
  }
  const branch = normalizeMaintenanceBranch(request.branch);
  const baseRef = normalizeMaintenanceBranch(request.baseRef);
  fetchHeads(request.repo, branch, baseRef);
  const head = sha(git(request.repo, ['rev-parse', 'HEAD']).trim());
  const boundary = sha(git(request.repo, ['merge-base', ref(request.repo, baseRef), head]).trim());
  const operation = inspectBranchMaintenance({
    ...identity,
    ownerRunId: 'ordinary',
    project: '',
    branch: request.branch,
    baseRef: request.baseRef,
    kind: 'rebase',
    authority: {
      headSha: ref(request.repo, branch),
      comparisonBaseSha: boundary,
      replayBoundarySha: boundary,
    },
  });
  operation.sourceHeadSha = head;
  assertCheckout(operation);
  assertSource(operation, head);
  prepareReceipt(operation, head);
  return executeBranchMaintenance(operation);
}

export function pushOrdinaryBranchMaintenance(request: OrdinaryBranchMaintenanceRequest): void {
  const file = receiptPath(ordinaryIdentity(request));
  if (!existsSync(file)) refuse('GUARDED_RESULT_MISSING');
  const saved = JSON.parse(readFileSync(file, 'utf8')) as BranchUpdateReceipt;
  if (saved.operation.id !== ordinaryIdentity(request).id || saved.operation.repo !== request.repo)
    refuse('OPERATION_CHANGED');
  pushBranchMaintenance(saved.operation);
}

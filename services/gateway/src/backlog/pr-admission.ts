import {
  isTerminalRunStatus,
  monitoredPRKey,
  parseGitHubPullUrl,
  parseGitHubRef,
  PR_BOUND_FLOW_TYPES,
  type PRExecutionChoice,
  type QueueItem,
  type Run,
  type RunCreateParams,
} from '@farmslot/protocol';

export type PRQueuePreparation =
  | { ready: false; reason: string }
  | { ready: true; choices: PRExecutionChoice[] };
export interface PRQueueAdmissionHooks {
  prepare(item: QueueItem): Promise<PRQueuePreparation>;
  refreshBeforeCreate(item: QueueItem): Promise<void>;
  assertCurrent(item: QueueItem): void;
  created(item: QueueItem, run: Run): Promise<void>;
}

const handlers = new Map<'review' | 'repair', PRQueueAdmissionHooks>();

export function initPRQueueAdmission(
  kind: 'review' | 'repair',
  value: PRQueueAdmissionHooks,
): void {
  handlers.set(kind, value);
}
export function preparePRQueueAdmission(item: QueueItem): Promise<PRQueuePreparation> {
  const hooks = item.prWork ? handlers.get(item.prWork.kind) : undefined;
  if (!hooks)
    return Promise.resolve({ ready: false, reason: 'PR automation admission is not initialized' });
  return hooks.prepare(item);
}
export async function refreshPRQueueAdmission(item: QueueItem): Promise<void> {
  if (!item.prWork) return;
  const hooks = handlers.get(item.prWork.kind);
  if (!hooks) throw new Error('PR automation admission is not initialized');
  await hooks.refreshBeforeCreate(item);
}
export function assertPRQueueAdmission(item: QueueItem): void {
  if (!item.prWork) return;
  const hooks = handlers.get(item.prWork.kind);
  if (!hooks) throw new Error('PR automation admission is not initialized');
  hooks.assertCurrent(item);
}
export async function recordPRQueueRun(item: QueueItem, run: Run): Promise<void> {
  if (!item.prWork) return;
  const hooks = handlers.get(item.prWork.kind);
  if (!hooks) throw new Error('PR automation admission is not initialized');
  await hooks.created(item, run);
}

export function runOwnsPR(
  run: Run,
  pr: NonNullable<QueueItem['prWork']>['pr'],
  mappedProject?: string,
): boolean {
  if (isTerminalRunStatus(run.status)) return false;
  if (run.prWork) return monitoredPRKey(run.prWork.pr) === monitoredPRKey(pr);
  if (
    run.prPublications?.some((publication) => monitoredPRKey(publication.pr) === monitoredPRKey(pr))
  )
    return true;
  const matches = (ref: ReturnType<typeof parseGitHubRef>) =>
    Boolean(
      ref &&
      pr.host.toLowerCase() === 'github.com' &&
      ref.repo.toLowerCase() === pr.repo.toLowerCase() &&
      ref.number === pr.number,
    );
  const ref = PR_BOUND_FLOW_TYPES.has(run.flowType) ? parseGitHubRef(run.ticketOrPr) : null;
  if (ref) return matches(ref);
  const links = (run.links ?? [])
    .map((link) => parseGitHubPullUrl(link.url))
    .filter((link) => link !== null);
  if (links.some(matches)) return true;
  // The configured project maps to this repository. Use the number only while no
  // canonical binding is available, rather than colliding with an explicit different repo.
  return (
    links.length === 0 &&
    Boolean(mappedProject && run.project === mappedProject && run.prNumber === pr.number)
  );
}

/** Protect the inverse race too: manual/internal run creation cannot overtake active automation. */
export function assertNoAutomatedPRConflict(params: RunCreateParams, runs: Run[]): void {
  const ref = PR_BOUND_FLOW_TYPES.has(params.flowType) ? parseGitHubRef(params.ticketOrPr) : null;
  if (!ref && params.prNumber === undefined) return;
  for (const run of runs) {
    if (!run.prWork || isTerminalRunStatus(run.status)) continue;
    const sameRef =
      ref &&
      ref.repo.toLowerCase() === run.prWork.pr.repo.toLowerCase() &&
      ref.number === run.prWork.pr.number;
    const sameProjectPR =
      !ref && params.project === run.project && params.prNumber === run.prWork.pr.number;
    if (sameRef || sameProjectPR) throw new Error(`PR execution is owned by run ${run.id}`);
  }
}

export function assertPRReviewWorktreeHead(
  run: Run | undefined | null,
  headSha: string | null,
): void {
  if (run?.prWork?.kind !== 'review') return;
  if (!headSha || headSha !== run.prWork.headSha)
    throw new Error(
      'PR head changed before review dispatch; reconcile the review intent before starting a worker',
    );
}

/** All revival paths share updateRun, including replay, retry and restart recovery. */
export function assertPRRunActivation(run: Run, others: Run[]): void {
  const active = others.filter((item) => item.id !== run.id);
  for (const owner of active) {
    if (
      owner.prWork &&
      !isTerminalRunStatus(owner.status) &&
      runOwnsPR(run, owner.prWork.pr, owner.project)
    )
      throw new Error(`PR execution is owned by run ${owner.id}`);
  }
  if (run.prWork) {
    const owner = active.find((item) => runOwnsPR(item, run.prWork!.pr, run.project));
    if (owner) throw new Error(`PR execution is owned by run ${owner.id}`);
  }
}

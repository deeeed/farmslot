import type { SlotStatus } from '@farmslot/protocol';

import { loadProjectConfigs } from '../../fleet/state.js';
import { listRuns } from '../../runs/store.js';

import {
  isDispatchStaleBranch,
  projectConfigsFromProjects,
  resolveJiraTargetBranchFromFleet,
} from './slot-scoring.js';
import { normalizeTicketRef } from './ticket-ref.js';

export interface ResolveDispatchTargetBranchParams {
  flowType?: string | null;
  ticketOrPr?: string | null;
  project: string;
  targetBranch?: string | null;
}

export async function resolveDispatchTargetBranch(
  params: ResolveDispatchTargetBranchParams,
  options: {
    fleetSlots?: SlotStatus[];
    projectSlots?: SlotStatus[];
    logPrefix?: string;
  } = {},
): Promise<string | undefined> {
  let resolvedTargetBranch = params.targetBranch ?? undefined;
  const logPrefix = options.logPrefix ?? 'dispatch';

  const projectConfigs = projectConfigsFromProjects(await loadProjectConfigs());

  if (!resolvedTargetBranch && params.flowType === 'fix-bug' && params.ticketOrPr) {
    resolvedTargetBranch = resolveJiraTargetBranchFromFleet(
      options.projectSlots ?? options.fleetSlots ?? [],
      params.project,
      params.ticketOrPr,
      projectConfigs,
    );
    if (resolvedTargetBranch) {
      console.log(
        `[${logPrefix}] resolved targetBranch=${resolvedTargetBranch} for ${params.ticketOrPr} via Jira slot branch`,
      );
    }
  }

  const isPrFlow = params.flowType === 'pr-complete' || params.flowType === 'review-pr';
  const flowExplicitlyNonPr = params.flowType === 'fix-bug' || params.flowType === 'dev';
  const ticketLooksLikePr = params.ticketOrPr
    ? /#\d+$|\/pull\/\d+\b|^\d+$/.test(params.ticketOrPr)
    : false;
  const shouldResolve = !flowExplicitlyNonPr && (isPrFlow || ticketLooksLikePr);
  if (resolvedTargetBranch || !shouldResolve || !params.ticketOrPr) return resolvedTargetBranch;

  // Normalize before parsing — UI paths can pass a GitHub URL while direct callers often pass
  // owner/repo#number. Keep one resolution chain shared across preview/candidates/run.create.
  const canonicalTicketOrPr = normalizeTicketRef(params.ticketOrPr);
  const m = canonicalTicketOrPr.match(/^([^/#\s]+\/[^/#\s]+)#(\d+)$/);
  if (!m) return undefined;

  const [, repo, numStr] = m;
  const prNum = parseInt(numStr, 10);

  const matchingSlot = options.fleetSlots?.find(
    (s) =>
      s.project === params.project &&
      (s.currentTicketOrPr === params.ticketOrPr || s.currentTicketOrPr === canonicalTicketOrPr) &&
      s.branch &&
      s.branch !== '-' &&
      isDispatchStaleBranch(s, projectConfigs),
  );
  if (matchingSlot?.branch) {
    console.log(
      `[${logPrefix}] resolved targetBranch=${matchingSlot.branch} for ${params.ticketOrPr} via fleet scan (slot ${matchingSlot.slot})`,
    );
    return matchingSlot.branch;
  }

  const { runs } = listRuns({ prNumber: prNum, limit: 5 });
  const runWithBranch = runs.find((r) => r.branch && r.project === params.project);
  if (runWithBranch?.branch) {
    console.log(
      `[${logPrefix}] resolved targetBranch=${runWithBranch.branch} for ${params.ticketOrPr} via run-store (run ${runWithBranch.id.slice(0, 8)})`,
    );
    return runWithBranch.branch;
  }

  try {
    const { getPRRawData } = await import('../pr/raw-cache.js');
    const raw = await getPRRawData(repo, prNum);
    // raw.prStateStdout is tab-separated; headRefName is index 4 by contract.
    const headRefName = raw.prStateStdout.trim().split('\t')[4];
    if (headRefName) {
      console.log(
        `[${logPrefix}] resolved targetBranch=${headRefName} for ${params.ticketOrPr} via pr-raw cache`,
      );
      return headRefName;
    }
  } catch (err) {
    console.warn(
      `[${logPrefix}] pr-raw lookup failed for ${params.ticketOrPr}: ${(err as Error).message}`,
    );
  }

  return undefined;
}

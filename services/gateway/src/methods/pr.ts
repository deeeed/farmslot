// methods/pr.ts — pr.status, pr.list, pr.monitor, pr.forSlot
// All gh calls route through github-client.ghRequest (concurrency + ETag + quota).

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';

import {
  computePRRecommendation,
  DEFAULT_BRANCH,
  derivePRMergeState,
  isSlotRefreshStaleBranch,
  isTerminalRunStatus,
  type PRForSlotParams,
  type PRForSlotResult,
  type PRListParams,
  type PRListResult,
  type ProjectCICheckGroup,
  type PRStatus,
  type PRStatusParams,
  type PRStatusResult,
  type Run,
  type ScriptActionResult,
  type ScriptComplete,
  type ScriptOutput,
  type SlotStatus,
} from '@farmslot/protocol';

import { isLocal } from '../core/exec.js';
import {
  buildLatestRunByPrNumber,
  findFamilyStateSummaryForPR,
} from '../family-observability/state.js';
import {
  farmslotRoot,
  loadFleetStatus,
  loadPoolConfigs,
  loadProjectConfig,
  loadProjectConfigs,
} from '../fleet/state.js';
import {
  getBinding,
  invalidateBinding,
  setBinding,
} from '../integrations/github-bindings-cache.js';
import { ghRequest } from '../integrations/github-client.js';
import { getAllRuns } from '../runs/store.js';

import {
  getPRRawData,
  parseJsonLines,
  prefetchPRBatchViaGraphQL,
  shouldPrefetchPRRawData,
} from './pr/raw-cache.js';

const execFileAsync = promisify(execFile);

// ─── Internal types ───

/**
 * A (PR number, github owner/name) pair resolved from either the bindings
 * cache, `gh api pulls/N` verification, or a slot-local `gh pr list` fallback.
 */
interface BranchPRBinding {
  pr: number;
  repo: string;
  baseRef?: string;
}

/**
 * One dashboard row before the CI/comment fetch. Collected from active slots
 * and known runs; `repo` is carried through when resolved up-front (e.g. via
 * the slot-local `git remote` fallback for projects without `ci.repo`) so
 * fetchPRData doesn't have to re-resolve it and fail.
 */
interface PRDashboardEntry {
  slot: string;
  project: string;
  workerActive: boolean;
  summary: string | null;
  repo?: string;
}

/**
 * Options for `fetchPRData` — keeps the ~8 positional params named and
 * lets callers pass only what they have.
 */
interface FetchPRDataOptions {
  prNum: number;
  runs: Run[];
  project?: string;
  slot?: string;
  workerActive?: boolean;
  summary?: string | null;
  force?: boolean;
  repoOverride?: string;
}

type EventEmitter = (event: string, payload: unknown) => void;
const MAX_PR_DASHBOARD_CANDIDATES = 200;
const PR_DASHBOARD_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type PrSlotProjectConfig = {
  defaultBranch: string;
  slotTrackingBranch?: string;
};

function slotBranchHasPrLookupContext(
  slot: Pick<SlotStatus, 'branch' | 'project' | 'session' | 'slot' | 'linkedWorktree'>,
  projectConfigs: Readonly<Record<string, PrSlotProjectConfig>>,
): boolean {
  if (!slot.branch || slot.branch === '-') return false;
  const project = projectConfigs[slot.project];
  const defaultBranch = project?.defaultBranch ?? DEFAULT_BRANCH;
  return isSlotRefreshStaleBranch(
    slot.branch,
    {
      defaultBranch,
      slotTrackingBranch: project?.slotTrackingBranch,
    },
    { session: slot.session, slotId: slot.slot, linkedWorktree: slot.linkedWorktree },
  );
}

async function resolveProjectRepo(
  project?: string,
  repoOverride?: string,
): Promise<{ project: string; repo: string }> {
  if (!project) {
    throw new Error('Project is required for PR status lookups.');
  }
  if (repoOverride) return { project, repo: repoOverride };
  const projectConfig = await loadProjectConfig(project);
  const repo = projectConfig?.ci?.repo;
  if (!repo) {
    throw new Error(`Project ${project} has no ci.repo configured.`);
  }
  return { project, repo };
}

// ─── prStatus — native TS ───

export async function prStatus(params: PRStatusParams): Promise<PRStatusResult> {
  const pr = await fetchPRData({
    prNum: params.pr,
    runs: getAllRuns(),
    project: params.project,
    force: params.force,
  });
  return { pr };
}

// ─── prList — native TS ───

export async function prList(params?: PRListParams): Promise<PRListResult> {
  // Discover PRs from active slots + runs
  const fleet = await loadFleetStatus();
  const prInfo = new Map<number, PRDashboardEntry>();

  // Preload runs for summary + active detection
  const runs = getAllRuns();
  const ACTIVE_RUN_STATUSES = new Set([
    'created',
    'grading',
    'writing-task',
    'slot-finding',
    'preparing',
    'dispatching',
    'monitoring',
    'self-reviewing',
    'completing',
    'ci-watching',
  ]);
  // Index: prNumber → most recent run with that PR
  const runByPR = buildLatestRunByPrNumber(runs);
  const projectConfigs = Object.fromEntries(
    (await loadProjectConfigs()).map((p) => [
      p.name,
      {
        defaultBranch: p.defaultBranch || DEFAULT_BRANCH,
        isTerminalRunStatus,
        slotTrackingBranch: p.slotTrackingBranch,
      },
    ]),
  );

  // 1. Active slots on feature branches (worker is active).
  //    Resolve all slot→PR lookups in parallel; ghRequest's own concurrency gate
  //    (8 by default) keeps github load bounded while we avoid an N-slot serial wait.
  const activeSlots = fleet.slots.filter(
    (s) =>
      s.enabled &&
      (s.agent === 'working' || s.lifecycle === 'busy') &&
      slotBranchHasPrLookupContext(s, projectConfigs),
  );
  const slotBindings = await Promise.all(
    activeSlots.map((s) =>
      findPRForBranch(s.branch!, s.project, s.slot).then((found) => ({ slot: s, found })),
    ),
  );
  for (const { slot, found } of slotBindings) {
    if (!found) continue;
    const run = runByPR.get(found.pr);
    prInfo.set(found.pr, {
      slot: slot.slot,
      project: slot.project,
      workerActive: true,
      summary: run?.summary ?? null,
      repo: found.repo,
    });
  }

  // 2. Runs with a known prNumber (catches completed runs, active runs without a slot match).
  //    Skip terminal runs older than PR_DASHBOARD_TERMINAL_TTL_MS — otherwise ancient/closed
  //    PRs pile up and blow the UI 15s timeout via sequential GitHub fetches in step 3.
  const now = Date.now();
  for (const run of runByPR.values()) {
    if (prInfo.size >= MAX_PR_DASHBOARD_CANDIDATES) break;
    if (params?.project && run.project !== params.project) continue;
    if (run.prNumber == null) continue;
    if (prInfo.has(run.prNumber)) continue;
    if (isTerminalRunStatus(run.status)) {
      const freshness = run.completedAt ?? run.updatedAt;
      const ageMs = freshness ? now - Date.parse(freshness) : Infinity;
      if (!Number.isFinite(ageMs) || ageMs > PR_DASHBOARD_TERMINAL_TTL_MS) continue;
    }
    prInfo.set(run.prNumber, {
      slot: run.slotId ?? '',
      project: run.project,
      workerActive: ACTIVE_RUN_STATUSES.has(run.status),
      summary: run.summary ?? null,
      repo: await resolveRepoForRun(run),
    });
  }

  if (prInfo.size === 0) {
    return { prs: [] };
  }

  // ADR-028: collapse the per-PR REST fan-out into one aliased GraphQL request
  // per repo. Synthesized snapshots seed `prRawCache`, so the fetchPRData loop
  // below becomes cache-hits. On any per-chunk failure the affected PRs simply
  // aren't seeded → REST fan-out kicks in for them. Skip PRs that already have
  // a fresh cache entry — GitHub's GraphQL API doesn't honor If-None-Match, so
  // refetching a cached PR within the 60s TTL would just burn quota. Also skip
  // PRs with an inflight per-PR REST fetch (e.g. a concurrent pr.status from
  // the slot view): the inflight call will write a fresh snapshot and the batch
  // overwrite would just waste both REST and GraphQL quota.
  const prefetchNow = Date.now();
  const prsByRepo = new Map<string, number[]>();
  for (const [prNum, info] of prInfo) {
    const repo = info.repo ?? (await loadProjectConfig(info.project))?.ci?.repo;
    if (!repo) continue;
    if (!shouldPrefetchPRRawData(repo, prNum, prefetchNow)) continue;
    const list = prsByRepo.get(repo);
    if (list) list.push(prNum);
    else prsByRepo.set(repo, [prNum]);
  }
  try {
    await prefetchPRBatchViaGraphQL(prsByRepo);
  } catch (err) {
    console.warn(
      `[pr.batch] prefetch_failed err=${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
    );
  }

  // Fetch all PRs in parallel
  const prs = await Promise.all(
    Array.from(prInfo.entries()).map(async ([prNum, info]) => {
      try {
        return await fetchPRData({
          prNum,
          runs,
          project: info.project,
          slot: info.slot,
          workerActive: info.workerActive,
          summary: info.summary,
          repoOverride: info.repo,
        });
      } catch {
        return null;
      }
    }),
  );

  let result = prs.filter((p): p is PRStatus => p !== null);
  result = result.filter(shouldIncludePRInDashboard);
  if (params?.project) {
    // Match on the PR's resolved project (PRStatus.project), not repo slug.
    // Projects whose internal name differs from their GitHub owner/name
    // (e.g. my-app-farm → owner/my-app) would drop out of the
    // project-filtered dashboard if we substring-matched on repo.
    result = result.filter((p) => p.project === params.project);
  }
  return { prs: result };
}

// ─── Core PR fetch logic ───

async function fetchPRData(opts: FetchPRDataOptions): Promise<PRStatus> {
  const { prNum, runs, project, slot, workerActive, summary, force, repoOverride } = opts;
  const { project: resolvedProject, repo: ghRepo } = await resolveProjectRepo(
    project,
    repoOverride,
  );
  const projectConfig = await loadProjectConfig(resolvedProject);

  // Raw GitHub data is served from the 60s cache (see getPRRawData) so repeated
  // callers in the same minute — UI polls, ci-monitor tick, pr.list refetch —
  // share one network round-trip. force=true bypasses both caches.
  const raw = await getPRRawData(ghRepo, prNum, force);

  // Parse checks
  const checkGroups = projectConfig?.ci?.checkGroups ?? [];
  const botPatterns = projectConfig?.ci?.botPatterns ?? [];

  const allChecks = parseChecksOutput(raw.checksStdout);
  const allCheckRollup = summarizeAllChecks(allChecks);
  const watched = matchCheckGroups(allChecks, checkGroups);
  const passed = watched.filter((w) => w.status === 'pass');
  const failed = watched.filter((w) => w.status === 'fail');
  const skipped = watched.filter((w) => w.status === 'skipped');
  const pending = watched.filter((w) => w.status === 'pending' || w.status === 'not_found');

  // Parse PR state
  const prStateParts = raw.prStateStdout.trim().split('\t');
  const [
    prState,
    mergeable,
    _mergeStateStatus,
    reviewDecision,
    headRefName,
    createdAt,
    updatedAt,
    closedAt,
    mergedAt,
  ] = prStateParts;
  const prTitle = prStateParts.slice(9).join('\t') || `PR #${prNum}`;

  // Parse comments
  const issueComments = parseJsonLines(raw.commentsStdout);
  const reviewComments = parseJsonLines(raw.reviewCommentsStdout);
  const latestCommit = raw.latestCommitStdout.trim() || null;

  // Build replied IDs set (review comments that have human replies)
  const repliedIds = new Set<number>();
  for (const rc of reviewComments) {
    if (
      typeof rc.in_reply_to_id === 'number' &&
      !botPatterns.some((bp) => new RegExp(bp.author, 'i').test(rc.author ?? ''))
    ) {
      repliedIds.add(rc.in_reply_to_id);
    }
  }

  // Match bot patterns
  const botComments = matchBotComments(
    issueComments,
    reviewComments,
    botPatterns,
    repliedIds,
    latestCommit,
  );
  const actionable = botComments.filter((bc) => !bc.workerResponded && bc.action !== 'alert_only');

  // Recommendation. Path-skipped jobs must not block: allPassed asserts when
  // nothing failed or is still running and at least one watched check passed.
  const allPassed = failed.length === 0 && pending.length === 0 && passed.length > 0;
  const anyFailed = failed.length > 0;
  const merged = prState === 'MERGED';
  const mergeConflict = mergeable === 'CONFLICTING';
  const familyContext = derivePRFamilyContext(runs, prNum, resolvedProject);
  const ownedFamilyContext = familyContext?.ownedPrFamily ? familyContext : null;

  const approved = reviewDecision === 'APPROVED';
  const recommendation = computePRRecommendation({
    prState: (prState as 'OPEN' | 'CLOSED' | 'MERGED') || 'OPEN',
    workerActive: Boolean(workerActive),
    anyFailed,
    mergeConflict,
    actionableCount: actionable.length,
    allPassed,
    approved,
    familyContext: ownedFamilyContext,
  });
  const mergeState = derivePRMergeState({
    prState: (prState as 'OPEN' | 'CLOSED' | 'MERGED') || 'OPEN',
    familyContext: ownedFamilyContext,
    anyFailed,
    mergeConflict,
    actionableCount: actionable.length,
    allPassed,
    approved,
  });
  const workflowState = ownedFamilyContext?.workflowState;

  return {
    pr: prNum,
    title: prTitle,
    summary: summary ?? null,
    repo: ghRepo,
    headRef: headRefName && headRefName !== '' ? headRefName : null,
    project: resolvedProject,
    slot: slot ?? null,
    session: null,
    checks: watched.map((w) => ({
      name: w.name,
      status: w.status === 'not_found' ? ('pending' as const) : w.status,
      watchName: w.watchName,
    })),
    checkSummary: {
      passed: passed.length,
      failed: failed.length,
      pending: pending.length,
      skipped: skipped.length,
      total: watched.length,
    },
    allCheckSummary: allCheckRollup.summary,
    allPendingNames: allCheckRollup.pendingNames,
    allFailedNames: allCheckRollup.failedNames,
    allPassed,
    anyFailed,
    failedNames: failed.map((w) => w.watchName),
    botComments: botComments.map(toBotComment),
    actionableBotComments: actionable.map(toBotComment),
    prState: (prState as 'OPEN' | 'CLOSED' | 'MERGED') || 'OPEN',
    createdAt: createdAt || null,
    updatedAt: updatedAt || null,
    closedAt: closedAt || null,
    mergedAt: mergedAt || null,
    merged,
    mergeable: mergeable || 'UNKNOWN',
    mergeConflict,
    reviewDecision: reviewDecision || '',
    recommendation,
    workerActive: Boolean(workerActive),
    ownedFamily: Boolean(ownedFamilyContext),
    familyId: ownedFamilyContext?.familyId ?? null,
    familyRootTicketOrPr: ownedFamilyContext?.familyRootTicketOrPr ?? null,
    familyRunCount: ownedFamilyContext?.familyRunCount,
    activeFamilyRunCount: ownedFamilyContext?.activeRunCount,
    workflowState,
    mergeState,
    latestRunId: ownedFamilyContext?.latestRunId ?? null,
  };
}

type PRFamilyContext = NonNullable<ReturnType<typeof findFamilyStateSummaryForPR>>;

export function derivePRFamilyContext(
  runs: Run[],
  prNum: number,
  project: string,
): PRFamilyContext | null {
  return findFamilyStateSummaryForPR(runs, { prNumber: prNum, project });
}

// isPassiveMergeWaitCandidate, derivePRMergeState, computePRRecommendation
// moved to @farmslot/protocol (contracts/pr-recommendation.ts); re-exported
// from there via @farmslot/protocol for backward compatibility with callers
// that imported them from './pr.js'.
export {
  computePRRecommendation,
  derivePRMergeState,
  isPassiveMergeWaitCandidate,
} from '@farmslot/protocol';

export function shouldIncludePRInDashboard(pr: PRStatus): boolean {
  return pr.prState === 'OPEN' || Boolean(pr.ownedFamily);
}

// ─── Helpers ───

interface ParsedCheck {
  name: string;
  status: string;
  startedAt: string;
  completedAt: string;
  index: number;
}

interface MatchedCheckGroup {
  name: string;
  status: 'pass' | 'fail' | 'pending' | 'skipped' | 'not_found';
  watchName: string;
}

function parseChecksOutput(output: string): ParsedCheck[] {
  const checks: ParsedCheck[] = [];
  let index = 0;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length >= 2) {
      checks.push({
        name: parts[0].trim(),
        status: parts[1].trim().toLowerCase(),
        startedAt: parts[2]?.trim() ?? '',
        completedAt: parts[3]?.trim() ?? '',
        index: index++,
      });
    }
  }
  return checks;
}

function normalizeFullCheckStatus(status: string): 'pass' | 'fail' | 'pending' | 'skipped' {
  switch (status) {
    case 'pass':
    case 'success':
      return 'pass';
    case 'fail':
    case 'failure':
    case 'cancel':
    case 'cancelled':
      return 'fail';
    case 'skip':
    case 'skipped':
    case 'skipping':
      return 'skipped';
    default:
      return 'pending';
  }
}

export function summarizeAllChecks(allChecks: ParsedCheck[]): {
  summary: { passed: number; failed: number; pending: number; skipped: number; total: number };
  pendingNames: string[];
  failedNames: string[];
} {
  const summary = { passed: 0, failed: 0, pending: 0, skipped: 0, total: allChecks.length };
  const pendingNames: string[] = [];
  const failedNames: string[] = [];

  for (const check of allChecks) {
    const status = normalizeFullCheckStatus(check.status);
    if (status === 'pass') summary.passed++;
    else if (status === 'fail') {
      summary.failed++;
      failedNames.push(check.name);
    } else if (status === 'skipped') summary.skipped++;
    else {
      summary.pending++;
      pendingNames.push(check.name);
    }
  }

  return { summary, pendingNames, failedNames };
}

function compareCheckRecency(a: ParsedCheck, b: ParsedCheck): number {
  const aStamp = a.completedAt || a.startedAt;
  const bStamp = b.completedAt || b.startedAt;
  if (aStamp !== bStamp) return aStamp.localeCompare(bStamp);
  return a.index - b.index;
}

function compileGroupMatcher(group: ProjectCICheckGroup): (check: ParsedCheck) => boolean {
  switch (group.matchMode) {
    case 'exact':
      return (check) => check.name === group.match;
    case 'regex': {
      let pattern: RegExp;
      try {
        pattern = new RegExp(group.match, 'i');
      } catch {
        return () => false;
      }
      return (check) => pattern.test(check.name);
    }
    case 'includes':
    default: {
      const needle = group.match.toLowerCase();
      return (check) => check.name.toLowerCase().includes(needle);
    }
  }
}

export function matchCheckGroups(
  allChecks: ParsedCheck[],
  checkGroups: ProjectCICheckGroup[],
): MatchedCheckGroup[] {
  if (checkGroups.length === 0) {
    return allChecks.map((check) => ({
      name: check.name,
      status: normalizeFullCheckStatus(check.status),
      watchName: check.name,
    }));
  }

  const watched: MatchedCheckGroup[] = [];
  for (const group of checkGroups) {
    const matcher = compileGroupMatcher(group);
    const matches = allChecks.filter(matcher);
    if (matches.length === 0) {
      watched.push({ name: group.name, watchName: group.name, status: 'not_found' });
      continue;
    }

    if (group.aggregate === 'latest') {
      const latest = matches.reduce((current, candidate) =>
        compareCheckRecency(current, candidate) >= 0 ? current : candidate,
      );
      watched.push({
        name: latest.name,
        watchName: group.name,
        status: normalizeFullCheckStatus(latest.status),
      });
      continue;
    }

    // Skipped shards are neutral in aggregates: they never satisfy a group on
    // their own, but must not hold a group pending (path-filtered jobs skip).
    const normalized = matches.map((match) => normalizeFullCheckStatus(match.status));
    const displayName = matches.length === 1 ? matches[0].name : group.name;
    if (group.aggregate === 'any') {
      const status = normalized.includes('pass')
        ? 'pass'
        : normalized.includes('pending')
          ? 'pending'
          : normalized.includes('fail')
            ? 'fail'
            : 'skipped';
      watched.push({ name: displayName, watchName: group.name, status });
      continue;
    }

    const status = normalized.includes('fail')
      ? 'fail'
      : normalized.includes('pending')
        ? 'pending'
        : normalized.includes('pass')
          ? 'pass'
          : 'skipped';
    watched.push({ name: displayName, watchName: group.name, status });
  }
  return watched;
}

interface BotCommentInternal {
  author: string;
  label: string;
  action: string;
  bodyPreview: string;
  createdAt: string;
  source: string;
  workerResponded: boolean;
}

interface BotPattern {
  author: string;
  label: string;
  defaultAction: 'nudge_worker' | 'alert_only';
  actions?: Array<{ bodyMatch: string; action: 'nudge_worker' | 'alert_only'; label?: string }>;
}

// Opt-in action resolution: a comment defaults to the pattern's defaultAction
// (usually alert_only so benign noise doesn't block merge). Each actions[]
// entry is a body-signature regex that escalates a specific payload to a
// different action — e.g. "CODEOWNER review" → nudge_worker. First match wins.
export function resolveCommentAction(
  pattern: BotPattern,
  body: string,
): { action: string; label: string } {
  if (pattern.actions) {
    for (const a of pattern.actions) {
      if (new RegExp(a.bodyMatch, 'i').test(body)) {
        return { action: a.action, label: a.label ?? pattern.label };
      }
    }
  }
  return { action: pattern.defaultAction, label: pattern.label };
}

export function matchBotComments(
  issueComments: Array<Record<string, any>>,
  reviewComments: Array<Record<string, any>>,
  botPatterns: BotPattern[],
  repliedIds: Set<number>,
  latestCommit: string | null,
): BotCommentInternal[] {
  const result: BotCommentInternal[] = [];

  for (const c of issueComments) {
    for (const bp of botPatterns) {
      if (!new RegExp(bp.author, 'i').test(c.author)) continue;
      const { action, label } = resolveCommentAction(bp, c.body || '');
      result.push({
        author: c.author,
        label,
        action,
        bodyPreview: (c.body || '').slice(0, 200),
        createdAt: c.created_at || '',
        source: 'issue_comment',
        workerResponded: !!(latestCommit && c.created_at < latestCommit),
      });
      break;
    }
  }

  for (const rc of reviewComments) {
    if (rc.in_reply_to_id) continue; // skip replies
    for (const bp of botPatterns) {
      if (!new RegExp(bp.author, 'i').test(rc.author)) continue;
      const { action, label } = resolveCommentAction(bp, rc.body || '');
      result.push({
        author: rc.author,
        label,
        action,
        bodyPreview: (rc.body || '').slice(0, 200),
        createdAt: rc.created_at || '',
        source: 'review_comment',
        // Review comments should stay actionable until the thread is explicitly
        // replied to. A later commit alone is too coarse — it can hide fresh
        // bugbot findings that were never acknowledged in-thread.
        workerResponded: repliedIds.has(rc.id),
      });
      break;
    }
  }

  return result;
}

function toBotComment(bc: BotCommentInternal) {
  return {
    author: bc.author,
    label: bc.label,
    action: bc.action,
    bodyPreview: bc.bodyPreview,
    createdAt: bc.createdAt,
    source: bc.source,
    workerResponded: bc.workerResponded,
  };
}

async function findPRForBranch(
  branch: string,
  project: string,
  slotId?: string,
): Promise<BranchPRBinding | null> {
  const projectConfig = await loadProjectConfig(project);
  const repo = projectConfig?.ci?.repo;
  // Fallback for projects that only define their GitHub remote in the slot's
  // repo checkout (no ci.repo in project.json). Use `gh pr list` inside the
  // slot's working tree — no ETag cache, but correct results.
  if (!repo) {
    if (!slotId) return null;
    return findPRViaSlotRepo(slotId, branch);
  }
  const cached = getBinding(branch, repo);
  if (cached !== null) {
    // Branch names are deterministic (buildSmartBranch), so a reused branch can
    // keep pointing at an old merged/closed PR. Verify state+head before trust.
    try {
      const verify = await ghRequest([
        'api',
        `repos/${repo}/pulls/${cached}`,
        '--jq',
        '{state:.state,head:.head.ref}',
      ]);
      const parsed = JSON.parse(verify.stdout || '{}') as { state?: string; head?: string };
      if (parsed.state === 'open' && parsed.head === branch) return { pr: cached, repo };
      invalidateBinding(branch, repo);
    } catch {
      invalidateBinding(branch, repo);
    }
  }
  try {
    const { stdout } = await ghRequest([
      'pr',
      'list',
      '--repo',
      repo,
      '--head',
      branch,
      '--json',
      'number',
      '--jq',
      '.[0].number',
    ]);
    const num = parseInt(stdout.trim(), 10);
    if (isNaN(num)) return null;
    setBinding(branch, repo, num);
    return { pr: num, repo };
  } catch {
    return null;
  }
}

// Locate a slot's on-disk repo path from the pool configs.
// Expand a leading `~` using the gateway process's home dir. Remote slots are
// rejected before reaching this helper, so the gateway-local home is correct.
function expandTildePath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return pathJoin(homedir(), p.slice(2));
  return p;
}

// Resolve a slot's local checkout path. Returns null when the slot lives on a
// remote machine (gateway cannot chdir there) or when no repo is configured.
// Pool configs can express local repos three ways — absolute, `~/...`, or
// `.`/`./...`/`../...` relative to the farmslot repo root. The relative form
// (see pool/farmslot-demo.json) mirrors resolveRepoPath in methods/filesystem.ts
// and must resolve against farmslotRoot, otherwise gh falls back to the
// gateway launch cwd and silently misses the PR.
async function findSlotRepoPath(slotId: string): Promise<string | null> {
  const pools = await loadPoolConfigs();
  for (const pool of pools) {
    const slotCfg = pool.slots.find((s) => s.id === slotId);
    if (!slotCfg?.repo) continue;
    if (!isLocal(pool.host, pool.machine)) return null;
    const repo = expandTildePath(slotCfg.repo);
    if (repo === '.' || repo.startsWith('./') || repo.startsWith('../')) {
      return pathResolve(farmslotRoot, repo);
    }
    return repo;
  }
  return null;
}

// Derive the github owner/name from `git remote get-url origin` inside the
// slot's local repo. Returns null if the slot isn't configured or the remote
// isn't a github URL.
async function resolveSlotRepoSlug(slotId: string): Promise<string | null> {
  const repoPath = await findSlotRepoPath(slotId);
  if (!repoPath) return null;
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
    });
    const match = stdout.trim().match(/github\.com[^:/]*[:/](.+?)(?:\.git)?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Runs `gh pr list` inside the slot's local repo so projects without ci.repo
// still resolve their PR. Bypasses ghRequest (no --repo flag, cwd-scoped) and
// pairs the result with the remote-derived slug so callers can skip a second
// resolveProjectRepo lookup.
async function findPRViaSlotRepo(slotId: string, branch: string): Promise<BranchPRBinding | null> {
  const repoPath = await findSlotRepoPath(slotId);
  if (!repoPath) return null;

  const env = { ...process.env };
  delete env.GH_TOKEN;
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'list', '--head', branch, '--json', 'number,baseRefName', '--jq', '.[0]'],
      { cwd: repoPath, env, maxBuffer: 1024 * 1024 },
    );
    const found = JSON.parse(stdout || 'null') as {
      number?: number;
      baseRefName?: string;
    } | null;
    if (!found?.number) return null;
    const slug = await resolveSlotRepoSlug(slotId);
    return {
      pr: found.number,
      repo: slug ?? '',
      ...(found.baseRefName ? { baseRef: found.baseRefName } : {}),
    };
  } catch {
    return null;
  }
}

// When a run belongs to a project without ci.repo, fall back to the slot
// checkout's git remote so fetchPRData can still resolve the owner/name.
async function resolveRepoForRun(run: Run): Promise<string | undefined> {
  const projectCfg = await loadProjectConfig(run.project);
  if (projectCfg?.ci?.repo) return undefined; // fetchPRData will use ci.repo
  if (!run.slotId) return undefined;
  const slug = await resolveSlotRepoSlug(run.slotId);
  return slug ?? undefined;
}

// ─── prMonitor — still uses bash for now ───

export function prMonitor(
  params: PRStatusParams | undefined,
  emit: EventEmitter,
): ScriptActionResult {
  // Import lazily to avoid circular dependency
  const { runScript } = require('../script-runner.js');
  const args = ['--json'];
  if (params?.pr) args.push('--pr', String(params.pr));

  const requestId = runScript({
    script: 'pr-monitor.sh',
    args,
    onOutput(output: ScriptOutput) {
      emit('script.output', output);
    },
    onComplete(result: ScriptComplete) {
      emit('script.complete', result);
    },
  });
  return { requestId };
}

export async function prForSlot(params: PRForSlotParams): Promise<PRForSlotResult> {
  const fleet = await loadFleetStatus();
  const slot = fleet.slots.find((s) => s.slot === params.slotId);
  if (!slot || !slot.branch) {
    return { pr: null, repo: null, baseRef: DEFAULT_BRANCH };
  }
  const projectConfig = await loadProjectConfig(slot.project);
  const defaultBranch = projectConfig?.defaultBranch || DEFAULT_BRANCH;
  const projectConfigs = {
    [slot.project]: {
      defaultBranch,
      isTerminalRunStatus,
      slotTrackingBranch: projectConfig?.slotTrackingBranch,
    },
  };
  if (!slotBranchHasPrLookupContext(slot, projectConfigs)) {
    return { pr: null, repo: null, baseRef: defaultBranch };
  }
  const repo = projectConfig?.ci?.repo ?? null;
  // Project has no ci.repo configured — fall back to `gh pr list` inside the
  // slot's local repo (no ETag cache, but preserves discovery for projects
  // like farmslot that only carry the remote in the slot checkout).
  if (!repo) {
    const fallback = await findPRViaSlotRepo(slot.slot, slot.branch);
    if (!fallback) return { pr: null, repo: null, baseRef: defaultBranch };
    return {
      pr: fallback.pr,
      repo: fallback.repo || null,
      baseRef: fallback.baseRef || defaultBranch,
    };
  }

  const cached = getBinding(slot.branch, repo);
  if (cached !== null) {
    // Reused branch names can keep pointing at a merged/closed PR. Verify
    // state+head before trusting the cache; mirrors `findPRForBranch`.
    try {
      const verify = await ghRequest([
        'api',
        `repos/${repo}/pulls/${cached}`,
        '--jq',
        '{state:.state,head:.head.ref,base:.base.ref}',
      ]);
      const parsed = JSON.parse(verify.stdout || '{}') as {
        state?: string;
        head?: string;
        base?: string;
      };
      if (parsed.state === 'open' && parsed.head === slot.branch) {
        return { pr: cached, repo, baseRef: parsed.base || defaultBranch };
      }
      invalidateBinding(slot.branch, repo);
    } catch {
      invalidateBinding(slot.branch, repo);
    }
  }

  try {
    const { stdout } = await ghRequest([
      'pr',
      'list',
      '--repo',
      repo,
      '--head',
      slot.branch,
      '--json',
      'number,baseRefName',
      '--jq',
      '.[0] | {pr:.number,baseRef:.baseRefName}',
    ]);
    const result = JSON.parse(stdout || '{}') as { pr?: number; baseRef?: string };
    if (!result.pr) return { pr: null, repo, baseRef: defaultBranch };
    setBinding(slot.branch, repo, result.pr);
    return { pr: result.pr, repo, baseRef: result.baseRef || defaultBranch };
  } catch {
    return { pr: null, repo, baseRef: defaultBranch };
  }
}

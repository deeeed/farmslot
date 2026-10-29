// methods/pr.ts — pr.status, pr.list, pr.monitor, pr.forSlot
// All gh calls route through github-client.ghRequest (concurrency + ETag + quota).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';

import {
  ACTIVE_RUN_STATUSES,
  computePRRecommendation,
  DEFAULT_BRANCH,
  derivePRMergeState,
  isSlotRefreshStaleBranch,
  isTerminalRunStatus,
  Methods,
  type MonitoredPRIdentity,
  normalizeCICheckDetail,
  type PRForSlotObservationParams,
  prForSlotObservationParams,
  type PRForSlotParams,
  type PRForSlotResult,
  type PRListParams,
  type PRListResult,
  type ProjectCICheckGroup,
  type ProjectConfig,
  type PRReviewVerdict,
  type PRStatus,
  type PRStatusObservationParams,
  prStatusObservationParams,
  type PRStatusParams,
  type PRStatusResult,
  type Run,
  type ScriptActionResult,
  type ScriptComplete,
  type ScriptOutput,
  type SlotStatus,
} from '@farmslot/protocol';

import { isLocal } from '../core/exec.js';
import { GatewayMethodError } from '../core/method-error.js';
import { findFamilyStateSummaryForPR, sortRunsByFreshness } from '../family-observability/state.js';
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
import {
  githubQueryBudget,
  GitHubQueryBudgetError,
  withGitHubQueryCaller,
} from '../integrations/github-query-budget.js';
import { getAllRuns } from '../runs/store.js';

import { PRDetailCollector, type PRDetailReadInterest } from './pr/detail-collector.js';
import { type PRListClientInterest, servePRList } from './pr/list-cache.js';
import {
  getPRRawData,
  onPRRawObservation,
  parseJsonLines,
  peekRetainedPRRawData,
  prefetchPRBatchViaGraphQL,
  type PRJsonLine,
  type PRRawSnapshot,
  retainPRRawNotFound,
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
  pr: number;
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
  /**
   * Throw when GitHub returned no PR state instead of synthesising a
   * placeholder row. The dashboard list uses this so a GitHub outage cannot
   * overwrite the last known state of a PR with `PR #n` / OPEN defaults.
   */
  rejectIncomplete?: boolean;
  /** Dashboard list may use truncated GraphQL first pages; pr.status must not. */
  allowPartial?: boolean;
  /** Detail-only metadata must not change dashboard list/backoff payloads. */
  includeCheckSnapshot?: boolean;
}

type EventEmitter = (event: string, payload: unknown) => void;
const MAX_PR_DASHBOARD_CANDIDATES = 200;
const PR_DASHBOARD_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const observedSlotBranches = new Map<
  string,
  { project: string; branch: string; found: BranchPRBinding | null }
>();

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
    includeCheckSnapshot: true,
  });
  return { pr };
}

interface PRStatusObservationValue {
  repo: string;
  raw: PRRawSnapshot;
}

function complete(raw: PRRawSnapshot | undefined): raw is PRRawSnapshot {
  return Boolean(raw?.prStateStdout.trim() && !raw.errors?.length && !raw.partial);
}

/**
 * One shared upstream observation per `{ pr, project }`. It keeps the complete raw GitHub read
 * and its source completion time; local run/config facts are projected on every read.
 */
export const prStatusObservation = new PRDetailCollector<
  PRStatusObservationParams,
  PRStatusObservationValue
>({
  method: Methods.PR_STATUS,
  normalize: prStatusObservationParams,
  // Every sample has a new fetch time; only the observed PR bytes decide a change.
  signature: ({ repo, raw }) => JSON.stringify([repo, { ...raw, fetchedAt: undefined }]),
  async fetch({ pr, project }, force) {
    const { repo } = await resolveProjectRepo(project);
    const raw = await getPRRawData(repo, pr, force);
    if (!raw.prStateStdout.trim()) {
      if (PR_GONE_PATTERN.test(raw.prStateError ?? ''))
        throw new GatewayMethodError('NOT_FOUND', `${repo}#${pr} is not visible on GitHub`);
      throw new GatewayMethodError(
        'UPSTREAM_UNAVAILABLE',
        `GitHub returned no state for ${repo}#${pr}`,
      );
    }
    if (raw.errors?.length)
      throw new GatewayMethodError(
        'UPSTREAM_INCOMPLETE',
        `GitHub returned an incomplete observation for ${repo}#${pr}`,
      );
    return { value: { repo, raw }, observedAt: raw.fetchedAt };
  },
  // The dashboard batch, active CI monitoring and restored warm lists already hold these bytes.
  async seed({ pr, project }) {
    const repo = (await loadProjectConfig(project))?.ci?.repo;
    const raw = repo ? peekRetainedPRRawData(repo, pr) : undefined;
    return repo && complete(raw) ? { value: { repo, raw }, observedAt: raw.fetchedAt } : undefined;
  },
});

onPRRawObservation((repo, pr) => {
  const raw = peekRetainedPRRawData(repo, pr);
  if (!complete(raw)) return;
  // Another owner's newer read of the same PR updates this observation without a second fetch.
  prStatusObservation.observe((params, value) =>
    params.pr === pr && value?.repo.toLowerCase() === repo.toLowerCase()
      ? { value: { repo: value.repo, raw }, observedAt: raw.fetchedAt }
      : undefined,
  );
});

/**
 * Gateway-owned `pr.status`. Active CI monitoring keeps calling `prStatus` with its own policy.
 * Readers without observer admission keep the released reply whenever the shared observation
 * cannot answer as current: a placeholder or partial row, never a new error.
 */
export async function readPRStatus(
  params: PRStatusParams,
  interest: PRDetailReadInterest = {},
): Promise<PRStatusResult> {
  const managed = interest.legacyInterest === false;
  let shared: Awaited<ReturnType<typeof prStatusObservation.read>>;
  try {
    shared = await prStatusObservation.read(
      { pr: params.pr, project: params.project },
      { ...interest, force: params.force === true },
    );
  } catch (error) {
    // Configuration and quota failures were already errors for every reader.
    if (managed || !(error instanceof GatewayMethodError)) throw error;
    // The raw cache already holds the attempt just made, so this adds no forced GitHub read.
    return prStatus({ ...params, force: false });
  }
  if (!managed && shared.observation.error) return prStatus({ ...params, force: false });
  const { value, observation } = shared;
  const project = params.project!;
  const pr = projectPRData(
    value.raw,
    { prNum: params.pr, runs: getAllRuns(), project, repo: value.repo, includeCheckSnapshot: true },
    await loadProjectConfig(project),
  );
  return { pr, observation };
}

/** A completed PR command re-collects observed statuses for that PR, bypassing source caches. */
export function refreshPRStatusObservations(repo: string, pr: number): void {
  prStatusObservation.refreshWhere(
    (params, value) => params.pr === pr && value?.repo.toLowerCase() === repo.toLowerCase(),
  );
}

// ─── prList — native TS ───

/**
 * Serve the dashboard list from the gateway's warm copy (see list-cache.ts);
 * the full GitHub fan-out runs cold, on `force`, or in the background once the
 * copy is older than PR_LIST_STALE_MS. Project scoping filters the warm list so
 * every caller shares one fetch.
 */
export type PRListProjector = (
  rows: readonly PRStatus[],
  project?: string,
) => Promise<PRListFetchResult>;

export async function prList(
  params?: PRListParams,
  fetchList: (opts: {
    force?: boolean;
    project?: string;
  }) => Promise<PRListFetchResult> = fetchPRList,
  interest: PRListClientInterest = {},
  projectRows: PRListProjector = projectRetainedPRList,
): Promise<PRListResult> {
  const project = params?.project;
  const served = await servePRList(
    (force) => fetchList({ force, ...(project === undefined ? {} : { project }) }),
    {
      force: params?.force,
      project,
      ...interest,
    },
  );
  const projected = await projectRows(served.prs, project);
  const { truncated: _truncated, ...result } = served;
  const incomplete = projected.failed.length > 0 || projected.truncated;
  return {
    ...result,
    prs: projected.prs.filter((row) => project === undefined || row.project === project),
    ...(incomplete
      ? {
          observation: {
            ...result.observation,
            status: 'stale',
            error: result.observation?.error ?? {
              code: 'UPSTREAM_INCOMPLETE',
              message: 'Some current PR identities have no retained upstream observation',
            },
          },
        }
      : {}),
  };
}

/** Reads only gateway/node-owned local facts and retained raw observations. Never invokes GitHub. */
export async function projectRetainedPRList(
  rows: readonly PRStatus[],
  project?: string,
): Promise<PRListFetchResult> {
  return loadPRList({ project, retained: true, storedRows: rows });
}

/** GitHub says the PR no longer exists or is no longer visible to this token. */
export class PRGoneError extends Error {}

// `gh` reports a missing or invisible PR as `HTTP 404: Not Found (...)`; a bare
// "not found" also appears in DNS/proxy failures, so only the coded forms count.
const PR_GONE_PATTERN = /HTTP 404|Could not resolve to a PullRequest/i;

/**
 * Whether a dashboard fetch should be treated as a GitHub outage rather than a
 * list. No candidate read succeeded, and either some read failed outright or
 * more than one PR "disappeared" at once: GitHub answers 404 for anything a
 * token can no longer see, so mass 404 is lost access, not mass deletion. A
 * single gone PR with nothing else to read is just an empty farm.
 */
export function isListReadOutage(reads: {
  candidates: number;
  failed: number;
  gone: number;
}): boolean {
  if (reads.candidates === 0 || reads.failed + reads.gone < reads.candidates) return false;
  return reads.failed > 0 || reads.gone > 1;
}

/**
 * Map tracked PR identities onto dashboard candidates. Only GitHub PRs in a
 * repo some project declares as `ci.repo` qualify: status fetching needs that
 * project's check groups and bot patterns. Duplicates collapse.
 */
export function trackedPRCandidates(
  identities: readonly MonitoredPRIdentity[],
  projects: readonly Pick<ProjectConfig, 'name' | 'ci'>[],
): Array<{ pr: number; repo: string; project: string }> {
  const projectByRepo = new Map<string, { name: string; repo: string }>();
  for (const project of projects) {
    const repo = project.ci?.repo;
    if (!repo) continue;
    const existing = projectByRepo.get(repo.toLowerCase());
    if (existing) {
      // First project wins; its check groups and bot patterns shape the status.
      console.warn(
        `[pr.list] ${repo} is ci.repo of both ${existing.name} and ${project.name}; tracked PRs use ${existing.name}`,
      );
      continue;
    }
    projectByRepo.set(repo.toLowerCase(), { name: project.name, repo });
  }
  const seen = new Set<string>();
  const out: Array<{ pr: number; repo: string; project: string }> = [];
  for (const identity of identities) {
    if ((identity.host ?? 'github.com').toLowerCase() !== 'github.com') continue;
    const match = projectByRepo.get(identity.repo.toLowerCase());
    if (!match) continue;
    const key = `${match.repo}#${identity.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pr: identity.number, repo: match.repo, project: match.name });
  }
  return out;
}

export interface PRListFetchResult {
  prs: PRStatus[];
  /** True when candidate discovery stopped at MAX_PR_DASHBOARD_CANDIDATES. */
  truncated: boolean;
  /** `repo#pr` keys GitHub could not be read for; callers keep their last known state for them. */
  failed: string[];
}

/**
 * Full GitHub fan-out: discover candidate PRs from slots and runs, then fetch
 * each. `force` re-fetches every candidate from GitHub through the GraphQL
 * batch, bypassing the 60s raw cache; `project` limits run discovery to that
 * project so the candidate cap cannot starve it.
 */
export async function fetchPRList(
  opts: { force?: boolean; project?: string } = {},
): Promise<PRListFetchResult> {
  return withGitHubQueryCaller('pr.list', () => loadPRList(opts));
}

async function loadPRList(
  opts: {
    force?: boolean;
    project?: string;
    retained?: boolean;
    storedRows?: readonly PRStatus[];
  } = {},
): Promise<PRListFetchResult> {
  // Discover PRs from active slots + runs
  const fleet = await loadFleetStatus(false, true);
  // Keyed by `repo#number`: PR numbers repeat across repos, and a farm can
  // track the same number in two of them.
  const prInfo = new Map<string, PRDashboardEntry>();
  const candidateKey = (repo: string | undefined, pr: number) => `${repo ?? ''}#${pr}`;

  // Preload runs for summary + active detection
  const runs = getAllRuns();
  // Index: prNumber → most recent run with that PR
  const runByPR = new Map<string, Run>();
  for (const run of sortRunsByFreshness(runs)) {
    if (run.prNumber == null) continue;
    const key = `${run.project}#${run.prNumber}`;
    if (!runByPR.has(key)) runByPR.set(key, run);
  }
  const projectList = await loadProjectConfigs(true);
  const projectConfigs = Object.fromEntries(
    projectList.map((p) => [
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
      (!opts.project || s.project === opts.project) &&
      (s.agent === 'working' || s.lifecycle === 'busy') &&
      slotBranchHasPrLookupContext(s, projectConfigs),
  );
  const pendingDiscovery: string[] = [];
  const liveSlots = new Set(fleet.slots.map((entry) => entry.slot));
  for (const id of observedSlotBranches.keys())
    if (!liveSlots.has(id)) observedSlotBranches.delete(id);
  const slotBindings = await Promise.all(
    activeSlots.map((s) =>
      (opts.retained
        ? findKnownPRForBranch(s, projectList, opts.storedRows ?? [])
        : findPRForBranch(s.branch!, s.project, s.slot).catch((error: unknown) => {
            if (error instanceof GitHubQueryBudgetError) throw error;
            // Unread, not "no PR": the list stays readable and its observation reports it incomplete.
            console.warn(
              `[pr.list] discovery for ${s.slot} unavailable: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
            );
            return undefined;
          })
      ).then((found) => {
        if (!opts.retained && found !== undefined)
          observedSlotBranches.set(s.slot, {
            project: s.project,
            branch: s.branch!,
            found: found ?? null,
          });
        return { slot: s, found };
      }),
    ),
  );
  for (const { slot, found } of slotBindings) {
    if (found === undefined) pendingDiscovery.push(`slot:${slot.slot}`);
    if (!found) continue;
    const run = runByPR.get(`${slot.project}#${found.pr}`);
    prInfo.set(candidateKey(found.repo, found.pr), {
      pr: found.pr,
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
    if (opts.project && run.project !== opts.project) continue;
    if (run.prNumber == null) continue;
    if (isTerminalRunStatus(run.status)) {
      const freshness = run.completedAt ?? run.updatedAt;
      const ageMs = freshness ? now - Date.parse(freshness) : Infinity;
      if (!Number.isFinite(ageMs) || ageMs > PR_DASHBOARD_TERMINAL_TTL_MS) continue;
    }
    // resolveRepoForRun returns undefined when the project declares ci.repo
    // (fetchPRData resolves it later); the key needs the repo now.
    const repo = (await resolveRepoForRun(run)) ?? (await loadProjectConfig(run.project))?.ci?.repo;
    const key = candidateKey(repo, run.prNumber);
    if (prInfo.has(key)) continue;
    prInfo.set(key, {
      pr: run.prNumber,
      slot: run.slotId ?? '',
      project: run.project,
      workerActive: ACTIVE_RUN_STATUSES.includes(run.status),
      summary: run.summary ?? null,
      repo,
    });
  }

  // 3. PRs the operator tracks without a run: review-rule intents and monitors.
  //    They get the same status and column placement as run-owned PRs instead
  //    of a bare "tracked" row. Dynamic imports keep pr.ts out of the
  //    rules/monitoring module graph, which already imports this file.
  {
    const [{ listActiveReviewPRs }, { listActiveMonitoredPRs }] = await Promise.all([
      import('./pr-rules.js'),
      import('./pr-watch.js'),
    ]);
    for (const candidate of trackedPRCandidates(
      [...listActiveReviewPRs(), ...listActiveMonitoredPRs()],
      projectList,
    )) {
      if (prInfo.size >= MAX_PR_DASHBOARD_CANDIDATES) break;
      if (opts.project && candidate.project !== opts.project) continue;
      const key = candidateKey(candidate.repo, candidate.pr);
      if (prInfo.has(key)) continue;
      prInfo.set(key, {
        pr: candidate.pr,
        slot: '',
        project: candidate.project,
        workerActive: false,
        summary: null,
        repo: candidate.repo,
      });
    }
  }

  // Slots alone can fill the cap too, so decide after both discovery passes.
  const truncated = prInfo.size >= MAX_PR_DASHBOARD_CANDIDATES;
  if (prInfo.size === 0) return { prs: [], truncated, failed: pendingDiscovery };

  // ADR-028: collapse the per-PR REST fan-out into one aliased GraphQL request
  // per repo. Synthesized snapshots seed `prRawCache`, so the fetchPRData loop
  // below becomes cache-hits. On any per-chunk failure the affected PRs simply
  // aren't seeded → REST fan-out kicks in for them. Skip PRs that already have
  // a fresh cache entry — GitHub's GraphQL API doesn't honor If-None-Match, so
  // refetching a cached PR within the 60s TTL would just burn quota. Also skip
  // PRs with an inflight per-PR REST fetch (e.g. a concurrent pr.status from
  // the slot view): the inflight call will write a fresh snapshot and the batch
  // overwrite would just waste both REST and GraphQL quota. `force` (operator
  // Refresh) prefetches every candidate so the answer is what GitHub says now;
  // the fetchPRData loop then reads those fresh snapshots without its own
  // force, which would discard them and fan out over REST a second time.
  let seeded = new Set<string>();
  if (!opts.retained) {
    const prefetchNow = Date.now();
    const prsByRepo = new Map<string, number[]>();
    for (const info of prInfo.values()) {
      const repo = info.repo ?? (await loadProjectConfig(info.project))?.ci?.repo;
      if (!repo) continue;
      info.repo = repo;
      if (!opts.force && !shouldPrefetchPRRawData(repo, info.pr, prefetchNow)) continue;
      const list = prsByRepo.get(repo);
      if (list) list.push(info.pr);
      else prsByRepo.set(repo, [info.pr]);
    }
    try {
      seeded = await withGitHubQueryCaller('pr.list:prefetch', () =>
        prefetchPRBatchViaGraphQL(prsByRepo),
      );
    } catch (err) {
      if (err instanceof GitHubQueryBudgetError) throw err;
      console.warn(
        `[pr.batch] prefetch_failed err=${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      );
    }
    const spend = githubQueryBudget.spendSnapshot();
    if (spend.hourQueries > 0 || (spend.remaining !== null && spend.remaining < 100)) {
      console.log(
        `[github-query-spend] hourCost=${spend.hourCost} hourQueries=${spend.hourQueries} remaining=${spend.remaining ?? 'n/a'} top=${
          spend.callers
            .slice(0, 4)
            .map((row) => `${row.caller}:${row.cost}/${row.queries}`)
            .join(',') || 'none'
        }`,
      );
    }
  }

  // Fetch all PRs in parallel. Under `force`, a PR the batch did not fully
  // seed (failed chunk, or truncated first page) still has to reach GitHub.
  const failed: string[] = [...pendingDiscovery];
  let gone = 0;
  const absent: Array<{ repo: string; pr: number }> = [];
  const prs = await Promise.all(
    Array.from(prInfo.values()).map(async (info) => {
      const prNum = info.pr;
      try {
        if (opts.retained) {
          if (!info.repo) throw new Error('No retained repository identity');
          const raw = peekRetainedPRRawData(info.repo, prNum);
          if (!raw) throw new Error('No retained upstream observation');
          return projectPRData(
            raw,
            {
              prNum,
              runs,
              project: info.project,
              repo: info.repo,
              slot: info.slot,
              workerActive: info.workerActive,
              summary: info.summary,
              rejectIncomplete: true,
            },
            await loadProjectConfig(info.project),
          );
        }
        return await fetchPRData({
          prNum,
          runs,
          project: info.project,
          slot: info.slot,
          workerActive: info.workerActive,
          summary: info.summary,
          repoOverride: info.repo,
          force: opts.force === true && !seeded.has(`${info.repo}#${prNum}`),
          rejectIncomplete: true,
          allowPartial: false,
        });
      } catch (error) {
        if (error instanceof GitHubQueryBudgetError) throw error;
        if (error instanceof PRGoneError) {
          // Deleted or no longer visible: drop the row, do not carry it.
          gone += 1;
          if (info.repo) absent.push({ repo: info.repo, pr: prNum });
          if (!opts.retained) console.warn(`[pr.list] ${error.message}`);
          return null;
        }
        failed.push(`${info.repo}#${prNum}`);
        if (!opts.retained)
          console.warn(
            `[pr.list] ${info.repo}#${prNum} unavailable: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
          );
        return null;
      }
    }),
  );
  // Pending slot discovery is reported as incomplete; only candidate reads decide an outage.
  const candidateFailures = failed.length - pendingDiscovery.length;
  if (
    !opts.retained &&
    isListReadOutage({ candidates: prInfo.size, failed: candidateFailures, gone })
  )
    throw new Error(
      `GitHub unavailable: ${candidateFailures} of ${prInfo.size} PR reads failed and ${gone} returned 404`,
    );

  if (!opts.retained)
    for (const identity of absent) retainPRRawNotFound(identity.repo, identity.pr);
  return {
    prs: prs.filter((p): p is PRStatus => p !== null).filter(shouldIncludePRInDashboard),
    truncated,
    failed,
  };
}

// ─── Core PR fetch logic ───

export interface PRDataProjectionConfig {
  ci: Pick<ProjectConfig['ci'], 'checkGroups' | 'botPatterns'>;
}

export interface PRDataProjectionOptions {
  prNum: number;
  runs: Run[];
  project: string;
  repo: string;
  slot?: string;
  workerActive?: boolean;
  summary?: string | null;
  rejectIncomplete?: boolean;
  includeCheckSnapshot?: boolean;
}

async function fetchPRData(opts: FetchPRDataOptions): Promise<PRStatus> {
  const { project, repo } = await resolveProjectRepo(opts.project, opts.repoOverride);
  const config = await loadProjectConfig(project);
  const raw = await getPRRawData(repo, opts.prNum, opts.force, { allowPartial: opts.allowPartial });
  return projectPRData(raw, { ...opts, project, repo }, config);
}

/** Pure projection of already observed upstream bytes and the current local ownership facts. */
export function projectPRData(
  raw: PRRawSnapshot,
  opts: PRDataProjectionOptions,
  projectConfig: PRDataProjectionConfig | null,
): PRStatus {
  const {
    prNum,
    runs,
    project: resolvedProject,
    repo: ghRepo,
    slot,
    workerActive,
    summary,
    rejectIncomplete,
  } = opts;
  if (rejectIncomplete && raw.prStateStdout.trim() === '') {
    const why = raw.prStateError ?? 'empty response';
    if (PR_GONE_PATTERN.test(why))
      throw new PRGoneError(`${ghRepo}#${prNum} is gone: ${why.slice(0, 120)}`);
    throw new Error(`GitHub returned no state for ${ghRepo}#${prNum}: ${why.slice(0, 120)}`);
  }
  if (rejectIncomplete && raw.errors?.length)
    throw new Error(
      `GitHub returned an incomplete observation for ${ghRepo}#${prNum}: ${raw.errors.join('; ').slice(0, 200)}`,
    );

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
  const reviewMeta = summarizeReviewMeta(parseJsonLines(raw.reviewMetaStdout), latestCommit);

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
  const changesRequested = reviewDecision === 'CHANGES_REQUESTED';
  const recommendation = computePRRecommendation({
    prState: (prState as 'OPEN' | 'CLOSED' | 'MERGED') || 'OPEN',
    workerActive: Boolean(workerActive),
    anyFailed,
    mergeConflict,
    actionableCount: actionable.length,
    allPassed,
    approved,
    changesRequested,
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
    author: raw.author,
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
    ...(opts.includeCheckSnapshot && raw.checksAvailable && !raw.partial
      ? {
          checkSnapshot: {
            pr: prNum,
            repo: ghRepo,
            fetchedAt: new Date(raw.fetchedAt).toISOString(),
            checks: allChecks.map(normalizeCICheckDetail),
          },
        }
      : {}),
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
    reviewVerdicts: reviewMeta.reviewVerdicts,
    reviewRequests: reviewMeta.reviewRequests,
    pushedAfterChangesRequested: reviewMeta.pushedAfterChangesRequested,
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

/**
 * Fold the review-meta JSON lines into what the dashboard shows: each
 * reviewer's standing verdict, outstanding requests, and whether the author
 * pushed after the newest CHANGES_REQUESTED verdict (a later APPROVED or a
 * dismissal from that reviewer replaces it upstream, so it is not listed).
 */
export function summarizeReviewMeta(
  lines: readonly PRJsonLine[],
  latestCommitAt: string | null,
): {
  reviewVerdicts: PRReviewVerdict[];
  reviewRequests: { teams: string[]; users: string[] };
  pushedAfterChangesRequested: boolean;
} {
  const reviewVerdicts: PRReviewVerdict[] = [];
  const teams: string[] = [];
  const users: string[] = [];
  for (const line of lines) {
    if (line.t === 'review' && typeof line.author === 'string' && line.author) {
      reviewVerdicts.push({
        reviewer: line.author,
        state: typeof line.state === 'string' ? line.state : '',
        submittedAt: typeof line.submittedAt === 'string' ? line.submittedAt : null,
      });
    } else if (line.t === 'request' && typeof line.name === 'string' && line.name) {
      (line.kind === 'team' ? teams : users).push(line.name);
    }
  }
  const commitAt = latestCommitAt ? Date.parse(latestCommitAt) : NaN;
  const newestChangesRequested = reviewVerdicts
    .filter((review) => review.state === 'CHANGES_REQUESTED' && review.submittedAt)
    .map((review) => Date.parse(review.submittedAt!))
    .filter(Number.isFinite)
    .reduce((max, at) => Math.max(max, at), Number.NEGATIVE_INFINITY);
  return {
    reviewVerdicts,
    reviewRequests: { teams, users },
    pushedAfterChangesRequested:
      Number.isFinite(commitAt) &&
      Number.isFinite(newestChangesRequested) &&
      commitAt > newestChangesRequested,
  };
}

export function shouldIncludePRInDashboard(pr: PRStatus): boolean {
  return pr.prState === 'OPEN' || Boolean(pr.ownedFamily);
}

// ─── Helpers ───

interface ParsedCheck {
  name: string;
  status: string;
  startedAt: string;
  completedAt: string;
  state?: string;
  detailsUrl?: string;
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
        state: parts[4]?.trim(),
        detailsUrl: parts[5]?.trim(),
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
  bodyFingerprint: string;
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
        bodyFingerprint: createHash('sha256')
          .update(c.body || '')
          .digest('hex'),
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
        bodyFingerprint: createHash('sha256')
          .update(rc.body || '')
          .digest('hex'),
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
    bodyFingerprint: bc.bodyFingerprint,
    createdAt: bc.createdAt,
    source: bc.source,
    workerResponded: bc.workerResponded,
  };
}

async function findKnownPRForBranch(
  slot: SlotStatus,
  projects: readonly ProjectConfig[],
  storedRows: readonly PRStatus[],
): Promise<BranchPRBinding | null | undefined> {
  const observed = observedSlotBranches.get(slot.slot);
  if (observed?.project === slot.project && observed.branch === slot.branch) return observed.found;
  const repo = projects.find((project) => project.name === slot.project)?.ci?.repo;
  const row = storedRows.find(
    (entry) =>
      entry.project === slot.project && entry.slot === slot.slot && entry.headRef === slot.branch,
  );
  const pr = (repo && slot.branch ? getBinding(slot.branch, repo) : null) ?? row?.pr;
  const ghRepo = repo ?? row?.repo;
  if (!pr || !ghRepo) return undefined;
  const raw = peekRetainedPRRawData(ghRepo, pr);
  const [state, , , , head] = raw?.prStateStdout.trim().split('\t') ?? [];
  return state === 'OPEN' && head === slot.branch ? { pr, repo: ghRepo } : null;
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
    return findPRViaSlotRepo(slotId, branch, true);
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
    } catch (error) {
      if (error instanceof GitHubQueryBudgetError) throw error;
      // A failed verification does not make the cached binding current; rediscovery below must succeed.
      invalidateBinding(branch, repo);
    }
  }
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
async function findPRViaSlotRepo(
  slotId: string,
  branch: string,
  collected = false,
): Promise<BranchPRBinding | null> {
  if (collected) {
    const repo = await resolveSlotRepoSlug(slotId);
    if (!repo) throw new Error(`Cannot resolve repository for upstream discovery on ${slotId}`);
    // Passive discovery uses the same concurrency, request sharing and rate-limit owner as PR data.
    const { stdout } = await ghRequest(
      [
        'pr',
        'list',
        '--repo',
        repo,
        '--head',
        branch,
        '--json',
        'number,baseRefName',
        '--jq',
        '.[0]',
      ],
      { caller: 'pr.list:discovery' },
    );
    const found = JSON.parse(stdout || 'null') as { number?: number; baseRefName?: string } | null;
    return found?.number
      ? { pr: found.number, repo, ...(found.baseRefName ? { baseRef: found.baseRefName } : {}) }
      : null;
  }
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

interface SlotPRLookup {
  slotId: string;
  project: string;
  branch: string;
  repo: string | null;
  defaultBranch: string;
}

/** Local slot facts decide whether GitHub is asked at all; this performs no upstream I/O. */
async function slotPRLookup(slotId: string): Promise<SlotPRLookup | PRForSlotResult> {
  const fleet = await loadFleetStatus();
  const slot = fleet.slots.find((s) => s.slot === slotId);
  if (!slot || !slot.branch) {
    return { pr: null, repo: null, baseRef: DEFAULT_BRANCH, source: 'local' };
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
    return { pr: null, repo: null, baseRef: defaultBranch, source: 'local' };
  }
  return {
    slotId: slot.slot,
    project: slot.project,
    branch: slot.branch,
    repo: projectConfig?.ci?.repo ?? null,
    defaultBranch,
  };
}

function slotPRLookupIdentity(lookup: SlotPRLookup): string {
  return JSON.stringify([lookup.project, lookup.branch, lookup.repo, lookup.defaultBranch]);
}

/** A `collected` lookup fails visibly instead of reporting "no PR" for an unreadable upstream. */
async function lookupSlotPR(lookup: SlotPRLookup, collected: boolean): Promise<PRForSlotResult> {
  const { branch, repo, defaultBranch } = lookup;
  // Project has no ci.repo configured — fall back to `gh pr list` inside the
  // slot's local repo (no ETag cache, but preserves discovery for projects
  // like farmslot that only carry the remote in the slot checkout).
  if (!repo) {
    const fallback = await findPRViaSlotRepo(lookup.slotId, branch, collected);
    if (!fallback) return { pr: null, repo: null, baseRef: defaultBranch };
    return {
      pr: fallback.pr,
      repo: fallback.repo || null,
      baseRef: fallback.baseRef || defaultBranch,
    };
  }

  const cached = getBinding(branch, repo);
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
      if (parsed.state === 'open' && parsed.head === branch) {
        return { pr: cached, repo, baseRef: parsed.base || defaultBranch };
      }
      invalidateBinding(branch, repo);
    } catch (error) {
      if (collected && error instanceof GitHubQueryBudgetError) throw error;
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
      'number,baseRefName',
      '--jq',
      '.[0] | {pr:.number,baseRef:.baseRefName}',
    ]);
    const result = JSON.parse(stdout || '{}') as { pr?: number; baseRef?: string };
    if (!result.pr) return { pr: null, repo, baseRef: defaultBranch };
    setBinding(branch, repo, result.pr);
    return { pr: result.pr, repo, baseRef: result.baseRef || defaultBranch };
  } catch (error) {
    if (collected) throw error;
    return { pr: null, repo, baseRef: defaultBranch };
  }
}

export async function prForSlot(params: PRForSlotParams): Promise<PRForSlotResult> {
  const lookup = await slotPRLookup(params.slotId);
  return 'pr' in lookup ? lookup : lookupSlotPR(lookup, false);
}

interface PRForSlotObservationValue {
  /** The local branch context this answer belongs to; `null` when no GitHub lookup applied. */
  lookup: string | null;
  result: PRForSlotResult;
}

/** The open PR for a slot's current branch: a shared upstream observation per `{ slotId }`. */
export const prForSlotObservation = new PRDetailCollector<
  PRForSlotObservationParams,
  PRForSlotObservationValue
>({
  method: Methods.PR_FOR_SLOT,
  normalize: prForSlotObservationParams,
  async fetch({ slotId }) {
    const lookup = await slotPRLookup(slotId);
    return {
      value:
        'pr' in lookup
          ? { lookup: null, result: lookup }
          : { lookup: slotPRLookupIdentity(lookup), result: await lookupSlotPR(lookup, true) },
    };
  },
});

/**
 * Gateway-owned `pr.forSlot`. Slots without a PR lookup context answer from local state alone;
 * otherwise the retained GitHub answer is served only for the slot's current branch context.
 * Readers without observer admission keep the released tolerant lookup when it cannot answer.
 */
export async function readPRForSlot(
  params: PRForSlotParams,
  interest: PRDetailReadInterest = {},
): Promise<PRForSlotResult> {
  const lookup = await slotPRLookup(params.slotId);
  if ('pr' in lookup) return lookup;
  const identity = slotPRLookupIdentity(lookup);
  const managed = interest.legacyInterest === false;
  try {
    const { value, observation } = await prForSlotObservation.read(
      { slotId: params.slotId },
      { ...interest, accept: (current) => current.lookup === identity },
    );
    if (managed || !observation.error) return { ...value.result, observation };
  } catch (error) {
    if (managed) throw error;
  }
  return lookupSlotPR(lookup, false);
}

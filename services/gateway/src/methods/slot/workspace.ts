import {
  DEFAULT_BRANCH,
  type FleetStatus,
  isCompletionPrerequisiteFailure,
  isHeldForResultDecision,
  isTerminalRunStatus,
  type SlotRecovery,
  type SlotStatus,
  type SlotWorkspace,
} from '@farmslot/protocol';
import { isRecord } from '@farmslot/protocol/recipe';

import {
  execOnSlot,
  getProjectField,
  loadProjectVars,
  loadSlotVars,
  type RawProjectJson,
  readSlotRow,
  type SlotVars,
} from '../../core/index.js';
import { readSlotProbe } from '../../core/read-probes.js';
import { shellQuote } from '../../core/tmux.js';
import { setWorkspaceOverlay } from '../../fleet/state.js';
import { GitHubHttpError } from '../../integrations/github-errors.js';
import {
  findActiveGateHeldRunForSlot,
  findGateParkedRunForSlot,
} from '../../run-engine/gate-held-lifecycle.js';
import { getRunWithArchived } from '../../runs/store.js';

import { readMergedPreparePullRequests, refIncludedInMergedPullRequest } from './unmerged-work.js';
import { probeWorkspace } from './workspace-probe.js';

export function recoveryFromRow(row: Readonly<Record<string, unknown>>): SlotRecovery | undefined {
  const recovery = row.workspace_recovery;
  if (
    !isRecord(recovery) ||
    typeof recovery.id !== 'string' ||
    !isRecord(recovery.identity) ||
    !Array.isArray(recovery.completed) ||
    typeof recovery.phase !== 'string'
  )
    return undefined;
  // Internal persisted data is still checked at the boundary, including the identity tuple.
  const { identity, completed, phase } = recovery;
  if (
    typeof identity.epoch !== 'number' ||
    !['branch', 'headSha', 'dirtyFingerprint'].every((key) => typeof identity[key] === 'string') ||
    !['currentRunId', 'cleanupRunId', 'handoffRunId', 'recoveryId'].every(
      (key) => identity[key] === null || typeof identity[key] === 'string',
    )
  )
    return undefined;
  const phases = ['inspect', 'cleanup', 'reset', 'fixtures', 'verify'] as const;
  if (
    !phases.some((value) => value === phase) ||
    !completed.every((item) => phases.some((value) => item === value))
  )
    return undefined;
  return {
    id: recovery.id,
    identity: {
      epoch: identity.epoch,
      branch: String(identity.branch),
      headSha: String(identity.headSha),
      dirtyFingerprint: String(identity.dirtyFingerprint),
      currentRunId: typeof identity.currentRunId === 'string' ? identity.currentRunId : null,
      cleanupRunId: typeof identity.cleanupRunId === 'string' ? identity.cleanupRunId : null,
      handoffRunId: typeof identity.handoffRunId === 'string' ? identity.handoffRunId : null,
      recoveryId: typeof identity.recoveryId === 'string' ? identity.recoveryId : null,
    },
    completed: phases.filter((item) => completed.includes(item)),
    phase: phases.find((item) => item === phase)!,
    ...(typeof recovery.error === 'string' ? { error: recovery.error } : {}),
  };
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

export async function workspaceProtectedReason(
  slotId: string,
  row: Readonly<Record<string, unknown>>,
): Promise<string | undefined> {
  if (findActiveGateHeldRunForSlot(slotId)) return 'Resolve the publication gate before releasing';
  if (findGateParkedRunForSlot(slotId)) return 'Slot retains a parked workspace';
  const owner = text(row.current_run_id);
  if (!owner) return undefined;
  const run = await getRunWithArchived(owner);
  if (!run) return 'The owning run record is missing';
  if (run.status === 'cancelled') return 'Use the owner-bound cancelled-run release action';
  if (isHeldForResultDecision(run) || isCompletionPrerequisiteFailure(run))
    return 'Resolve the owning run result or completion gate';
  if (!isTerminalRunStatus(run.status)) return `Run ${run.id.slice(0, 8)} is still active`;
  return undefined;
}

interface RemoteObservation {
  sha: string | null;
  observedAt: string;
}
const remoteDefaults = new Map<string, { until: number; promise: Promise<RemoteObservation> }>();

async function remoteDefault(
  vars: SlotVars,
  key: string,
  branch: string,
  fresh: boolean,
  timeoutMs: number,
): Promise<RemoteObservation> {
  const cacheKey = `${key}:${branch}`;
  const recoveryBudget = timeoutMs > 5000;
  const cached = remoteDefaults.get(cacheKey);
  if (!fresh && !recoveryBudget && cached && cached.until > Date.now()) return cached.promise;
  const promise = readSlotProbe(
    vars,
    `git -C ${shellQuote(vars.remoteRepo)} ls-remote --heads origin ${shellQuote(`refs/heads/${branch}`)}`,
    fresh || recoveryBudget ? 'workspace-recovery-default' : 'workspace-default',
    timeoutMs,
  ).then((result) => ({
    sha: result.stdout.trim().split(/\s+/)[0] || null,
    observedAt: new Date().toISOString(),
  }));
  if (fresh || recoveryBudget) {
    const observation = await promise;
    remoteDefaults.set(cacheKey, {
      until: Date.now() + 15_000,
      promise: Promise.resolve(observation),
    });
    return observation;
  }
  remoteDefaults.set(cacheKey, { until: Date.now() + 15_000, promise });
  return promise;
}

export async function inspectSlotWorkspace(
  slotId: string,
  options: { fetch?: boolean; network?: boolean; timeoutMs?: number } = {},
): Promise<SlotWorkspace> {
  const vars = await loadSlotVars(slotId);
  const pv = await loadProjectVars(vars.projectName);
  const project: RawProjectJson = pv.projectJson;
  const branch = getProjectField(project, 'default_branch') || DEFAULT_BRANCH;
  const timeoutMs = options.timeoutMs ?? (options.fetch ? 120_000 : 5000);
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  if (options.fetch) {
    const fetched = await execOnSlot(
      vars,
      `${git} fetch --no-tags origin ${shellQuote(`+refs/heads/${branch}:refs/remotes/origin/${branch}`)}`,
      { timeout: 120_000, noRetry: true },
    );
    if (fetched.exitCode !== 0) throw new Error('Cannot fetch the default branch');
  }
  const [probe, row] = await Promise.all([
    probeWorkspace(vars, project, branch, timeoutMs),
    readSlotRow(slotId),
  ]);
  if (!row) throw new Error('Slot status is missing');
  const recovery = recoveryFromRow(row);
  const work: SlotWorkspace = {
    epoch: Number(row.slot_epoch) || 0,
    currentRunId: text(row.current_run_id),
    cleanupRunId: text(row.cleanup_run_id),
    handoffRunId: text(row.handoff_run_id),
    branch: probe.branch,
    headSha: probe.headSha,
    dirtyFingerprint: probe.dirtyFingerprint,
    recoveryId: recovery?.id ?? null,
    observedAt: new Date().toISOString(),
    defaultBranch: branch,
    localDefaultSha: probe.localDefaultSha,
    defaultFetchedAt: probe.defaultFetchedAt,
    remoteDefaultSha: null,
    remoteObservedAt: null,
    behind: probe.behind,
    remoteAdvanced: false,
    publication: 'unknown',
    dirtyCount: probe.dirtyCount,
    unpublishedCount: 0,
    ...(recovery ? { recovery } : {}),
  };
  work.protectedReason = await workspaceProtectedReason(slotId, row);
  work.terminalOwner = !!work.currentRunId && !work.protectedReason;
  const protectedWorkspace =
    work.protectedReason ||
    work.cleanupRunId ||
    work.handoffRunId ||
    row.lifecycle === 'manual' ||
    row.agent === 'working' ||
    (row.lifecycle === 'busy' && !work.terminalOwner && !options.fetch) ||
    (row.phase === 'releasing' && !options.fetch) ||
    (row.lifecycle === 'held' && row.phase === 'occupied' && !work.recovery);
  if (protectedWorkspace) return work;
  if (options.network === false) return work;
  try {
    const remote = await remoteDefault(
      vars,
      probe.originKey,
      branch,
      options.fetch === true,
      timeoutMs,
    );
    work.remoteDefaultSha = remote.sha;
    work.remoteObservedAt = remote.observedAt;
    work.remoteAdvanced = remote.sha !== probe.localDefaultSha;
    if (!remote.sha) return { ...work, error: 'Remote default is unavailable' };
    if (probe.headSha === remote.sha) return { ...work, publication: 'baseline' };
    // Only inspect committed ancestry already present locally; never fetch on a status read.
    const base = options.fetch ? remote.sha : probe.localDefaultSha;
    if (base) {
      const contains = await execOnSlot(
        vars,
        `${git} merge-base --is-ancestor HEAD ${shellQuote(base)}`,
        { timeout: timeoutMs },
      );
      if (contains.exitCode === 0) return { ...work, publication: 'merged' };
      const cherry = await execOnSlot(vars, `${git} cherry ${shellQuote(base)} HEAD`, {
        timeout: timeoutMs,
      });
      if (cherry.exitCode === 0 && cherry.stdout.trim()) {
        const patches = new Set(
          cherry.stdout
            .split('\n')
            .filter((line) => line.startsWith('- '))
            .map((line) => line.slice(2).trim()),
        );
        const commits = await execOnSlot(vars, `${git} rev-list ${shellQuote(`${base}..HEAD`)}`, {
          timeout: timeoutMs,
        });
        // git cherry omits merge commits; an unverified merge resolution is not a merged patch.
        if (
          commits.exitCode === 0 &&
          commits.stdout.trim() &&
          commits.stdout
            .trim()
            .split('\n')
            .every((sha) => patches.has(sha))
        )
          return { ...work, publication: 'merged' };
      }
    }
    if (probe.publicationRemote !== '.') {
      const published = await readSlotProbe(
        vars,
        `${git} ls-remote --heads ${shellQuote(probe.publicationRemote)} ${shellQuote(probe.publicationRef)}`,
        timeoutMs > 5000 ? 'workspace-recovery-publication' : 'workspace-publication',
        timeoutMs,
      );
      const sha = published.stdout.trim().split(/\s+/)[0];
      if (sha === probe.headSha) return { ...work, publication: 'pushed' };
      if (sha) {
        if (options.fetch) {
          const fetched = await execOnSlot(
            vars,
            `${git} fetch --no-tags ${shellQuote(probe.publicationRemote)} ${shellQuote(probe.publicationRef)}`,
            { timeout: 120_000, noRetry: true },
          );
          if (fetched.exitCode !== 0)
            return { ...work, error: 'Publication ref could not be fetched' };
        }
        const contains = await execOnSlot(
          vars,
          `${git} merge-base --is-ancestor HEAD ${shellQuote(sha)}`,
          { timeout: timeoutMs },
        );
        if (contains.exitCode === 0) return { ...work, publication: 'pushed' };
        if (contains.exitCode !== 1)
          return { ...work, error: 'Publication ancestry is unavailable locally' };
      }
    }
    const repo = getProjectField(project, 'ci.repo');
    if (repo) {
      const merged = await readMergedPreparePullRequests(
        repo,
        probe.headSha,
        timeoutMs,
        options.fetch === true,
      ).catch((error: unknown) => {
        // An unpublished local commit has no GitHub PR association.
        if (
          error instanceof GitHubHttpError &&
          error.status === 422 &&
          error.message.includes('No commit found for SHA')
        )
          return [];
        throw error;
      });
      for (const pr of merged) {
        if (
          await refIncludedInMergedPullRequest(
            vars,
            'HEAD',
            branch,
            repo,
            execOnSlot,
            async () => [pr],
            {
              allowFetch: options.fetch === true,
              timeoutMs,
              defaultSha: work.remoteDefaultSha ?? undefined,
            },
          )
        ) {
          return {
            ...work,
            publication: 'merged',
            pullRequest: { repo, number: pr.number, state: 'merged' },
          };
        }
      }
      if (merged.length) return { ...work, error: 'Merged PR coverage could not be verified' };
    }
    const commits = await execOnSlot(
      vars,
      `${git} rev-list --count ${shellQuote(`origin/${branch}..HEAD`)}`,
      { timeout: timeoutMs },
    );
    if (commits.exitCode !== 0)
      return { ...work, error: 'Unpublished commits could not be inspected' };
    return {
      ...work,
      publication: 'unpushed',
      unpublishedCount: Number(commits.stdout.trim()) || 0,
    };
  } catch (error) {
    return {
      ...work,
      publication: 'unknown',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface WorkspaceInspection {
  key: string;
  pending: boolean;
  until: number;
  promise: Promise<SlotWorkspace>;
}
const inspections = new Map<string, WorkspaceInspection>();
export function invalidateSlotWorkspaceObservations(slotId: string): void {
  const cached = inspections.get(slotId);
  if (cached) cached.until = 0;
  setWorkspaceOverlay(slotId, undefined);
}

export async function observeSlotWorkspaces(slots: readonly SlotStatus[]): Promise<SlotStatus[]> {
  return Promise.all(
    slots.map(async (slot) => {
      if (slot.missingFromPool || !slot.enabled || slot.health.ssh === 'FAIL')
        return { ...slot, workspace: undefined };
      const key = JSON.stringify([
        slot.slot,
        slot.headSha,
        slot.branch,
        slot.currentRunId,
        slot.slotEpoch,
        slot.cleanupRunId,
        slot.handoffRunId,
        slot.lifecycle,
        slot.heldReason,
      ]);
      let cached = inspections.get(slot.slot);
      while (cached?.pending && cached.key !== key) {
        try {
          await cached.promise;
        } catch (error) {
          return {
            ...slot,
            workspace: undefined,
            workspaceError: error instanceof Error ? error.message : String(error),
          };
        }
        cached = inspections.get(slot.slot);
      }
      if (!cached || (!cached.pending && (cached.key !== key || cached.until < Date.now()))) {
        const promise = inspectSlotWorkspace(slot.slot, {
          network: slot.lifecycle !== 'busy' && slot.agent !== 'working',
        });
        const entry: WorkspaceInspection = {
          key,
          pending: true,
          until: Date.now() + 15_000,
          promise: promise.finally(() => {
            entry.pending = false;
            // A slow inspection must have a useful cache window after it
            // settles. Explicit invalidation during the read still wins.
            if (entry.until !== 0) entry.until = Date.now() + 15_000;
          }),
        };
        cached = entry;
        inspections.set(slot.slot, entry);
      }
      try {
        const workspace = await cached.promise;
        if (cached.until === 0)
          return {
            ...slot,
            workspace: undefined,
            workspaceError: 'Workspace changed; inspect again',
          };
        setWorkspaceOverlay(slot.slot, workspace);
        return { ...slot, workspace };
      } catch (error) {
        return {
          ...slot,
          workspace: undefined,
          workspaceError: error instanceof Error ? error.message : String(error),
        };
      } // No claim is made when inspection is unavailable.
    }),
  );
}

export async function enrichFleetWorkspaces(fleet: FleetStatus): Promise<FleetStatus> {
  return { ...fleet, slots: await observeSlotWorkspaces(fleet.slots) };
}

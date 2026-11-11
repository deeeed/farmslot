/**
 * Decision index — pre-enriched PendingDecision entities (ADR-071 Amendment 3).
 *
 * Unit of work is the run, not the individual decision:
 *   rebuildRun(run) enriches the run once and handles all of its decisions.
 *   reconcileFileDecisions(decisions) diffs the full file-decision set.
 *
 * Ordering: file decisions in scan order, then run decisions in
 * getRunsWithDecisions() order (active runs first, then recent completed).
 *
 * Expiry: one timer re-armed to the earliest run expiry; expired runs are
 * purged automatically without polling the full set.
 *
 * Collection key {family:'decisions',scope:'farm'} advances on membership change.
 * Per-decision key {family:'decision',decisionId} advances on data change.
 *
 * Failed warm-up rejects ready(), schedules a retry; resolves only on complete build.
 * Tombstones are bounded to run lifetime and purged on expiry or file-set removal.
 */

import { createHash } from 'node:crypto';

import type { PendingDecision, Run } from '@farmslot/protocol';
import { canonicalResourceJson } from '@farmslot/protocol/client-cache';

import { refreshRetrospectiveFeedback } from '../intelligence/feedback-candidates.js';
import { resourceRevisions } from '../resources/revisions.js';
import { attachReviewRoundBudget } from '../review/review-round-budget.js';
import { buildRetrospectivePayload } from '../run-completion/orchestrator.js';
import { pendingDecisionForRun } from '../run-engine/decision-projection.js';
import { inspectedRun } from '../run-engine/gate-inspection.js';
import { enrichDecisionsWithGateSummary } from '../run-engine/gate-summary.js';
import { completedDecisionExpiresAt } from '../runs/decision-inbox.js';
import { getRun, listRuns } from '../runs/store.js';

function entityVersion(entity: PendingDecision): string {
  return createHash('sha256').update(canonicalResourceJson(entity)).digest('hex').slice(0, 16);
}

interface DecisionEntry {
  entity: PendingDecision;
  version: string;
}

/** Per-run state: generation + map of decision entries + optional expiry. */
interface RunState {
  generation: number;
  decisions: Map<string, DecisionEntry>;
  expiresAt?: number;
}

const WARMUP_RETRY_DELAYS = [30_000, 60_000, 120_000];

/** Active runs + recently completed runs that still have unresolved decisions. */
function getRunsWithDecisions(): Run[] {
  const { runs: activeRuns } = listRuns({ active: true });
  const recentDoneRuns = listRuns({}).runs.filter((run) => {
    const expiresAt = completedDecisionExpiresAt(run);
    return expiresAt !== undefined && Date.now() < expiresAt;
  });
  return [...activeRuns, ...recentDoneRuns];
}

export class DecisionIndex {
  /** File decisions: id → entry, in fileOrder insertion order. */
  private readonly fileDecisions = new Map<string, DecisionEntry>();
  /** Ordered list of file decision ids (scan order). */
  private fileOrder: string[] = [];

  /** Run decisions: runId → RunState. */
  private readonly runStates = new Map<string, RunState>();

  /** Tombstoned decision ids (resolved). Bounded: purged when owning run expires. */
  private readonly tombstones = new Set<string>();

  /** Expiry timer for the earliest run expiry. */
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  /** Ready promise: resolves on complete warm-up, rejects on failure (retried). */
  private readyPromise: Promise<void> | undefined;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((err: unknown) => void) | undefined;

  ready(): Promise<void> {
    return this.readyPromise ?? Promise.resolve();
  }

  startWarmup(): void {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    void this.runWarmup(0);
  }

  private async runWarmup(retryIndex: number): Promise<void> {
    try {
      // One file walk + one run-list scan — matches today's decisionList() cost.
      const { fileDecisions, runs } = await this.loadAll();

      // Reconcile file decisions as a set.
      this.applyFileDecisionSet(fileDecisions);

      // Rebuild each run in batches of 5, yielding between batches.
      for (let i = 0; i < runs.length; i += 5) {
        const batch = runs.slice(i, i + 5);
        await Promise.all(batch.map((run) => this.applyRebuildRun(run)));
        if (i + 5 < runs.length) await new Promise<void>((r) => setImmediate(r));
      }

      this.readyResolve?.();
    } catch (err) {
      console.warn(
        `[decision-index] warm-up failed (attempt ${retryIndex + 1}): ${(err as Error).message}`,
      );
      this.readyReject?.(err);
      // Create a new ready promise for the retry.
      const delay = WARMUP_RETRY_DELAYS[Math.min(retryIndex, WARMUP_RETRY_DELAYS.length - 1)];
      this.readyPromise = new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
      setTimeout(() => void this.runWarmup(retryIndex + 1), delay);
    }
  }

  /**
   * Load file decisions and runs for warm-up. Extracted so the parity test can
   * stub it without touching the full async pipeline.
   */
  protected async loadAll(): Promise<{ fileDecisions: PendingDecision[]; runs: Run[] }> {
    const { loadPendingDecisions } = await import('../observability/fleet-monitor.js');
    const [fileDecisions] = await Promise.all([loadPendingDecisions()]);
    const runs = getRunsWithDecisions();
    return { fileDecisions, runs };
  }

  /**
   * Rebuild all decisions for one run. Called by:
   * - warm-up (one pass, run object at hand)
   * - scheduleRebuildForRun (via setDecisionHooks trigger from run-changes.ts)
   * - gap trigger 1 (review round file changed)
   */
  async rebuildRun(run: Run): Promise<void> {
    const existing = this.runStates.get(run.id);
    const gen = (existing?.generation ?? 0) + 1;
    const state: RunState = {
      generation: gen,
      decisions: existing?.decisions ?? new Map(),
      expiresAt: existing?.expiresAt,
    };
    this.runStates.set(run.id, state);
    try {
      await this.applyRebuildRun(run, gen);
    } catch (err) {
      console.warn(
        `[decision-index] rebuildRun ${run.id.slice(0, 8)} failed: ${(err as Error).message}`,
      );
      // Failed rebuild: advance collection key without entity so client falls back.
      resourceRevisions.advance({ family: 'decisions', scope: 'farm' });
    }
  }

  private async applyRebuildRun(run: Run, gen?: number): Promise<void> {
    const enrichedRun = enrichDecisionsWithGateSummary(
      await attachReviewRoundBudget(inspectedRun(run)),
    );

    // Stale generation check after async enrichment.
    const current = this.runStates.get(run.id);
    if (gen !== undefined && current?.generation !== gen) return;

    const expiresAt = completedDecisionExpiresAt(run);
    const newDecisions = new Map<string, DecisionEntry>();
    for (const d of enrichedRun.decisions) {
      if (d.resolvedAt) continue;
      let payload =
        d.type === 'retrospective' && !d.payload
          ? await buildRetrospectivePayload(enrichedRun, null)
          : d.payload;
      if (payload?.kind === 'retrospective')
        payload = await refreshRetrospectiveFeedback(payload, enrichedRun);
      const entity = pendingDecisionForRun(run, d, payload);
      newDecisions.set(d.id, { entity, version: entityVersion(entity) });
    }

    // Stale generation check again (async calls above may take time).
    const currentAfter = this.runStates.get(run.id);
    if (gen !== undefined && currentAfter?.generation !== gen) return;

    const prevDecisions = currentAfter?.decisions ?? new Map<string, DecisionEntry>();
    let membershipChanged = false;

    // Detect removed decisions (were in prev, not in new).
    for (const [id, prev] of prevDecisions) {
      if (!newDecisions.has(id) && !this.tombstones.has(id)) {
        this.tombstones.add(id);
        membershipChanged = true;
        resourceRevisions.advance({ family: 'decision', decisionId: id }, 'deleted');
      } else if (!newDecisions.has(id)) {
        // Already tombstoned; just ensure it's not in the run anymore.
        prevDecisions.delete(id);
      }
      void prev; // suppress unused warning
    }

    // Detect added/changed decisions.
    for (const [id, next] of newDecisions) {
      if (this.tombstones.has(id)) continue; // resolved — do not resurrect
      const prev = prevDecisions.get(id);
      if (!prev) {
        membershipChanged = true;
        resourceRevisions.advance({ family: 'decision', decisionId: id });
      } else if (prev.version !== next.version) {
        resourceRevisions.advance({ family: 'decision', decisionId: id });
      }
    }

    // Commit the new run state.
    const updatedState: RunState = {
      generation: gen ?? currentAfter?.generation ?? 0,
      decisions: newDecisions,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    this.runStates.set(run.id, updatedState);

    if (membershipChanged) resourceRevisions.advance({ family: 'decisions', scope: 'farm' });
    this.rearmExpiryTimer();
  }

  /**
   * Reconcile file decisions as a complete set. Called by fleet-monitor's
   * onFileDecisionsScanned handler (gap trigger: file scan result available).
   */
  reconcileFileDecisions(decisions: PendingDecision[]): void {
    const incoming = new Map(decisions.map((d) => [d.id, d]));
    let membershipChanged = false;

    // Removed ids.
    for (const id of [...this.fileOrder]) {
      if (!incoming.has(id)) {
        this.fileDecisions.delete(id);
        this.fileOrder = this.fileOrder.filter((x) => x !== id);
        this.tombstones.delete(id); // file decision re-enter is not a resurrection
        membershipChanged = true;
      }
    }

    // Added or changed ids.
    for (const [id, entity] of incoming) {
      const ver = entityVersion(entity);
      if (this.tombstones.has(id)) {
        // Previously resolved; treat the re-appearing file as new.
        this.tombstones.delete(id);
      }
      const existing = this.fileDecisions.get(id);
      if (!existing) {
        this.fileDecisions.set(id, { entity, version: ver });
        this.fileOrder.push(id);
        membershipChanged = true;
        resourceRevisions.advance({ family: 'decision', decisionId: id });
      } else if (existing.version !== ver) {
        this.fileDecisions.set(id, { entity, version: ver });
        resourceRevisions.advance({ family: 'decision', decisionId: id });
      }
      // else unchanged — no-op
    }

    if (membershipChanged) resourceRevisions.advance({ family: 'decisions', scope: 'farm' });
  }

  /**
   * Apply file decision set during warm-up. Same logic as reconcileFileDecisions
   * but called before gateway connections are served.
   */
  private applyFileDecisionSet(decisions: PendingDecision[]): void {
    this.reconcileFileDecisions(decisions);
  }

  /**
   * Schedule a rebuild for a run by id.
   * Uses getRun (O(1) direct lookup) — never a list scan.
   */
  scheduleRebuildForRun(runId: string): void {
    const run = getRun(runId);
    if (!run) return;
    void this.rebuildRun(run);
  }

  /**
   * Tombstone a decision. Called from publishRunResources when a decision is removed
   * (kind='deleted' or decision removed from run).
   * The tombstone is purged when the owning run expires.
   */
  markResolved(decisionId: string): void {
    this.tombstones.add(decisionId);
    // Remove from file decisions if present.
    if (this.fileDecisions.has(decisionId)) {
      this.fileDecisions.delete(decisionId);
      this.fileOrder = this.fileOrder.filter((id) => id !== decisionId);
      resourceRevisions.advance({ family: 'decisions', scope: 'farm' });
      resourceRevisions.advance({ family: 'decision', decisionId }, 'deleted');
      return;
    }
    // Remove from any run entries if present.
    for (const [, state] of this.runStates) {
      if (state.decisions.has(decisionId)) {
        state.decisions.delete(decisionId);
        resourceRevisions.advance({ family: 'decisions', scope: 'farm' });
        resourceRevisions.advance({ family: 'decision', decisionId }, 'deleted');
        break;
      }
    }
  }

  /** Gap trigger 2: feedback rules changed → rebuild all runs with retrospective decisions. */
  rebuildAllRetrospectiveDecisions(): void {
    for (const [runId, state] of this.runStates) {
      const hasRetro = [...state.decisions.values()].some((e) => e.entity.type === 'retrospective');
      if (hasRetro) this.scheduleRebuildForRun(runId);
    }
  }

  get(id: string): PendingDecision | undefined {
    if (this.tombstones.has(id)) return undefined;
    const file = this.fileDecisions.get(id);
    if (file) return file.entity;
    for (const state of this.runStates.values()) {
      const e = state.decisions.get(id);
      if (e) return e.entity;
    }
    return undefined;
  }

  getVersion(id: string): string | undefined {
    if (this.tombstones.has(id)) return undefined;
    const file = this.fileDecisions.get(id);
    if (file) return file.version;
    for (const state of this.runStates.values()) {
      const e = state.decisions.get(id);
      if (e) return e.version;
    }
    return undefined;
  }

  /**
   * File decisions first (in scan order), then run decisions in
   * getRunsWithDecisions() order. Matches today's decisionList() output order.
   */
  getAll(): PendingDecision[] {
    const result: PendingDecision[] = [];
    for (const id of this.fileOrder) {
      const e = this.fileDecisions.get(id);
      if (e && !this.tombstones.has(id)) result.push(e.entity);
    }
    for (const run of getRunsWithDecisions()) {
      const state = this.runStates.get(run.id);
      if (!state) continue;
      for (const [id, e] of state.decisions) {
        if (!this.tombstones.has(id)) result.push(e.entity);
      }
    }
    return result;
  }

  getAllVersions(): Array<{ id: string; version: string }> {
    const result: Array<{ id: string; version: string }> = [];
    for (const id of this.fileOrder) {
      const e = this.fileDecisions.get(id);
      if (e && !this.tombstones.has(id)) result.push({ id, version: e.version });
    }
    for (const run of getRunsWithDecisions()) {
      const state = this.runStates.get(run.id);
      if (!state) continue;
      for (const [id, e] of state.decisions) {
        if (!this.tombstones.has(id)) result.push({ id, version: e.version });
      }
    }
    return result;
  }

  /** Re-arm the single expiry timer to the earliest run expiry. */
  private rearmExpiryTimer(): void {
    if (this.expiryTimer !== undefined) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    let minExpiry: number | undefined;
    for (const state of this.runStates.values()) {
      if (state.expiresAt !== undefined) {
        if (minExpiry === undefined || state.expiresAt < minExpiry) minExpiry = state.expiresAt;
      }
    }
    if (minExpiry === undefined) return;
    const delay = Math.max(0, minExpiry - Date.now());
    this.expiryTimer = setTimeout(() => this.handleExpiry(), delay);
  }

  protected handleExpiry(): void {
    this.expiryTimer = undefined;
    const now = Date.now();
    let membershipChanged = false;
    for (const [runId, state] of this.runStates) {
      if (state.expiresAt !== undefined && state.expiresAt <= now) {
        // Purge tombstones for this run's decisions.
        for (const id of state.decisions.keys()) this.tombstones.delete(id);
        if (state.decisions.size > 0) membershipChanged = true;
        this.runStates.delete(runId);
      }
    }
    if (membershipChanged) resourceRevisions.advance({ family: 'decisions', scope: 'farm' });
    this.rearmExpiryTimer();
  }
}

export const decisionIndex = new DecisionIndex();

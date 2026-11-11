/**
 * Decision index — pre-enriched PendingDecision entities (ADR-071 Amendment 3).
 *
 * Warm-up at gateway start builds the full set synchronously (batched via
 * setImmediate). After warm-up all three read paths (full/versions/ids) are
 * served from this map without running the enrichment pipeline per request.
 *
 * Key invariants:
 * - Each entry has a generation counter. A rebuild that completes after a
 *   newer generation was started is discarded.
 * - markResolved() sets a tombstone; any subsequent rebuild is a no-op.
 * - A failed rebuild advances {family:'decision',decisionId} without an entity
 *   so the client falls back to the ids read path.
 */

import { createHash } from 'node:crypto';

import type { PendingDecision } from '@farmslot/protocol';
import { canonicalResourceJson } from '@farmslot/protocol/client-cache';

import { refreshRetrospectiveFeedback } from '../intelligence/feedback-candidates.js';
import { loadPendingDecisions } from '../observability/fleet-monitor.js';
import { resourceRevisions } from '../resources/revisions.js';
import { attachReviewRoundBudget } from '../review/review-round-budget.js';
import { buildRetrospectivePayload } from '../run-completion/orchestrator.js';
import { pendingDecisionForRun } from '../run-engine/decision-projection.js';
import { inspectedRun } from '../run-engine/gate-inspection.js';
import { enrichDecisionsWithGateSummary } from '../run-engine/gate-summary.js';
import { completedDecisionExpiresAt } from '../runs/decision-inbox.js';
import { listRuns } from '../runs/store.js';

function entityVersion(entity: PendingDecision): string {
  return createHash('sha256').update(canonicalResourceJson(entity)).digest('hex').slice(0, 16);
}

interface IndexEntry {
  entity?: PendingDecision;
  version: string;
  tombstone?: boolean;
}

class DecisionIndex {
  private readonly entries = new Map<string, IndexEntry>();
  private readonly generations = new Map<string, number>();
  private readyPromise: Promise<void> | undefined;
  private readyResolve: (() => void) | undefined;

  ready(): Promise<void> {
    return this.readyPromise ?? Promise.resolve();
  }

  startWarmup(): void {
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    void this.runWarmup();
  }

  private async runWarmup(): Promise<void> {
    try {
      const fileDecisions = await loadPendingDecisions();
      const { runs: activeRuns } = listRuns({ active: true });
      const recentDoneRuns = listRuns({}).runs.filter((run) => {
        const expiresAt = completedDecisionExpiresAt(run);
        return expiresAt !== undefined && Date.now() < expiresAt;
      });

      // Collect all unresolved decision ids
      const toRebuild: string[] = fileDecisions.map((d) => d.id);
      for (const run of [...activeRuns, ...recentDoneRuns]) {
        for (const d of run.decisions) {
          if (!d.resolvedAt) toRebuild.push(d.id);
        }
      }

      // Warm up in batches of 10, yielding between batches
      for (let i = 0; i < toRebuild.length; i += 10) {
        const batch = toRebuild.slice(i, i + 10);
        await Promise.all(batch.map((id) => this.applyRebuild(id)));
        if (i + 10 < toRebuild.length) {
          await new Promise<void>((r) => setImmediate(r));
        }
      }
    } catch (err) {
      console.warn(`[decision-index] warmup failed: ${(err as Error).message}`);
    }
    this.readyResolve?.();
  }

  async scheduleRebuild(decisionId: string): Promise<void> {
    const gen = (this.generations.get(decisionId) ?? 0) + 1;
    this.generations.set(decisionId, gen);
    try {
      await this.applyRebuild(decisionId, gen);
    } catch (err) {
      // Failed rebuild: advance key without entity so client falls back to ids read
      console.warn(
        `[decision-index] rebuild ${decisionId.slice(0, 8)} failed: ${(err as Error).message}`,
      );
      // Clear generation so next change triggers a fresh rebuild attempt
      if (this.generations.get(decisionId) === gen) this.generations.delete(decisionId);
      resourceRevisions.advance({ family: 'decision', decisionId });
    }
  }

  private async applyRebuild(decisionId: string, gen?: number): Promise<void> {
    const entry = await buildEntry(decisionId);

    // Discard stale generation
    if (gen !== undefined && this.generations.get(decisionId) !== gen) return;
    // Tombstone: never resurrect a resolved decision
    const existing = this.entries.get(decisionId);
    if (existing?.tombstone) return;

    if (!entry) {
      // Decision gone — tombstone and notify
      if (existing) {
        this.entries.set(decisionId, { ...existing, tombstone: true });
        resourceRevisions.advance({ family: 'decision', decisionId }, 'deleted');
      }
      return;
    }

    const version = entityVersion(entry);
    if (existing?.version === version) return; // unchanged — no noise
    this.entries.set(decisionId, { entity: entry, version });
    resourceRevisions.advance({ family: 'decision', decisionId });
  }

  markResolved(decisionId: string): void {
    const existing = this.entries.get(decisionId);
    if (existing) {
      this.entries.set(decisionId, { ...existing, tombstone: true });
    } else {
      // Pre-emptively tombstone even if no entry exists yet
      this.entries.set(decisionId, { version: '', tombstone: true });
    }
  }

  get(id: string): PendingDecision | undefined {
    const entry = this.entries.get(id);
    return entry?.tombstone ? undefined : entry?.entity;
  }

  getVersion(id: string): string | undefined {
    const entry = this.entries.get(id);
    return entry?.tombstone ? undefined : entry?.version;
  }

  getAll(): PendingDecision[] {
    return [...this.entries.values()].filter((e) => !e.tombstone).map((e) => e.entity);
  }

  getAllVersions(): Array<{ id: string; version: string }> {
    return [...this.entries.entries()]
      .filter(([, e]) => !e.tombstone)
      .map(([id, e]) => ({ id, version: e.version }));
  }

  /** Gap trigger 1: review round file changed → rebuild all decisions in the run. */
  scheduleRebuildForRun(runId: string): void {
    const run = listRuns({}).runs.find((r) => r.id === runId);
    if (!run) return;
    for (const d of run.decisions) {
      if (!d.resolvedAt) void this.scheduleRebuild(d.id);
    }
  }

  /** Gap trigger 2: feedback rules changed → rebuild all retrospective decisions. */
  rebuildAllRetrospectiveDecisions(): void {
    for (const [id, entry] of this.entries) {
      if (entry.tombstone) continue;
      if (entry.entity.type === 'retrospective') void this.scheduleRebuild(id);
    }
  }
}

async function buildEntry(decisionId: string): Promise<PendingDecision | null> {
  // File-based decisions (already fully enriched by fleet-monitor)
  const fileDecisions = await loadPendingDecisions();
  const fd = fileDecisions.find((d) => d.id === decisionId);
  if (fd) return fd;

  // Run decisions
  const { runs: activeRuns } = listRuns({ active: true });
  const recentDoneRuns = listRuns({}).runs.filter((run) => {
    const expiresAt = completedDecisionExpiresAt(run);
    return expiresAt !== undefined && Date.now() < expiresAt;
  });
  for (const run of [...activeRuns, ...recentDoneRuns]) {
    const d = run.decisions.find((dec) => dec.id === decisionId && !dec.resolvedAt);
    if (!d) continue;
    const enrichedRun = enrichDecisionsWithGateSummary(
      await attachReviewRoundBudget(inspectedRun(run)),
    );
    let payload =
      d.type === 'retrospective' && !d.payload
        ? await buildRetrospectivePayload(enrichedRun, null)
        : d.payload;
    if (payload?.kind === 'retrospective') {
      payload = await refreshRetrospectiveFeedback(payload, enrichedRun);
    }
    return pendingDecisionForRun(run, d, payload);
  }
  return null;
}

export const decisionIndex = new DecisionIndex();

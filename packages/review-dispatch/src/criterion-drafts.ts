import {
  type AcceptanceCriterionView,
  buildRunDecisionActionRequest,
  MARK_CLAIM_UNTESTABLE_ACTION,
  type ReviewSummary,
  type Run,
  type RunDecision,
  type RunOverrideClaimResult,
} from '@farmslot/protocol';

export interface CriterionDraft {
  claimId: string;
  choice: 'confirm' | 'skip';
  note: string;
  codeReview: boolean;
  recipeRunId?: string;
}

export interface CriterionDraftStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
}

export function canDraftCriterion(claim: AcceptanceCriterionView): boolean {
  return (
    !claim.status?.inheritedFrom && !['proven', 'untestable'].includes(claim.status?.verdict ?? '')
  );
}

export function criterionDraftReason(drafts: readonly CriterionDraft[], reason = ''): string {
  return [
    reason.trim(),
    ...drafts.map(
      (draft) =>
        `${draft.claimId}: ${draft.choice === 'skip' ? 'Skipped as untestable' : draft.codeReview ? 'Confirmed in code review' : 'Confirmed after reviewing evidence'}. ${draft.note}`,
    ),
  ]
    .filter(Boolean)
    .join('\n');
}

export function criterionDraftApprovalLabel(drafts: readonly CriterionDraft[]): string | undefined {
  if (!drafts.length) return undefined;
  return `Approve with ${drafts.filter(({ choice }) => choice === 'confirm').length} confirmed, ${drafts.filter(({ choice }) => choice === 'skip').length} skipped`;
}

/** UI drafts only. Scope includes the gateway, person, run and decision; snapshot is its frozen package. */
export class CriterionDraftModel {
  entries: CriterionDraft[] = [];
  error: { claimId: string; message: string; retry: () => void } | null = null;
  ready = false;
  private key = '';
  private snapshot = '';
  private revision = 0;
  private saved: CriterionDraft[] = [];
  private writes: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  constructor(private storage: CriterionDraftStorage) {}
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed() {
    for (const listener of this.listeners) listener();
  }
  setScope(scope: string, snapshot: string): void {
    const key = `farmslot:criterion-drafts:v1:${scope}`;
    if (key === this.key && snapshot === this.snapshot) return;
    this.key = key;
    this.snapshot = snapshot;
    this.entries = [];
    this.saved = [];
    this.ready = false;
    this.error = null;
    const revision = ++this.revision;
    void Promise.resolve()
      .then(() => this.storage.getItem(key))
      .then((raw) => {
        if (revision !== this.revision) return;
        if (raw) {
          const value: unknown = JSON.parse(raw);
          if (
            !value ||
            typeof value !== 'object' ||
            !('snapshot' in value) ||
            !('entries' in value) ||
            !Array.isArray(value.entries)
          )
            throw new Error('Saved criterion drafts are unreadable.');
          if (value.snapshot === snapshot) {
            const entries: CriterionDraft[] = [];
            const rawEntries: unknown[] = value.entries;
            for (const entry of rawEntries) {
              if (
                !entry ||
                typeof entry !== 'object' ||
                !('claimId' in entry) ||
                !('choice' in entry) ||
                !('note' in entry) ||
                !('codeReview' in entry) ||
                typeof entry.claimId !== 'string' ||
                (entry.choice !== 'confirm' && entry.choice !== 'skip') ||
                typeof entry.note !== 'string' ||
                typeof entry.codeReview !== 'boolean' ||
                ('recipeRunId' in entry &&
                  entry.recipeRunId !== undefined &&
                  typeof entry.recipeRunId !== 'string')
              )
                throw new Error('Saved criterion drafts are unreadable.');
              entries.push({
                claimId: entry.claimId,
                choice: entry.choice === 'skip' ? 'skip' : 'confirm',
                note: entry.note,
                codeReview: entry.codeReview,
                ...('recipeRunId' in entry && typeof entry.recipeRunId === 'string'
                  ? { recipeRunId: entry.recipeRunId }
                  : {}),
              });
            }
            this.entries = entries;
            this.saved = entries;
          }
        }
        this.ready = true;
        this.changed();
      })
      .catch((error: unknown) => {
        if (revision !== this.revision) return;
        this.error = {
          claimId: '',
          message: error instanceof Error ? error.message : String(error),
          retry: () => {
            this.key = '';
            this.setScope(scope, snapshot);
          },
        };
        this.changed();
      });
  }
  choose(
    claim: AcceptanceCriterionView,
    choice: CriterionDraft['choice'],
    note = '',
    recipeRunId?: string,
  ): void {
    if (!this.ready || !canDraftCriterion(claim)) return;
    const existing = this.entries.find(({ claimId }) => claimId === claim.id);
    const draft: CriterionDraft = {
      claimId: claim.id,
      choice,
      note:
        note.trim() ||
        (choice === 'skip' ? 'Not testable in this run.' : 'Reviewed this criterion.'),
      codeReview: claim.status?.proofMode === 'review',
      ...(recipeRunId ? { recipeRunId } : {}),
    };
    this.persist(
      [...this.entries.filter(({ claimId }) => claimId !== claim.id), { ...existing, ...draft }],
      claim.id,
    );
  }
  undo(claimId: string): void {
    this.persist(
      this.entries.filter((entry) => entry.claimId !== claimId),
      claimId,
    );
  }
  private persist(entries: CriterionDraft[], claimId: string): void {
    const key = this.key,
      snapshot = this.snapshot,
      revision = ++this.revision;
    this.entries = entries;
    this.error = null;
    this.changed();
    this.writes = this.writes.then(async () => {
      try {
        await this.storage.setItem(key, JSON.stringify({ snapshot, entries }));
        if (this.key === key && this.snapshot === snapshot) this.saved = entries;
      } catch (error) {
        if (revision === this.revision) {
          this.entries = this.saved;
          this.error = {
            claimId,
            message: error instanceof Error ? error.message : String(error),
            retry: () => this.persist(entries, claimId),
          };
          this.changed();
        }
      }
    });
  }
  /** Only an owning override response can carry the pending draft onto its refreshed package. */
  rebind(snapshot: string, appliedClaimId: string, remaining = this.entries): void {
    this.snapshot = snapshot;
    this.ready = true;
    this.persist(
      remaining.filter(({ claimId }) => claimId !== appliedClaimId),
      appliedClaimId,
    );
  }
  settled(): Promise<void> {
    return this.writes;
  }
  clear(): void {
    this.persist([], '');
  }
}

/** One approval click submits the existing skip RPCs, then binds approval to their returned package. */
export async function applyCriterionDraftSkips(input: {
  run: Run;
  decision: RunDecision;
  drafts: readonly CriterionDraft[];
  request: (
    method: string,
    params: import('@farmslot/protocol').RunOverrideClaimParams,
  ) => Promise<RunOverrideClaimResult>;
  execution?: (claimId: string) => string | undefined;
  assertCurrent: () => void;
  applied: (run: Run, decision: RunDecision, claimId: string) => void;
}): Promise<RunDecision> {
  let decision = input.decision;
  const head = decision.payload?.kind === 'ready' ? decision.payload.prPackage?.headSha : undefined;
  for (const draft of input.drafts.filter(({ choice }) => choice === 'skip')) {
    input.assertCurrent();
    const request = buildRunDecisionActionRequest({
      runId: input.run.id,
      decision,
      actionId: MARK_CLAIM_UNTESTABLE_ACTION,
      claimId: draft.claimId,
      recipeRunId: draft.recipeRunId ?? input.execution?.(draft.claimId),
      claimOverrideReason: draft.note,
    });
    if (request.method !== 'run.overrideClaim')
      throw new Error('Invalid criterion override request.');
    const result = await input.request(request.method, request.params);
    input.assertCurrent();
    const next = result.run.decisions.find(({ id }) => id === decision.id);
    if (
      result.run.id !== input.run.id ||
      !next ||
      next.resolvedAt ||
      next.payload?.kind !== 'ready' ||
      !next.payload.prPackage ||
      next.payload.prPackage.headSha !== head ||
      result.receipt.claimId !== draft.claimId ||
      result.receipt.reason !== draft.note
    )
      throw new Error('The gate changed after saving a skip. Review it before approving.');
    decision = next;
    input.applied(result.run, decision, draft.claimId);
  }
  return decision;
}

export function codeReviewNoteSuggestion(summary?: ReviewSummary): string {
  const review = summary?.reviews
    .filter(({ stale, verdict }) => !stale && verdict === 'pass')
    .at(-1);
  return review ? `Review ${review.id} passed with ${review.unresolvedCount} open findings.` : '';
}

export interface CriterionDraftActions {
  model: CriterionDraftModel;
  choose: (claimId: string, choice: CriterionDraft['choice'], note?: string) => void;
  canSkip: (claimId: string) => boolean;
}

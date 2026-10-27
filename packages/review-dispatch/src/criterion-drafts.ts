import {
  type AcceptanceCriterionView,
  buildRunDecisionActionRequest,
  isPublishApprovalAction,
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

export function criterionDraftsAvailable(decision?: RunDecision | null): boolean {
  return (
    !decision?.resolvedAt &&
    decision?.payload?.kind === 'ready' &&
    Boolean(decision.payload.prPackage) &&
    decision.actions.some(({ id }) => isPublishApprovalAction(id))
  );
}

function draftNote(draft: Pick<CriterionDraft, 'choice' | 'note'>): string {
  return (
    draft.note.trim() ||
    (draft.choice === 'skip' ? 'Not testable in this run.' : 'Reviewed this criterion.')
  );
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
        `${draft.claimId}: ${draft.choice === 'skip' ? 'Skipped as untestable' : draft.codeReview ? 'Confirmed in code review' : 'Confirmed after reviewing evidence'}. ${draftNote(draft)}`,
    ),
  ]
    .filter(Boolean)
    .join('\n');
}

export function criterionDraftApprovalLabel(drafts: readonly CriterionDraft[]): string | undefined {
  if (!drafts.length) return undefined;
  return `Approve with ${drafts.filter(({ choice }) => choice === 'confirm').length} confirmed, ${drafts.filter(({ choice }) => choice === 'skip').length} skipped`;
}

export interface CriterionDraftApproval<T> {
  run: Pick<Run, 'id'>;
  decision: RunDecision;
  actionId: string;
  reason: string;
  execution?: (claimId: string) => string | undefined;
  requestSkip: (
    method: string,
    params: import('@farmslot/protocol').RunOverrideClaimParams,
  ) => Promise<RunOverrideClaimResult>;
  send: (decision: RunDecision, actionId: string, reason: string) => Promise<T>;
  assertCurrent: () => void;
  applied: (run: Run, decision: RunDecision) => void;
}

/** UI drafts only. Scope includes the gateway, person, run and decision; snapshot is its frozen package. */
export class CriterionDraftModel {
  entries: CriterionDraft[] = [];
  error: { claimId: string; message: string; retry: () => void } | null = null;
  ready = false;
  submissionActionId: string | null = null;
  private submissionToken: symbol | null = null;
  private scopeEpoch = 0;
  private key = '';
  private snapshot = '';
  private revision = 0;
  private saved: CriterionDraft[] = [];
  private writes: Promise<void> = Promise.resolve();
  private notificationVersion = 0;
  get viewVersion(): number {
    return this.notificationVersion;
  }
  private listeners = new Set<() => void>();
  constructor(private storage: CriterionDraftStorage) {}
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed() {
    this.notificationVersion++;
    for (const listener of this.listeners) listener();
  }
  setScope(scope: string, snapshot: string): void {
    const key = `farmslot:criterion-drafts:v1:${scope}`;
    if (key === this.key && snapshot === this.snapshot) return;
    if (key !== this.key) {
      this.scopeEpoch++;
      this.submissionActionId = null;
      this.submissionToken = null;
    }
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
    note?: string,
    recipeRunId?: string,
    review?: ReviewSummary,
  ): void {
    if (!this.ready || this.submissionToken || !canDraftCriterion(claim)) return;
    const existing = this.entries.find(({ claimId }) => claimId === claim.id);
    const draft: CriterionDraft = {
      claimId: claim.id,
      choice,
      note:
        existing?.choice === choice
          ? (note ?? existing.note)
          : draftNote({
              choice,
              note:
                note ??
                (choice === 'confirm' && claim.status?.proofMode === 'review'
                  ? codeReviewNoteSuggestion(review)
                  : ''),
            }),
      codeReview: claim.status?.proofMode === 'review',
      ...(recipeRunId ? { recipeRunId } : {}),
    };
    this.persist(
      [...this.entries.filter(({ claimId }) => claimId !== claim.id), { ...existing, ...draft }],
      claim.id,
    );
  }
  undo(claimId: string): void {
    if (this.submissionToken) return;
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
  get scopeVersion(): number {
    return this.scopeEpoch;
  }
  deactivate(): void {
    this.key = '';
    this.snapshot = '';
    this.ready = false;
    this.revision++;
    this.scopeEpoch++;
    this.submissionToken = null;
    this.submissionActionId = null;
  }
  async approve<T>(input: CriterionDraftApproval<T>): Promise<T> {
    if (!isPublishApprovalAction(input.actionId) || !this.ready || this.submissionToken)
      throw new Error('This gate approval is unavailable or already being submitted.');
    const token = Symbol('criterion-approval');
    const epoch = this.scopeEpoch;
    const drafts = [...this.entries];
    const reason = criterionDraftReason(drafts, input.reason);
    const appliedClaims = new Set<string>();
    this.submissionToken = token;
    this.submissionActionId = input.actionId;
    this.changed();
    const assertCurrent = () => {
      if (this.scopeEpoch !== epoch) throw new Error('The gate or signed-in authority changed.');
      input.assertCurrent();
    };
    try {
      await this.settled();
      assertCurrent();
      if (this.error) throw new Error(this.error.message);
      const decision = await applyCriterionDraftSkips({
        ...input,
        drafts,
        request: input.requestSkip,
        assertCurrent,
        applied: (run, next, claimId) => {
          appliedClaims.add(claimId);
          this.rebind(
            next.payload?.kind === 'ready' ? (next.payload.prPackage?.packageHash ?? '') : '',
            claimId,
            drafts.filter((entry) => !appliedClaims.has(entry.claimId)),
          );
          input.applied(run, next);
        },
      });
      assertCurrent();
      let actionId = input.actionId;
      if (!decision.actions.some(({ id }) => id === actionId)) {
        if (
          actionId === 'approve-publish-evidence-attested' &&
          decision.actions.some(({ id }) => id === 'approve-publish')
        )
          actionId = 'approve-publish';
        else
          throw new Error(
            'The gate actions changed after saving skips. Review it before approving.',
          );
      }
      const result = await input.send(decision, actionId, reason);
      assertCurrent();
      this.clear();
      return result;
    } finally {
      if (this.submissionToken === token) {
        this.submissionToken = null;
        this.submissionActionId = null;
        this.changed();
      }
    }
  }
  settled(): Promise<void> {
    return this.writes;
  }
  clear(): void {
    this.persist([], '');
  }
}

/** One approval click submits the existing skip RPCs, then binds approval to their returned package. */
async function applyCriterionDraftSkips(input: {
  run: Pick<Run, 'id'>;
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
  const skips = input.drafts
    .filter(({ choice }) => choice === 'skip')
    .map((draft) => ({
      ...draft,
      note: draftNote(draft),
      recipeRunId: draft.recipeRunId ?? input.execution?.(draft.claimId),
    }));
  if (skips.some(({ recipeRunId }) => !recipeRunId))
    throw new Error('Wait for the recorded evidence to load before approving these skips.');
  for (const draft of skips) {
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
  return review
    ? review.unresolvedCount === 0
      ? 'The current code review passed with no open findings.'
      : `The current code review passed with ${review.unresolvedCount} open findings.`
    : '';
}

export interface CriterionDraftActions {
  model: CriterionDraftModel;
  choose: (claimId: string, choice: CriterionDraft['choice'], note?: string) => void;
  canSkip: (claimId: string) => boolean;
  skipDisabledReason?: (claimId: string) => string | undefined;
}

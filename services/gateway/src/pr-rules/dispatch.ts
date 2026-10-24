import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import {
  DEFAULT_PR_REVIEW_OPTIONS,
  isPRWorkspaceExecutionChoice,
  isTerminalRunStatus,
  monitoredPRKey,
  type PRExecutionChoice,
  type PRExecutionProfile,
  type PRReviewIntent,
  prReviewWorkflow,
  type QueueItem,
  resolvedRecipeArtifactPath,
  reviewResultForRun,
  type Run,
} from '@farmslot/protocol';
import { executionModelFromSelection, resolveReviewMode } from '@farmslot/review-dispatch';

import {
  addItem,
  getQueueSnapshot,
  persistQueueNow,
  queueRecordOriginator,
  removeQueueItemInternalNow,
  tryDispatchNext,
} from '../backlog/dispatch-queue.js';
import {
  type PRQueueAdmissionHooks,
  type PRQueuePreparation,
  runOwnsPR,
} from '../backlog/pr-admission.js';
import { type PRExecutionContext, resolvePRExecution } from '../backlog/pr-execution.js';
import { GatewayMethodError } from '../core/method-error.js';
import { publishPRAutomationResources } from '../resources/pr-automation-changes.js';
import { findLatestPriorReviewRun } from '../run-engine/engine-decisions.js';
import {
  getAllRuns,
  getCachedRunWithArchived,
  getRunWithArchived,
  runRecordPath,
} from '../runs/store.js';
import { generationMismatchMessage } from '../security/principal-resolver.js';
import {
  principalOwnerOriginator,
  runWithPrincipalOwner,
  runWithSystemOriginator,
} from '../security/work-originator.js';

import { reviewIntentAuthorized } from './intents.js';
import { publicationForIntent } from './publication-policy.js';
import { preferRetainedReviewer } from './reviewer-continuity.js';
import type { PRRuleService } from './service.js';
import { validateQaSourceReview, validateQaSourceReviewRecord } from './source-review.js';
import type { PRRuleStore } from './store.js';

function workId(intent: PRReviewIntent): string {
  return `review:${intent.id}`;
}

/** MONITOR writes this receipt only after the shared QA runtime-proof validator succeeds. */
function completedQaHead(run: Run, intent: PRReviewIntent): string | undefined {
  const evidence = run.steps.find((step) => step.name === 'monitor' && step.status === 'done')
    ?.outputs?.qaEvidence;
  if (!evidence || typeof evidence !== 'object') return undefined;
  const receipt = evidence as Record<string, unknown>;
  if (
    receipt.headSha !== intent.headSha ||
    !Array.isArray(receipt.packages) ||
    !receipt.packages.length
  )
    return undefined;
  if (
    !receipt.packages.every((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false;
      const item = entry as Record<string, unknown>;
      return (
        typeof item.path === 'string' && item.path.trim() && resolvedRecipeArtifactPath(item.digest)
      );
    })
  )
    return undefined;
  return intent.headSha;
}
function fingerprint(intent: PRReviewIntent): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        intent.headSha,
        intent.dispatchHold,
        intent.contributions.map(({ reviewObservation, ...policy }) => ({
          ...policy,
          ...(reviewObservation
            ? {
                reviewObservation: {
                  ...reviewObservation,
                  observedAt: undefined,
                  review: reviewObservation.review
                    ? { ...reviewObservation.review, submittedAt: undefined }
                    : null,
                },
              }
            : {}),
        })),
      ]),
    )
    .digest('hex');
}

export class PRReviewDispatcher implements PRQueueAdmissionHooks {
  private timer?: ReturnType<typeof setInterval>;
  private reconciling?: Promise<void>;
  private readonly proofs = new Map<
    string,
    { fingerprint: string; checkedAt: number; selection: string }
  >();
  error?: string;

  private setError(error: string | undefined): void {
    if (this.error === error) return;
    this.error = error;
    publishPRAutomationResources();
  }

  constructor(
    private readonly store: PRRuleStore,
    private readonly rules: Pick<PRRuleService, 'refreshTarget' | 'refreshSubmission'>,
    private readonly authorized: (ownerId: string, generation?: number) => boolean,
    private readonly changed: () => void,
    private readonly resolveExecution: (
      project: string,
      repo: string,
      profiles: PRExecutionProfile[],
      context?: PRExecutionContext,
    ) => Promise<{ choices: PRExecutionChoice[]; errors: string[] }> = resolvePRExecution,
    private readonly replaced: (ownerId: string, generation: number) => boolean = () => false,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), 10_000);
    this.timer.unref();
    this.wake();
  }
  wake(): void {
    void this.reconcile().then(
      () => {
        this.setError(undefined);
      },
      (error: unknown) => {
        // Retain the fault for client status; the next tick retries durable reconciliation.
        this.setError(error instanceof Error ? error.message : String(error));
        this.changed();
      },
    );
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = runWithSystemOriginator(() => this.reconcileOnce()).finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async reconcileOnce(): Promise<void> {
    await this.store.withdrawReplacedContributions(this.replaced);
    for (const snapshot of this.store.snapshot().intents) {
      let intent = this.store.intent(snapshot.id);
      if (!intent) continue;
      const run = getAllRuns().find((item) => item.prWork?.id === workId(intent!));
      if (run) {
        if (existsSync(runRecordPath(run.id))) {
          await this.observeRun(intent, run);
          const orphan = getQueueSnapshot().find((item) => item.prWork?.id === workId(intent!));
          if (orphan) await removeQueueItemInternalNow(orphan.id, 'pr-review-run-recovered');
        }
        continue;
      }
      if (
        intent.status === 'completed' ||
        intent.status === 'failed' ||
        intent.status === 'running'
      )
        continue;
      let queued = getQueueSnapshot().find((item) => item.prWork?.id === workId(intent!));
      if (queued?.status === 'cancelled') {
        await removeQueueItemInternalNow(queued.id, 'pr-review-cancelled');
        await this.store.updateDispatch(intent.id, {
          queueItemId: undefined,
          status: 'held',
          dispatchHold: 'Dispatch was cancelled; accept to queue again',
          waitingReason: 'Dispatch was cancelled; accept to queue again',
        });
        this.changed();
        continue;
      }
      if (
        !reviewIntentAuthorized(intent) ||
        intent.contributions.some(
          (source) =>
            source.eligible && !this.authorized(source.ownerId, source.ownerGeneration ?? 0),
        ) ||
        intent.status === 'withdrawn' ||
        intent.status === 'needs-configuration'
      ) {
        if (queued) {
          await removeQueueItemInternalNow(queued.id, 'pr-review-withdrawn');
          intent = this.store.intent(intent.id)!;
          await this.store.updateDispatch(intent.id, {
            queueItemId: undefined,
            status: intent.status === 'queued' ? 'held' : intent.status,
            waitingReason:
              intent.status === 'queued'
                ? 'Review deferred or awaiting current authorization'
                : intent.waitingReason,
          });
          this.changed();
        }
        continue;
      }
      if (!queued && intent.queueItemId) {
        await this.store.updateDispatch(intent.id, {
          queueItemId: undefined,
          status: 'held',
          dispatchHold: 'Dispatch was removed; accept the review to queue it again',
          waitingReason: 'Dispatch was removed; accept the review to queue it again',
        });
        this.changed();
        continue;
      }
      const source = intent.contributions.find((item) => item.eligible)!;
      if (!source.project || !this.authorized(source.ownerId, source.ownerGeneration ?? 0))
        continue;
      let parent: Run | undefined;
      if (source.sourceReview) {
        try {
          await validateQaSourceReview({
            runId: source.sourceReview.runId,
            ownerId: source.ownerId,
            ...(source.ownerGeneration !== undefined
              ? { ownerGeneration: source.ownerGeneration }
              : {}),
            project: source.project,
            pr: intent.pr,
            expected: source.sourceReview,
            observedHeadSha: intent.headSha,
          });
          parent = (await getRunWithArchived(source.sourceReview.runId))!;
        } catch (error) {
          if (!(error instanceof GatewayMethodError)) throw error;
          if (queued) await removeQueueItemInternalNow(queued.id, 'qa-source-review-unavailable');
          await this.store.updateDispatch(intent.id, {
            status: 'needs-configuration',
            queueItemId: undefined,
            waitingReason: error.message,
          });
          this.changed();
          continue;
        }
      }
      const review = {
        profile: intent.reviewProfile,
        ownerId: source.ownerId,
        ...(source.ownerGeneration !== undefined
          ? { ownerGeneration: source.ownerGeneration }
          : {}),
        options: source.review ?? DEFAULT_PR_REVIEW_OPTIONS,
      };
      const publication = publicationForIntent(intent, this.store);
      const flowType = prReviewWorkflow(review.options) === 'qa' ? 'qa' : 'review-pr';
      const prWork = {
        kind: 'review' as const,
        id: workId(intent),
        sourceId: intent.id,
        pr: intent.pr,
        headSha: intent.headSha,
        review,
        ...(publication ? { publication } : {}),
      };
      const domain =
        parent?.domain ??
        (flowType === 'review-pr'
          ? findLatestPriorReviewRun(
              {
                id: workId(intent),
                project: source.project,
                flowType,
                ticketOrPr: `${intent.pr.repo}#${intent.pr.number}`,
                prWork,
              },
              getAllRuns().filter(
                (run) =>
                  run.createdByPrincipalId === source.ownerId &&
                  (run.createdByPrincipalGeneration ?? 0) === (source.ownerGeneration ?? 0),
              ),
            )?.domain
          : undefined);
      const profiles = intent.contributions
        .filter((item) => item.eligible)
        .flatMap((item) => (item.execution ? [item.execution] : []));
      const resolved = await this.resolveExecution(source.project, intent.pr.repo, profiles, {
        ownerId: source.ownerId,
        ...(source.ownerGeneration !== undefined
          ? { ownerGeneration: source.ownerGeneration }
          : {}),
      });
      const workspaceRequired = prReviewWorkflow(review.options) === 'review';
      if (
        resolved.choices.some(
          (choice) => isPRWorkspaceExecutionChoice(choice) !== workspaceRequired,
        )
      ) {
        resolved.choices = [];
        resolved.errors = [
          workspaceRequired
            ? 'Select workspace machines for static Review; existing slot constraints need explicit migration'
            : 'QA requires runtime slots, not review workspaces',
        ];
      }
      resolved.choices = preferRetainedReviewer(
        intent,
        source.project,
        resolved.choices,
        getAllRuns(),
      );
      if (!resolved.choices.length) {
        await this.store.updateDispatch(intent.id, {
          status: 'needs-configuration',
          waitingReason:
            resolved.errors.join('; ') ||
            'WARM review requires a compatible retained reviewer and explicit reviewId lineage; wait or choose COLD.',
        });
        this.changed();
        continue;
      }
      if (flowType === 'review-pr')
        review.options = { ...review.options, mode: resolved.choices[0].mode };
      if (getAllRuns().some((run) => run.prWork?.id === workId(intent!))) continue;
      const originator = queued ? queueRecordOriginator(queued.id) : undefined;
      if (
        queued &&
        (queued.project !== source.project ||
          (queued.parentRunId ?? undefined) !== source.sourceReview?.runId ||
          (parent && queued.familyId !== parent.familyId) ||
          queued.flowType !== flowType ||
          queued.domain !== domain ||
          !isDeepStrictEqual(queued.qaProfileId, review.options.qaProfileId) ||
          !isDeepStrictEqual(queued.qaInputs, review.options.qaInputs) ||
          !isDeepStrictEqual(queued.prWork?.review, review) ||
          !isDeepStrictEqual(queued.prWork?.publication, publication) ||
          originator?.kind !== 'principal' ||
          originator.principalId !== source.ownerId ||
          (originator.principalGeneration ?? 0) !== (source.ownerGeneration ?? 0))
      ) {
        await this.store.updateDispatch(intent.id, { queueItemId: undefined, status: 'held' });
        await removeQueueItemInternalNow(queued.id, 'pr-review-remapped');
        queued = undefined;
      }
      // addItem deduplicates by this durable key, including recovery after a lost source link.
      const item =
        queued ??
        addItem(
          {
            prWork,
            flowType,
            ...(domain ? { domain } : {}),
            ...(parent
              ? {
                  parentRunId: parent.id,
                  familyId: parent.familyId,
                  familyRootTicketOrPr: parent.familyRootTicketOrPr ?? parent.ticketOrPr,
                }
              : {}),
            project: source.project,
            ticketOrPr: `${intent.pr.repo}#${intent.pr.number}`,
            ...(isPRWorkspaceExecutionChoice(resolved.choices[0])
              ? { reviewWorkspaceTarget: { machine: resolved.choices[0].machine } }
              : {
                  allowedSlots: [
                    ...new Set(
                      resolved.choices
                        .filter((choice) => !isPRWorkspaceExecutionChoice(choice))
                        .map((choice) => choice.slotId!),
                    ),
                  ],
                }),
            runner: resolved.choices[0].runner,
            transport: resolved.choices[0].transport ?? (parent ? 'tmux' : undefined),
            nativeProfile: resolved.choices[0].nativeProfile,
            model: executionModelFromSelection(resolved.choices[0]).model,
            effort: executionModelFromSelection(resolved.choices[0]).effort ?? undefined,
            completionPolicy: 'artifact-only',
            reviewMode: review.options.mode,
            qaProfileId: review.options.qaProfileId,
            qaInputs: review.options.qaInputs,
            mode: 'autonomous',
            autoDispatch: false,
            initialContext:
              prReviewWorkflow(review.options) === 'qa'
                ? `Validate the PR at ${intent.headSha} using the selected farm QA preset. Record the exact validated SHA, executed recipes and runtime evidence.`
                : `Review the PR at ${intent.headSha}. Record the exact reviewed SHA. Review profile: ${intent.reviewProfile}. Publication requires the project's normal review policy.`,
          },
          principalOwnerOriginator(source),
        );
      await persistQueueNow();
      const latest = this.store.intent(intent.id);
      if (
        !latest ||
        !reviewIntentAuthorized(latest) ||
        latest.status === 'withdrawn' ||
        latest.status === 'needs-configuration'
      ) {
        await removeQueueItemInternalNow(item.id, 'pr-review-policy-changed');
        continue;
      }
      if (latest.queueItemId !== item.id || latest.status !== 'queued') {
        await this.store.updateDispatch(intent.id, {
          queueItemId: item.id,
          status: 'queued',
          waitingReason: 'Awaiting an allowed slot and model',
        });
        this.changed();
      }
    }
    if (
      getQueueSnapshot().some((item) => item.prWork?.kind === 'review' && item.status === 'queued')
    )
      await tryDispatchNext();
  }

  async prepare(item: QueueItem): Promise<PRQueuePreparation> {
    const intent =
      item.prWork?.kind === 'review' ? this.store.intent(item.prWork.sourceId) : undefined;
    if (!intent || intent.queueItemId !== item.id)
      return { ready: false, reason: 'Review queue linkage is not ready' };
    const reason = this.refusal(intent, item);
    if (reason) return { ready: false, reason };
    const active = intent.contributions.filter((source) => source.eligible);
    const project = active[0]?.project;
    if (!project) return { ready: false, reason: 'Review project mapping is missing' };
    const resolved = await this.resolveExecution(
      project,
      intent.pr.repo,
      active.flatMap((source) => (source.execution ? [source.execution] : [])),
      { ownerId: active[0].ownerId },
    );
    resolved.choices = preferRetainedReviewer(intent, project, resolved.choices, getAllRuns());
    const workspaceRequired = prReviewWorkflow(active[0].review) === 'review';
    if (
      resolved.choices.some((choice) => isPRWorkspaceExecutionChoice(choice) !== workspaceRequired)
    ) {
      return {
        ready: false,
        reason: workspaceRequired
          ? 'Select workspace machines for static Review'
          : 'QA requires runtime slots',
      };
    }
    return resolved.choices.length
      ? { ready: true, choices: resolved.choices }
      : { ready: false, reason: resolved.errors.join('; ') };
  }

  async refreshBeforeCreate(item: QueueItem): Promise<void> {
    const intent =
      item.prWork?.kind === 'review' ? this.store.intent(item.prWork.sourceId) : undefined;
    if (!intent) throw new Error('PR review intent is unavailable');
    for (const source of intent.contributions.filter((entry) => entry.eligible)) {
      if (source.submissionId !== undefined) {
        const submission = await runWithPrincipalOwner(source, () =>
          this.rules.refreshSubmission(source.ownerId, source.submissionId!),
        );
        if (submission.error) throw new Error(submission.error);
        continue;
      }
      const observed = await runWithPrincipalOwner(source, () =>
        this.rules.refreshTarget(source.ownerId, source.ruleId!, intent.pr),
      );
      if (!observed.complete)
        throw new Error(
          `Review source observations are incomplete: ${observed.sourceErrors.join('; ')}`,
        );
    }
    const resolvedIntent = this.store.intent(intent.id);
    if (!resolvedIntent) throw new Error('PR review intent is unavailable');
    const resolvedFingerprint = fingerprint(resolvedIntent);
    const prepared = await this.prepare(item);
    if (!prepared.ready) throw new Error(prepared.reason);
    const latestIntent = this.store.intent(intent.id);
    if (!latestIntent || fingerprint(latestIntent) !== resolvedFingerprint)
      throw new Error('PR constraints changed during execution resolution; retry admission');
    const execution = executionModelFromSelection({
      runner: item.runner ?? '',
      model: item.model ?? null,
      effort: item.effort ?? null,
      mode: resolveReviewMode({ run: item }),
    });
    const selection = JSON.stringify([
      item.slotId ?? null,
      item.reviewWorkspaceTarget?.machine ?? null,
      item.runner,
      execution.model,
      execution.effort,
      item.transport ?? 'tmux',
      item.nativeProfile ?? null,
    ]);
    if (
      !prepared.choices.some((choice) => {
        const execution = executionModelFromSelection(choice);
        return (
          JSON.stringify([
            choice.slotId ?? null,
            choice.machine ?? null,
            choice.runner,
            execution.model,
            execution.effort,
            choice.transport ?? 'tmux',
            choice.nativeProfile ?? null,
          ]) === selection
        );
      })
    )
      throw new Error('Selected slot/model/effort is no longer authorized');
    this.proofs.set(item.id, {
      fingerprint: resolvedFingerprint,
      checkedAt: Date.now(),
      selection,
    });
  }

  assertCurrent(item: QueueItem): void {
    const intent =
      item.prWork?.kind === 'review' ? this.store.intent(item.prWork.sourceId) : undefined;
    const proof = this.proofs.get(item.id);
    const execution = executionModelFromSelection({
      runner: item.runner ?? '',
      model: item.model ?? null,
      effort: item.effort ?? null,
      mode: resolveReviewMode({ run: item }),
    });
    if (
      !intent ||
      !proof ||
      Date.now() - proof.checkedAt > 60_000 ||
      proof.fingerprint !== fingerprint(intent) ||
      proof.selection !==
        JSON.stringify([
          item.slotId ?? null,
          item.reviewWorkspaceTarget?.machine ?? null,
          item.runner,
          execution.model,
          execution.effort,
          item.transport ?? 'tmux',
          item.nativeProfile ?? null,
        ])
    )
      throw new Error('PR review admission changed; revalidate before dispatch');
    const reason = this.refusal(intent, item);
    if (reason) throw new Error(reason);
  }

  async created(item: QueueItem, run: Run): Promise<void> {
    if (item.prWork?.kind !== 'review') throw new Error('Unsupported PR automation work kind');
    await this.store.updateDispatch(item.prWork.sourceId, {
      runId: run.id,
      queueItemId: item.id,
      status: 'running',
      waitingReason: undefined,
    });
    this.proofs.delete(item.id);
    this.changed();
  }

  private refusal(intent: PRReviewIntent, item: QueueItem): string | undefined {
    if (this.store.admissionPending)
      return 'Review policy changes are being persisted; retry admission';
    if (intent.status !== 'queued' || !reviewIntentAuthorized(intent))
      return 'Review is held or no longer authorized';
    if (intent.pr.host.toLowerCase() !== 'github.com')
      return 'Project execution does not yet bind an enterprise GitHub host';
    if (!isDeepStrictEqual(item.prWork?.publication, publicationForIntent(intent, this.store)))
      return 'Review publication policy or account changed; queue replacement is pending';
    const active = intent.contributions.filter((source) => source.eligible);
    const options = active[0]?.review ?? DEFAULT_PR_REVIEW_OPTIONS;
    const sourceReview = active[0]?.sourceReview;
    if ((item.parentRunId ?? undefined) !== sourceReview?.runId)
      return 'QA source review linkage changed';
    if (sourceReview) {
      const originator = queueRecordOriginator(item.id);
      if (
        originator?.kind !== 'principal' ||
        originator.principalId !== active[0]?.ownerId ||
        (originator.principalGeneration ?? 0) !== (active[0]?.ownerGeneration ?? 0)
      )
        return 'Linked QA must retain the source review owner';
    }
    if (
      item.flowType !== (prReviewWorkflow(options) === 'qa' ? 'qa' : 'review-pr') ||
      !isDeepStrictEqual(item.qaProfileId, options.qaProfileId) ||
      !isDeepStrictEqual(item.qaInputs, options.qaInputs)
    )
      return 'Review/QA workflow or preset changed; queue replacement is pending';
    if (
      !isDeepStrictEqual(item.prWork?.review, {
        profile: intent.reviewProfile,
        ownerId: active[0]?.ownerId,
        ...(active[0]?.ownerGeneration !== undefined
          ? { ownerGeneration: active[0].ownerGeneration }
          : {}),
        options,
      })
    )
      return 'Reviewer configuration changed; queue replacement is pending';
    const snapshot = this.store.snapshot();
    for (const source of active) {
      if (source.sourceReview) {
        try {
          validateQaSourceReviewRecord(
            {
              runId: source.sourceReview.runId,
              ownerId: source.ownerId,
              ...(source.ownerGeneration !== undefined
                ? { ownerGeneration: source.ownerGeneration }
                : {}),
              project: source.project,
              pr: intent.pr,
              expected: source.sourceReview,
              observedHeadSha: intent.headSha,
            },
            getCachedRunWithArchived(source.sourceReview.runId),
          );
          if (item.familyId !== getCachedRunWithArchived(source.sourceReview.runId)?.familyId)
            return 'QA source review family changed';
        } catch (error) {
          if (!(error instanceof GatewayMethodError)) throw error;
          return error.message;
        }
      }
      const rule = snapshot.rules.find((entry) => entry.id === source.ruleId);
      const submission = snapshot.submissions?.find((entry) => entry.id === source.submissionId);
      const team = snapshot.teams.find((entry) => entry.id === source.teamId);
      if (this.replaced(source.ownerId, source.ownerGeneration ?? 0))
        return generationMismatchMessage(
          source.ownerId,
          're-create the rule or submission as the current identity.',
        );
      if (
        !this.authorized(source.ownerId, source.ownerGeneration ?? 0) ||
        (source.ruleId !== undefined
          ? !rule?.enabled || rule.scan.error || rule.revision !== source.ruleRevision
          : !submission || submission.error || submission.revision !== source.submissionRevision) ||
        team?.revision !== source.teamRevision
      )
        return 'Current rule, profile or originator authority is unavailable';
      if (source.project !== item.project) return 'Project mapping changed';
    }
    const owner = getAllRuns().find((run) => runOwnsPR(run, intent.pr, item.project));
    if (owner) return `Waiting for PR execution owned by run ${owner.id}`;
    const other = getQueueSnapshot().find(
      (entry) =>
        entry.id !== item.id &&
        entry.status === 'dispatching' &&
        entry.prWork &&
        monitoredPRKey(entry.prWork.pr) === monitoredPRKey(intent.pr),
    );
    if (other) return 'Another PR work item is claiming execution';
    return undefined;
  }

  private async observeRun(intent: PRReviewIntent, run: Run): Promise<void> {
    let status: PRReviewIntent['status'] = 'running';
    let reviewedSha: string | undefined;
    let waitingReason: string | undefined;
    if (isTerminalRunStatus(run.status)) {
      if (run.flowType === 'qa') {
        reviewedSha = completedQaHead(run, intent);
      } else {
        const result = reviewResultForRun(run);
        reviewedSha =
          result?.reviewSnapshot?.source !== 'unavailable'
            ? (result?.reviewSnapshot?.headSha ?? undefined)
            : undefined;
      }
      status = run.status === 'done' && reviewedSha ? 'completed' : 'failed';
      if (status === 'failed')
        waitingReason =
          run.flowType === 'qa'
            ? 'QA ended without verified runtime evidence; inspect the linked run'
            : 'Review ended without confirmed review evidence; inspect the linked run';
    }
    if (intent.status !== status || intent.runId !== run.id || intent.reviewedSha !== reviewedSha) {
      await this.store.updateDispatch(intent.id, {
        runId: run.id,
        status,
        reviewedSha,
        waitingReason,
      });
      this.changed();
    }
  }
}

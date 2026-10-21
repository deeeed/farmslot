import { randomUUID } from 'node:crypto';

import {
  type EvidenceAttestationApprover,
  FLOW_STEPS,
  githubPullUrl,
  type HumanPublicationAdoptionReceipt,
  parseGitHubPullUrl,
  PipelineSteps,
  PUBLICATION_ADOPTION_ACTION,
  type Run,
  type RunAdoptPublishedPrParams,
  type RunAdoptPublishedPrResult,
  type RunGatePrerequisiteReason,
  sameEvidenceAttestationApprover,
} from '@farmslot/protocol';

import { loadProjectVars } from '../../core/config.js';
import { GatewayMethodError } from '../../core/method-error.js';
import { ghRequest } from '../../integrations/github-client.js';
import { findPRNumber, recordRunPRPublication } from '../../integrations/pr-linkage.js';
import { adoptedPublicationContinuationRefusals } from '../../run-completion/human-publication.js';
import { collectRunGateReadiness } from '../../run-engine/gate-prerequisites.js';
import {
  operatorCompletionCollaborators,
  routeTerminalRunTransition,
} from '../../run-lifecycle/terminal-transition.js';
import { withRunTransition } from '../../run-lifecycle/transition-coordinator.js';
import { getRun, getRunWithArchived, persistRunNow } from '../../runs/store.js';
import { withRunSources } from '../../sources/runtime.js';

import type { releaseCompletedRunSlot } from './lifecycle-control.js';

interface PublishedPrFacts {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  draft: boolean;
  base: { repo: { full_name: string } };
  head: { sha: string; ref: string; repo: { full_name: string } | null };
}

export interface PublicationAdoptionDependencies {
  authorizeEvidenceAttestation?: () => EvidenceAttestationApprover;
  repository?: (run: Run) => Promise<string | undefined>;
  github?: typeof ghRequest;
  discover?: typeof findPRNumber;
  readiness?: typeof collectRunGateReadiness;
  continuationRefusals?: typeof adoptedPublicationContinuationRefusals;
  continueDecision?: (run: Run, decisionId: string) => Promise<boolean>;
  releaseSlot?: typeof releaseCompletedRunSlot;
}

function adoptionIdentity(run: Run): string {
  return JSON.stringify({
    generation: run.engineState?.generation ?? 0,
    archivedAt: run.archivedAt ?? null,
    project: run.project,
    branch: run.branch,
    status: run.status,
    sourcePlan: run.sourcePlan,
    sourceProvenance: run.sourceProvenance,
    gate: run.engineState?.publishGate,
    prNumber: run.prNumber,
    publications: run.prPublications,
    decisions: run.decisions,
  });
}

function assertPublicationRun(run: Run): void {
  if (
    run.readOnly ||
    !['dev', 'fix-bug'].includes(run.flowType) ||
    run.completionPolicy === 'artifact-only'
  )
    throw new Error(
      'Only writable dev or fix-bug publication runs accept human-published PR adoption',
    );
  if (!run.branch) throw new Error('Publication adoption requires the retained run branch');
  if (run.engineState?.publishGate?.publicationStatus === 'pending_publish')
    throw new Error('Reconcile the in-flight publication before adoption');
}

function assertMatchingPublication(run: Run, repository: string, number: number): void {
  const numbers = [run.prNumber, run.engineState?.publishGate?.prNumber, run.prWork?.pr.number];
  if (numbers.some((entry) => entry != null && entry > 0 && entry !== number))
    throw new Error('The run already links a different PR');
  for (const publication of run.prPublications ?? []) {
    if (
      publication.pr.repo.toLowerCase() !== repository.toLowerCase() ||
      publication.pr.number !== number
    )
      throw new Error('The run already records a different publication');
  }
  for (const link of run.links ?? []) {
    if (link.label.toLowerCase() !== 'pr') continue;
    const ref = parseGitHubPullUrl(link.url);
    if (!ref || ref.repo.toLowerCase() !== repository.toLowerCase() || ref.number !== number)
      throw new Error('The run already links a different publication repository or PR');
  }
}

function unavailableReadiness(error: unknown): RunGatePrerequisiteReason[] {
  return [
    {
      code: 'publication-readiness-unknown',
      prerequisite: 'lifecycle',
      message: `Readiness could not be evaluated: ${(error as Error).message}`,
    },
  ];
}

export async function runAdoptPublishedPr(
  params: RunAdoptPublishedPrParams,
  emit: (event: string, payload: unknown) => void,
  dependencies: PublicationAdoptionDependencies = {},
): Promise<RunAdoptPublishedPrResult> {
  const authorize = dependencies.authorizeEvidenceAttestation;
  if (!authorize)
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Publication adoption requires an authenticated person attestation',
    );
  const approver = authorize();
  if (params.attestReviewedPublication !== true || !params.reason?.trim())
    throw new Error('Explicit reviewed-publication attestation and a written reason are required');
  if (!/^[a-f0-9]{40}$/i.test(params.headSha ?? ''))
    throw new Error('Publication adoption requires a full commit SHA');
  const ref = parseGitHubPullUrl(params.prRef);
  if (!ref) throw new Error('Publication adoption requires a GitHub pull request URL');
  const headSha = params.headSha.toLowerCase();
  const initial = await getRunWithArchived(params.runId);
  if (!initial) throw new Error(`Run not found: ${params.runId}`);
  assertPublicationRun(initial);
  const identity = adoptionIdentity(initial);
  const previous = initial.engineState?.publishGate?.humanPublicationAdoption;
  let receipt: HumanPublicationAdoptionReceipt | undefined = previous;
  if (previous) {
    if (
      previous.repository.toLowerCase() !== ref.repo.toLowerCase() ||
      previous.prNumber !== ref.number ||
      previous.headSha !== headSha
    )
      throw new Error('Conflicting human publication adoption');
  } else {
    const repository = await (
      dependencies.repository ??
      ((run) =>
        withRunSources(run, async () => (await loadProjectVars(run.project)).projectJson.ci?.repo, {
          planning: true,
        }))
    )(initial);
    if (!repository || repository.toLowerCase() !== ref.repo.toLowerCase())
      throw new Error('The PR does not match the run declared repository');
    assertMatchingPublication(initial, repository, ref.number);
    const github = dependencies.github ?? ghRequest;
    const facts: PublishedPrFacts = JSON.parse(
      (await github(['api', `repos/${repository}/pulls/${ref.number}`], { force: true })).stdout,
    );
    if (
      facts.number !== ref.number ||
      facts.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      facts.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      facts.head.ref !== initial.branch ||
      !/^[a-f0-9]{40}$/i.test(facts.head.sha) ||
      typeof facts.draft !== 'boolean' ||
      !['open', 'closed'].includes(facts.state)
    )
      throw new Error('GitHub PR facts do not match the retained repository and branch');
    if (headSha !== facts.head.sha.toLowerCase()) {
      const commits = (
        await github(
          [
            'api',
            `repos/${repository}/pulls/${ref.number}/commits`,
            '--paginate',
            '--jq',
            '.[].sha',
          ],
          { force: true },
        )
      ).stdout.split(/\s+/);
      if (!commits.some((sha) => sha.toLowerCase() === headSha))
        throw new Error('The attested head is not in this PR history');
    }
    const discovered = await (dependencies.discover ?? findPRNumber)(initial, repository, {
      noRetry: true,
    });
    if (discovered && discovered !== ref.number)
      throw new Error('The retained branch discovers a different PR');
    const gate = initial.engineState?.publishGate;
    const decision = [...initial.decisions]
      .reverse()
      .find(
        (candidate) =>
          (initial.archivedAt || !candidate.resolvedAt) &&
          candidate.type === 'engine_human_gate' &&
          candidate.payload?.kind === 'ready',
      );
    const prepared = decision?.payload?.kind === 'ready' ? decision.payload.prPackage : undefined;
    let unmetPrerequisites: RunGatePrerequisiteReason[] = [];
    if (decision && !initial.archivedAt) {
      try {
        unmetPrerequisites = (
          await (dependencies.readiness ?? collectRunGateReadiness)(initial, prepared ?? null)
        ).reasons;
      } catch (error) {
        unmetPrerequisites = unavailableReadiness(error);
      }
    }
    receipt = {
      schemaVersion: 1,
      id: randomUUID(),
      runId: initial.id,
      generation: initial.engineState?.generation ?? 0,
      approver,
      reason: params.reason.trim(),
      adoptedAt: new Date().toISOString(),
      repository,
      prNumber: ref.number,
      prUrl: githubPullUrl({ repo: repository, number: ref.number }),
      headSha,
      observedHeadSha: facts.head.sha.toLowerCase(),
      observedBranch: facts.head.ref,
      observedDraft: facts.draft,
      observedState: facts.merged_at ? 'merged' : facts.state,
      publicationStatus: facts.draft ? 'published_draft' : 'published_ready',
      ...(gate || decision
        ? {
            priorGate: {
              decisionId: decision?.id,
              packageId: gate?.packageId,
              packageHash: gate?.packageHash,
              headSha: prepared?.headSha,
              unmetPrerequisites,
            },
          }
        : {}),
    };
  }
  let completed = false;
  const result = await withRunTransition<RunAdoptPublishedPrResult>(initial.id, async () => {
    const currentApprover = authorize();
    if (!sameEvidenceAttestationApprover(currentApprover, approver))
      throw new GatewayMethodError(
        'AUTH_FORBIDDEN',
        'Publication attestation caller changed during verification',
      );
    const current = await getRunWithArchived(initial.id);
    if (!current) throw new Error('Publication run became unavailable');
    const concurrent = current.engineState?.publishGate?.humanPublicationAdoption;
    if (concurrent) {
      if (
        concurrent.repository.toLowerCase() !== ref.repo.toLowerCase() ||
        concurrent.prNumber !== ref.number ||
        concurrent.headSha !== headSha
      )
        throw new Error('Conflicting human publication adoption');
      receipt = concurrent;
    } else if (adoptionIdentity(current) !== identity) {
      throw new Error('Publication run changed during verification');
    }
    const currentIdentity = adoptionIdentity(current);
    const projectionRefusals: RunGatePrerequisiteReason[] = [];
    await recordRunPRPublication(current.id, receipt!.repository, receipt!.prNumber, {
      adoption: receipt!,
      assertCurrent: (run) => {
        const person = authorize();
        if (!sameEvidenceAttestationApprover(person, approver))
          throw new GatewayMethodError('AUTH_FORBIDDEN', 'Publication attestation caller changed');
        if (adoptionIdentity(run) !== currentIdentity)
          throw new Error('Publication run changed before persistence');
        assertPublicationRun(run);
        assertMatchingPublication(run, receipt!.repository, receipt!.prNumber);
      },
      onProjectionFailure: (error) =>
        projectionRefusals.push({
          code: 'publication-projection-failed',
          prerequisite: 'lifecycle',
          message: `Publication is durable but its update projection failed: ${(error as Error).message}`,
        }),
    });
    const run = (await getRunWithArchived(initial.id))!;
    const result: RunAdoptPublishedPrResult = {
      run,
      receipt: receipt!,
      archived: Boolean(run.archivedAt),
      target: { repository: receipt!.repository, prNumber: receipt!.prNumber },
      continuation: run.archivedAt ? 'archived' : 'waiting',
      refusals: projectionRefusals,
    };
    if (projectionRefusals.length) return { ...result, continuation: 'refused' };
    if (result.archived || !getRun(run.id) || run.status === 'done') return result;
    const continuationIdentity = adoptionIdentity(run);
    try {
      result.refusals = await (
        dependencies.continuationRefusals ?? adoptedPublicationContinuationRefusals
      )(run);
    } catch (error) {
      result.refusals = unavailableReadiness(error);
    }
    if (result.refusals.length) return { ...result, continuation: 'refused' };
    const { publishCompletedRun } = await import('./lifecycle-control.js');
    const afterReadiness = getRun(run.id);
    if (!afterReadiness || adoptionIdentity(afterReadiness) !== continuationIdentity) return result;
    // A lost engine can leave every step settled with no publication decision
    // to wake. Skipped finalization/CI are settled work, not steps to replay.
    if (
      ['reconciling', 'blocked', 'human-gating'].includes(afterReadiness.status) &&
      FLOW_STEPS[afterReadiness.flowType].every((name) =>
        afterReadiness.steps.some(
          (step) =>
            step.name === name &&
            (step.status === 'done' ||
              (step.status === 'skipped' &&
                (name === PipelineSteps.FINALIZE || name === PipelineSteps.CI_WATCH))),
        ),
      )
    ) {
      const stepsIdentity = JSON.stringify(afterReadiness.steps);
      const transition = await routeTerminalRunTransition({
        kind: 'complete',
        runId: afterReadiness.id,
        actor: 'operator',
        settlingStatus: afterReadiness.status,
        persist: persistRunNow,
        before: [
          {
            name: 'adoption-continuation-current',
            severity: 'required',
            apply: ({ run: latest }) => {
              if (
                adoptionIdentity(latest) !== continuationIdentity ||
                JSON.stringify(latest.steps) !== stepsIdentity
              )
                throw new Error('Publication continuation changed before completion');
            },
          },
        ],
        patch: {
          status: 'done',
          error: undefined,
          completedAt: new Date().toISOString(),
          metrics: {
            ...afterReadiness.metrics,
            outcome: 'success',
            durationMs: Date.now() - Date.parse(afterReadiness.createdAt),
          },
        },
        collaborators: operatorCompletionCollaborators(publishCompletedRun),
      });
      if (!transition) return result;
      completed = true;
      return {
        ...result,
        run: transition.run,
        continuation: 'resumed' as const,
        refusals: transition.effects
          .filter((effect) => effect.status === 'failed')
          .map((effect) => ({
            code: 'publication-continuation-effect-failed',
            prerequisite: 'lifecycle' as const,
            message: `${effect.name}: ${effect.detail}`,
          })),
      };
    }
    if (!receipt!.priorGate?.decisionId) return result;
    const resumed = await (
      dependencies.continueDecision ??
      (async (updated, decisionId) => {
        const { continueResolvedRunDecision } = await import('../run.js');
        return continueResolvedRunDecision(
          { runId: updated.id, decisionId, actionId: PUBLICATION_ADOPTION_ACTION },
          emit,
          {},
          updated.engineState?.generation ?? 0,
        );
      })
    )(run, receipt!.priorGate!.decisionId!);
    return { ...result, continuation: resumed ? 'resumed' : 'waiting' };
  });
  if (!completed) return result;
  // Release can join another machine/run transition; never hold those keys here.
  const { collectCompletedRunSlotReleaseEffect } = await import('./lifecycle-control.js');
  const effects = await collectCompletedRunSlotReleaseEffect(result.run, dependencies.releaseSlot);
  return {
    ...result,
    run: getRun(initial.id) ?? result.run,
    refusals: [
      ...result.refusals,
      ...effects
        .filter((effect) => effect.status === 'failed')
        .map((effect) => ({
          code: 'publication-continuation-effect-failed',
          prerequisite: 'lifecycle' as const,
          message: `${effect.name}: ${effect.detail}`,
        })),
    ],
  };
}

import {
  deriveReviewedRecipeClaims,
  validateRecordedEvidencePackage,
} from '@farmslot/adapter-sdk/evidence';
import {
  type AgentContext,
  contextIdFor,
  digestRecipeDocument,
  type NativeSessionReadResult,
  nativeStructuredResult,
  PIPELINE_VISUAL_RESULT_SCHEMA,
  type PipelineVisualReviewerBinding,
  type PipelineVisualReviewInput,
  type PipelineVisualReviewResult,
  primaryRoleForFlow,
  type RecipeVisualJudgmentReceipt,
  recordedEvidenceClosureIdentity,
  reviewedVisualFiles,
  type Run,
  visualClaimRequiresPerson,
} from '@farmslot/protocol';

import { captureRunOutput } from '../run-completion/output.js';
import { readVisualReviewPolicy } from '../run-engine/claim-reviews.js';
import {
  readFrozenPublicationRecipeSources,
  readGateRecordedEvidenceSources,
  recordedEvidenceRoots,
  type RecordedEvidenceSource,
} from '../run-engine/recorded-evidence-sources.js';
import { commitRunVisualJudgment, getRun } from '../runs/store.js';

/** A reviewer reads the same retained selection as publication, never a second artifact parser. */
export async function capturePipelineVisualInput(
  runId: string,
  headSha: string,
): Promise<PipelineVisualReviewInput | undefined> {
  let run = getRun(runId);
  if (!run) throw new Error('Pipeline visual review run is unavailable');
  const prepared = [...run.decisions]
    .reverse()
    .find((d) => !d.resolvedAt && d.payload?.kind === 'ready')?.payload;
  let sources;
  if (prepared?.kind === 'ready' && prepared.prPackage?.headSha === headSha) {
    if (
      !recordedEvidenceRoots(
        prepared.prPackage.evidenceManifest ?? [],
        prepared.prPackage.selectedEvidenceKeys,
      ).length
    )
      return;
    sources = await readGateRecordedEvidenceSources(run, prepared.prPackage);
  } else {
    await captureRunOutput(runId);
    run = getRun(runId)!;
    if (!run.output) return;
    // Code-only reviews still run. No selected engine attempt grants visual authority.
    if (
      !run.output.artifactManifest.some(
        (a) =>
          a.path === 'artifacts/latest-valid-recipe-run.json' ||
          a.purpose === 'evidence-manifest-source',
      )
    )
      return;
    sources = await readFrozenPublicationRecipeSources(
      run,
      run.output.artifactManifest,
      [],
      run.output.artifactBundle,
    );
  }
  if (sources.length !== 1) return;
  const { input, artifactPrefix } = sources[0]!;
  if (!input.claims || validateRecordedEvidencePackage(input, { headSha }).status !== 'valid')
    return;
  const policy = await readVisualReviewPolicy(run);
  const claims = deriveReviewedRecipeClaims(input)
    .filter(
      (claim) =>
        claim.verdict === 'awaiting-review' &&
        ['visual', 'mixed'].includes(claim.proofMode) &&
        claim.assertionIndices.length &&
        !visualClaimRequiresPerson(input, claim.id, policy),
    )
    .map((claim) => ({
      claimId: claim.id,
      text: claim.text,
      reviewedFiles: reviewedVisualFiles(input, claim.id),
      moments: claim.moments,
    }));
  if (!claims.length) return;
  return {
    headSha,
    recipeRunId: input.claims.recipeRunId,
    closureIdentity: recordedEvidenceClosureIdentity(input),
    artifactPrefix,
    claims,
  };
}

export function pipelineReviewerBinding(
  run: Run,
  context: AgentContext,
): PipelineVisualReviewerBinding {
  const b = context.nativeSession;
  const producerId = contextIdFor(primaryRoleForFlow(run.flowType));
  const producing = (candidate: AgentContext) =>
    candidate.role !== 'review' || candidate.id === producerId;
  if (
    context.role !== 'review' ||
    context.id === producerId ||
    context.runId !== run.id ||
    context.slotId !== run.slotId ||
    context.target ||
    context.nativeSessionOwner ||
    !b?.generation ||
    !b.acceptedAt ||
    b.releasedAt ||
    b.resultSchema !== PIPELINE_VISUAL_RESULT_SCHEMA ||
    !context.runnerSessionId
  )
    throw new Error('Visual verification requires an independent admitted native review command');
  const producerBindings = (run.agentContexts ?? [])
    .filter(producing)
    .flatMap((c) => [c.nativeSession, ...(c.nativeSessionHistory ?? [])]);
  if (
    producerBindings.some((p) => p?.sessionId === b.sessionId) ||
    run.agentContexts?.some(
      (c) =>
        producing(c) &&
        (c.runnerSessionId === context.runnerSessionId ||
          c.nativeSessionOwner?.sessionId === b.sessionId),
    )
  )
    throw new Error('The producing worker cannot verify its own visual evidence');
  return {
    contextId: context.id,
    executionNodeId: b.executionNodeId,
    ownerPrincipalId: b.ownerPrincipalId,
    sessionId: b.sessionId,
    generation: b.generation,
    leaseId: b.leaseId,
    commandId: b.commandId,
  };
}

/** Collection accepts only the completed command's constrained result, after the terminal artifact contract. */
export function collectPipelineVisualResult(
  run: Run,
  context: AgentContext,
  snapshot: NativeSessionReadResult,
): PipelineVisualReviewResult | undefined {
  const input = context.pipelineVisualReviewInput;
  if (!input) return;
  const binding = pipelineReviewerBinding(run, context);
  const command = snapshot.commands.find(
    (c) => c.commandId === binding.commandId && c.generation === binding.generation,
  );
  const result =
    command?.structuredResult &&
    nativeStructuredResult(command.structuredResult.schema, command.structuredResult.value);
  if (
    snapshot.session.id !== binding.sessionId ||
    snapshot.session.generation !== binding.generation ||
    snapshot.session.executionNodeId !== binding.executionNodeId ||
    snapshot.session.ownerPrincipalId !== binding.ownerPrincipalId ||
    snapshot.session.workerLeaseId !== binding.leaseId ||
    snapshot.session.workerManaged !== true ||
    snapshot.session.resultSchema !== PIPELINE_VISUAL_RESULT_SCHEMA ||
    snapshot.session.nativeSessionId !== context.runnerSessionId ||
    command?.state !== 'completed' ||
    command.outcome !== 'completed' ||
    !command.accepted ||
    !command.submitted ||
    !result
  )
    throw new Error('Visual review has no matching schema-bound completed native command');
  if (
    result.value.recipeRunId !== input.recipeRunId ||
    result.value.closureIdentity !== input.closureIdentity ||
    result.value.judgments.some((j) => {
      const claim = input.claims.find((c) => c.claimId === j.claimId);
      return (
        !claim ||
        digestRecipeDocument(j.reviewedFiles) !== digestRecipeDocument(claim.reviewedFiles) ||
        digestRecipeDocument(j.moments) !== digestRecipeDocument(claim.moments)
      );
    })
  )
    throw new Error('Visual review does not match the recorded launch evidence');
  return {
    headSha: input.headSha,
    binding,
    result: result.value,
    completedAt: new Date().toISOString(),
  };
}

export function pipelineVisualReviewPrompt(
  input: PipelineVisualReviewInput,
  taskDir: string,
): string {
  return `\n## Independent visual verification\nInspect the retained media for each AC below. Paths are relative to ${taskDir}/${input.artifactPrefix}. Check the stills and exact engine moments, not the worker's claims. Keep the code review report and terminal mark as instructed. Your FINAL response must be only the schema-constrained JSON result with schemaVersion 1, recipeRunId ${JSON.stringify(input.recipeRunId)}, closureIdentity ${JSON.stringify(input.closureIdentity)}, and judgments. Each judgment has claimId, verdict confirmed/rejected, a concrete one-line reason, and the exact reviewedFiles/moments below. Omit any AC you cannot inspect; do not infer success from the overall code review.\n${JSON.stringify(input.claims, null, 2)}\n`;
}

/** Package preparation is the sole activation point for validated launch results. */
export async function stampPipelineVisualReviews(
  run: Run,
  sources: readonly RecordedEvidenceSource[],
  headSha: string,
): Promise<void> {
  const policy = await readVisualReviewPolicy(run);
  const generation = run.engineState?.generation ?? 0;
  const taskFile = run.taskFile;
  const slotId = run.slotId;
  for (const context of run.agentContexts ?? []) {
    const verified = context.pipelineVisualReviewResult;
    if (
      !verified ||
      verified.headSha !== headSha ||
      !context.reviewResultValidatedAt ||
      context.status !== 'complete'
    )
      continue;
    const source = sources.find(
      (s) =>
        s.input.claims?.recipeRunId === verified.result.recipeRunId &&
        recordedEvidenceClosureIdentity(s.input) === verified.result.closureIdentity,
    );
    if (!source || validateRecordedEvidencePackage(source.input, { headSha }).status !== 'valid')
      continue;
    const claims = deriveReviewedRecipeClaims(source.input);
    for (const judgment of verified.result.judgments) {
      const claim = claims.find((c) => c.id === judgment.claimId);
      if (
        !claim ||
        claim.verdict !== 'awaiting-review' ||
        visualClaimRequiresPerson(source.input, claim.id, policy) ||
        digestRecipeDocument(judgment.reviewedFiles) !==
          digestRecipeDocument(reviewedVisualFiles(source.input, claim.id)) ||
        digestRecipeDocument(judgment.moments) !== digestRecipeDocument(claim.moments)
      )
        continue;
      const id = `pipeline-${digestRecipeDocument({ binding: verified.binding, closure: verified.result.closureIdentity, claimId: claim.id })}`;
      if (run.visualJudgmentReceipts?.some((r) => r.id === id)) continue;
      const receipt: RecipeVisualJudgmentReceipt = {
        id,
        runId: run.id,
        snapshotIdentity: verified.result.closureIdentity,
        closureIdentity: verified.result.closureIdentity,
        recipeRunId: verified.result.recipeRunId,
        claimId: claim.id,
        verdict: judgment.verdict,
        reason: judgment.reason,
        moments: judgment.moments,
        reviewedFiles: judgment.reviewedFiles,
        kind: 'pipeline-reviewed',
        reviewerSubjectKind: 'service',
        pipeline: verified.binding,
        approver: {
          principalId: `native-review:${verified.binding.sessionId}:${verified.binding.leaseId}`,
          displayName: 'Independent review',
        },
        judgedAt: verified.completedAt,
      };
      await commitRunVisualJudgment(
        run.id,
        (current) => current.visualJudgmentReceipts?.find((r) => r.id === id) ?? receipt,
        async (current) => {
          const latest = current.agentContexts?.find((c) => c.id === context.id);
          if (
            current.readOnly ||
            current.taskFile !== taskFile ||
            current.slotId !== slotId ||
            (current.engineState?.generation ?? 0) !== generation ||
            !latest ||
            latest.status !== 'complete' ||
            digestRecipeDocument(latest.pipelineVisualReviewResult) !==
              digestRecipeDocument(verified) ||
            digestRecipeDocument(pipelineReviewerBinding(current, latest)) !==
              digestRecipeDocument(verified.binding) ||
            digestRecipeDocument(await readVisualReviewPolicy(current)) !==
              digestRecipeDocument(policy)
          )
            throw new Error(
              'The qualified pipeline review changed before its receipt was retained',
            );
        },
      );
    }
  }
}

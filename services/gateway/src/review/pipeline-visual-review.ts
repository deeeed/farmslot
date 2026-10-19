import {
  deriveReviewedRecipeClaims,
  recordedClaimSources,
  validateRecordedEvidencePackage,
} from '@farmslot/adapter-sdk/evidence';
import {
  type AgentContext,
  contextIdFor,
  digestRecipeDocument,
  isNativeResultSchema,
  isPipelineRepairVisualReviewInput,
  isRecipeRepairScope,
  type NativeResultSchema,
  type NativeSessionReadResult,
  nativeStructuredResult,
  PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA,
  PIPELINE_VISUAL_RESULT_SCHEMA,
  type PipelineRepairReviewerJudgments,
  type PipelineRepairVisualJudgments,
  type PipelineRepairVisualReviewInput,
  type PipelineReviewInput,
  type PipelineVisualJudgments,
  type PipelineVisualReviewerBinding,
  type PipelineVisualReviewerJudgments,
  type PipelineVisualReviewInput,
  type PipelineVisualReviewResult,
  primaryRoleForFlow,
  recipeRepairScopeDigest,
  type RecipeVisualJudgmentReceipt,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
  reviewedVisualFiles,
  type Run,
} from '@farmslot/protocol';

import { captureRunOutput } from '../run-completion/output.js';
import {
  readFrozenPublicationRecipeSources,
  readGateRecordedEvidenceSources,
  recordedEvidenceRoots,
  type RecordedEvidenceSource,
} from '../run-engine/recorded-evidence-sources.js';
import { recordVisualRepairApplicability } from '../run-engine/visual-repair.js';
import { commitRunVisualJudgment, getRun } from '../runs/store.js';

/** The result contract a captured review input binds its reviewer to. */
export function pipelineReviewResultSchema(input: PipelineReviewInput): NativeResultSchema {
  return isPipelineRepairVisualReviewInput(input)
    ? PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA
    : PIPELINE_VISUAL_RESULT_SCHEMA;
}

function freshVisualSource(
  input: RecordedEvidencePackageInput,
  artifactPrefix: string,
  headSha: string,
  claimIds?: ReadonlySet<string>,
): PipelineVisualReviewInput | undefined {
  const claims = deriveReviewedRecipeClaims(input)
    .filter(
      (claim) =>
        (!claimIds || claimIds.has(claim.id)) &&
        claim.verdict === 'awaiting-review' &&
        ['visual', 'mixed'].includes(claim.proofMode) &&
        claim.assertionIndices.length,
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
    recipeRunId: input.claims!.recipeRunId,
    closureIdentity: recordedEvidenceClosureIdentity(input),
    artifactPrefix,
    claims,
  };
}

/** A reviewer reads the same retained selection as publication, never a second artifact parser. */
export async function capturePipelineVisualInput(
  runId: string,
  range: { baseSha: string; headSha: string },
  descends: (ancestor: string, head: string) => Promise<boolean>,
): Promise<PipelineReviewInput | undefined> {
  const headSha = range.headSha;
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
  if (!input.repair) return freshVisualSource(input, artifactPrefix, headSha);
  if (!isRecipeRepairScope(input.repair.scope)) return;
  const scope = input.repair.scope;
  const scopeDigest = recipeRepairScopeDigest(scope);
  // Only an authorised repair at its frozen review base and ancestry may classify retained proof.
  if (
    !run.engineState?.publishGate?.visualRepairs?.some(
      (record) => record.repairId === scope.repairId && record.scopeDigest === scopeDigest,
    ) ||
    range.baseSha !== scope.reviewBaseSha ||
    !(await descends(scope.packageHeadSha, headSha))
  )
    return;
  const selected = recordedClaimSources(input);
  const fresh = freshVisualSource(
    input,
    artifactPrefix,
    headSha,
    new Set(selected.filter(({ artifactRoot }) => !artifactRoot).map(({ claimId }) => claimId)),
  );
  const retained = selected.flatMap(({ claimId, input: source, artifactRoot }) => {
    if (!artifactRoot) return [];
    const recipeRunId = source.claims!.recipeRunId;
    const recorded = scope.sources.find((entry) => entry.recipeRunId === recipeRunId);
    const claim = source.claims!.criteria.find(({ id }) => id === claimId);
    return recorded && claim
      ? [
          {
            claimId,
            text: claim.text,
            recipeRunId,
            closureIdentity: recordedEvidenceClosureIdentity(source),
            sourceHeadSha: recorded.headSha,
          },
        ]
      : [];
  });
  if (!fresh && !retained.length) return;
  return {
    schemaVersion: 2,
    headSha,
    repairId: scope.repairId,
    scopeDigest,
    sources: fresh ? [fresh] : [],
    retained,
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
    !isNativeResultSchema(b.resultSchema) ||
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
    snapshot.session.resultSchema !== pipelineReviewResultSchema(input) ||
    context.nativeSession?.resultSchema !== pipelineReviewResultSchema(input) ||
    snapshot.session.nativeSessionId !== context.runnerSessionId ||
    command?.state !== 'completed' ||
    command.outcome !== 'completed' ||
    !command.accepted ||
    !command.submitted ||
    !result
  )
    throw new Error('Visual review has no matching schema-bound completed native command');
  const bound = isPipelineRepairVisualReviewInput(input)
    ? result.schema === PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA &&
      bindRepairResult(input, result.value)
    : result.schema === PIPELINE_VISUAL_RESULT_SCHEMA && bindSourceResult(input, result.value);
  if (!bound) throw new Error('Visual review does not match the recorded launch evidence');
  return {
    headSha: input.headSha,
    binding,
    result: bound,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Binds a result to the closure captured at launch for its recipeRunId. A reviewer is never asked
 * to echo that hash (a model once mis-copied it), so any value it returns is ignored. A different
 * recipeRunId, AC, reviewed file or moment still fails collection.
 */
function bindSourceResult(
  input: PipelineVisualReviewInput,
  value: PipelineVisualReviewerJudgments,
): PipelineVisualJudgments | undefined {
  const matches =
    value.recipeRunId === input.recipeRunId &&
    value.judgments.every((j) => {
      const claim = input.claims.find((c) => c.claimId === j.claimId);
      return (
        claim &&
        digestRecipeDocument(j.reviewedFiles) === digestRecipeDocument(claim.reviewedFiles) &&
        digestRecipeDocument(j.moments) === digestRecipeDocument(claim.moments)
      );
    });
  return matches ? { ...value, closureIdentity: input.closureIdentity } : undefined;
}

function bindRepairResult(
  input: PipelineRepairVisualReviewInput,
  value: PipelineRepairReviewerJudgments,
): PipelineRepairVisualJudgments | undefined {
  if (value.headSha !== input.headSha || value.scopeDigest !== input.scopeDigest) return;
  const sources: PipelineVisualJudgments[] = [];
  for (const source of value.sources) {
    const entry = input.sources.find((candidate) => candidate.recipeRunId === source.recipeRunId);
    const bound = entry && bindSourceResult(entry, source);
    if (!bound) return;
    sources.push(bound);
  }
  const retained: PipelineRepairVisualJudgments['retained'] = [];
  for (const row of value.retained) {
    const entry = input.retained.find(
      (candidate) => candidate.claimId === row.claimId && candidate.recipeRunId === row.recipeRunId,
    );
    if (!entry) return;
    retained.push({ ...row, closureIdentity: entry.closureIdentity });
  }
  return { ...value, sources, retained };
}

export function pipelineVisualReviewPrompt(input: PipelineReviewInput, taskDir: string): string {
  if (isPipelineRepairVisualReviewInput(input))
    return `\n## Independent visual verification of a repair\nThis head repairs criteria a person or reviewer rejected. Keep the code review report and terminal mark as instructed. Your FINAL response must be only the schema-constrained JSON result with schemaVersion 2, headSha ${JSON.stringify(input.headSha)}, scopeDigest ${JSON.stringify(input.scopeDigest)}, sources and retained.\nsources: for each fresh source below, inspect its retained media (paths relative to ${taskDir}/<artifactPrefix>) and return its recipeRunId and judgments exactly as for a normal visual verification: claimId, verdict confirmed/rejected, a concrete one-line reason, and the exact reviewedFiles/moments listed. Omit any AC you cannot inspect.\nretained: these ACs keep older proof recorded at sourceHeadSha. Read git diff <sourceHeadSha>..${input.headSha} and set unaffected true only when that change cannot alter what the AC proves; otherwise false. Each row has claimId, recipeRunId, unaffected and a concrete one-line reason. Do not infer success from the overall code review.\nFresh sources:\n${JSON.stringify(input.sources.map(withoutClosure), null, 2)}\nRetained:\n${JSON.stringify(input.retained.map(withoutClosure), null, 2)}\n`;
  return `\n## Independent visual verification\nInspect the retained media for each AC below. Paths are relative to ${taskDir}/${input.artifactPrefix}. Check the stills and exact engine moments, not the worker's claims. Keep the code review report and terminal mark as instructed. Your FINAL response must be only the schema-constrained JSON result with schemaVersion 1, recipeRunId ${JSON.stringify(input.recipeRunId)} and judgments. Each judgment has claimId, verdict confirmed/rejected, a concrete one-line reason, and the exact reviewedFiles/moments below. Omit any AC you cannot inspect; do not infer success from the overall code review.\n${JSON.stringify(input.claims, null, 2)}\n`;
}

function withoutClosure<T extends { closureIdentity: string }>({
  closureIdentity: _closure,
  ...rest
}: T): Omit<T, 'closureIdentity'> {
  return rest;
}

/** Package preparation is the sole activation point for validated launch results. */
export async function stampPipelineVisualReviews(
  run: Run,
  sources: readonly RecordedEvidenceSource[],
  headSha: string,
): Promise<void> {
  for (const context of run.agentContexts ?? []) {
    const verified = context.pipelineVisualReviewResult;
    if (
      !verified ||
      verified.headSha !== headSha ||
      !context.reviewResultValidatedAt ||
      context.status !== 'complete'
    )
      continue;
    if ('retained' in verified.result)
      await recordVisualRepairApplicability(run, context, verified, sources, headSha);
    for (const result of 'judgments' in verified.result
      ? [verified.result]
      : verified.result.sources) {
      await stampSourceJudgments(run, context, verified, result, sources, headSha);
    }
  }
}

async function stampSourceJudgments(
  run: Run,
  context: AgentContext,
  verified: PipelineVisualReviewResult,
  result: PipelineVisualJudgments,
  sources: readonly RecordedEvidenceSource[],
  headSha: string,
): Promise<void> {
  const generation = run.engineState?.generation ?? 0;
  const taskFile = run.taskFile;
  const slotId = run.slotId;
  const source = sources.find(
    (s) =>
      s.input.claims?.recipeRunId === result.recipeRunId &&
      recordedEvidenceClosureIdentity(s.input) === result.closureIdentity,
  );
  if (!source || validateRecordedEvidencePackage(source.input, { headSha }).status !== 'valid')
    return;
  const claims = deriveReviewedRecipeClaims(source.input);
  for (const judgment of result.judgments) {
    const claim = claims.find((c) => c.id === judgment.claimId);
    if (
      !claim ||
      claim.verdict !== 'awaiting-review' ||
      digestRecipeDocument(judgment.reviewedFiles) !==
        digestRecipeDocument(reviewedVisualFiles(source.input, claim.id)) ||
      digestRecipeDocument(judgment.moments) !== digestRecipeDocument(claim.moments)
    )
      continue;
    const id = `pipeline-${digestRecipeDocument({ binding: verified.binding, closure: result.closureIdentity, claimId: claim.id })}`;
    if (run.visualJudgmentReceipts?.some((r) => r.id === id)) continue;
    const receipt: RecipeVisualJudgmentReceipt = {
      id,
      runId: run.id,
      snapshotIdentity: result.closureIdentity,
      closureIdentity: result.closureIdentity,
      recipeRunId: result.recipeRunId,
      claimId: claim.id,
      verdict: judgment.verdict,
      reason: judgment.reason,
      moments: judgment.moments,
      reviewedFiles: judgment.reviewedFiles,
      kind: 'pipeline-reviewed',
      precedence: 'person-first-v1',
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
            digestRecipeDocument(verified.binding)
        )
          throw new Error('The qualified pipeline review changed before its receipt was retained');
      },
    );
  }
}

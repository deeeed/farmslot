import {
  type AssessmentRecord,
  type AssessmentResult,
  type FailureTriageAnalyzeParams,
  failureTriageCause,
  type FailureTriageGetParams,
  type FailureTriageView,
} from '@farmslot/protocol';

import { readAssessmentArtifact, saveAssessmentArtifact } from '../../assessment/artifacts.js';
import { getAssessmentConfig } from '../../assessment/config.js';
import { defaultAssessmentProviders } from '../../assessment/default-providers.js';
import { validTriagePrice } from '../../assessment/failure-triage/evaluate.js';
import {
  digest,
  prepareAdmittedTriage,
  RUBRIC_VERSION,
  triagePrediction,
} from '../../assessment/failure-triage/packet.js';
import { verifyTriagePilotEvidence } from '../../assessment/failure-triage/pilot-evidence.js';
import { boundedAssessmentFetch } from '../../assessment/failure-triage/transport.js';
import { CHECK_FOR_LABEL, type TriagePrice } from '../../assessment/failure-triage/types.js';
import { assess } from '../../assessment/index.js';
import { completeAssessment } from '../../assessment/monitor.js';
import {
  ASSESSMENT_RESPONSE_VALIDATION_ERROR,
  TRIAGE_SPEND_BOUND_EXCEEDED,
  TRIAGE_SPEND_BOUND_UNVERIFIABLE,
} from '../../assessment/provider.js';
import {
  assessmentRecord,
  assessmentRecords,
  recordAuditFailure,
  reserveAssessment,
} from '../../assessment/store.js';

import { readTriagePolicy } from './policy.js';
import { admittedFailureSnapshot, TriageSnapshotUnavailable } from './snapshot.js';

const providers = defaultAssessmentProviders(boundedAssessmentFetch(), fetch);
const pending = new Map<string, Promise<FailureTriageView>>();

/** Price known receipts and enforce the input bound even when the answer is rejected. */
export function priceTriageResult(
  result: AssessmentResult,
  price: Pick<TriagePrice, 'inputUsdPerMillion' | 'maxRequestTokens'>,
  modelMatched = true,
): AssessmentResult {
  const usage = result.usage;
  if (!usage || usage.inputTokens === undefined) {
    const receivedReply =
      result.status === 'completed' || result.error === ASSESSMENT_RESPONSE_VALIDATION_ERROR;
    return receivedReply
      ? {
          ...result,
          status: 'unavailable',
          answers: undefined,
          // The provider has replied, but its receipt cannot prove the per-request token bound.
          // Keep valid partial usage so the audit never treats that attempt as free.
          error: TRIAGE_SPEND_BOUND_UNVERIFIABLE,
        }
      : result;
  }
  const priced = modelMatched
    ? {
        ...usage,
        costUsd: (usage.inputTokens * price.inputUsdPerMillion) / 1_000_000,
        costKind: 'estimated' as const,
      }
    : { ...usage, costUsd: undefined, costKind: undefined };
  return usage.inputTokens > price.maxRequestTokens
    ? {
        ...result,
        status: 'unavailable',
        answers: undefined,
        usage: priced,
        error: TRIAGE_SPEND_BOUND_EXCEEDED,
      }
    : !modelMatched
      ? {
          ...result,
          status: 'unavailable',
          answers: undefined,
          usage: priced,
          // Input usage does not establish the configured model's price/bound when the identity
          // is absent or different. Lock this snapshot instead of treating a reply as free.
          error: TRIAGE_SPEND_BOUND_UNVERIFIABLE,
        }
      : { ...result, usage: priced };
}

function canRetry(record: AssessmentRecord): boolean {
  return (
    (['unavailable', 'interrupted'].includes(record.status) &&
      ![TRIAGE_SPEND_BOUND_EXCEEDED, TRIAGE_SPEND_BOUND_UNVERIFIABLE].includes(
        record.result?.error ?? '',
      )) ||
    (['skipped', 'disabled'].includes(record.status) && record.result?.attempted === false)
  );
}

function advice(record: AssessmentRecord): FailureTriageView['advice'] {
  const label = failureTriageCause(record);
  if (!label) return undefined;
  const evidence = record.result?.answers?.evidence;
  const sources = (record.subject.run?.sources ?? []).filter(
    (s) => evidence?.type === 'choice' && s.id === evidence.choice,
  );
  return { cause: label, nextCheck: CHECK_FOR_LABEL[label], evidence: sources };
}

async function inspect(ownerId: string, params: FailureTriageGetParams) {
  const view: FailureTriageView = {
    runId: params.runId,
    step: params.step,
    availability: 'unavailable',
    reason: '',
    stale: true,
    efficiencyClaim: 'not_established',
    retryAllowed: false,
  };
  let stage: 'history' | 'settings' | 'evaluation' | 'source' = 'history';
  try {
    const records = (await assessmentRecords(ownerId))
      .filter(
        (r) =>
          r.consumer === 'failure-triage' &&
          r.subject.run?.id === params.runId &&
          (!params.step || r.subject.run.step === params.step),
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
    view.record = records[0];
    if (view.record) view.advice = advice(view.record);
    stage = 'settings';
    const config = getAssessmentConfig();
    const policy = await readTriagePolicy();
    view.provider = config.provider;
    view.model = config.model;
    if (!config.enabled || !policy.enabled) {
      view.availability = 'disabled';
      view.reason = 'Experimental triage is disabled.';
      return { view };
    }
    const provider = config.provider && providers.get(config.provider);
    if (!provider || !config.model) {
      view.availability = 'unsupported-model';
      view.reason = 'Select a configured provider and explicit model version.';
      return { view };
    }
    stage = 'evaluation';
    const gate = await verifyTriagePilotEvidence(policy.receiptDirectory);
    if (
      gate.provider !== provider.id ||
      gate.model !== config.model ||
      gate.rubricVersion !== RUBRIC_VERSION
    ) {
      view.availability = 'unsupported-model';
      view.reason = 'This provider/model has no approved triage evaluation.';
      return { view };
    }
    if (!validTriagePrice(policy.price, provider.id, config.model)) {
      view.availability = 'unavailable';
      view.reason = 'A current, compatible price snapshot is required.';
      return { view };
    }
    const key = process.env[provider.credentialEnv]?.trim();
    if (!key) {
      view.availability = 'missing-key';
      view.reason = 'The gateway has no credential for this provider.';
      return { view };
    }
    stage = 'source';
    const snapshot = await admittedFailureSnapshot(params.runId, params.step, policy);
    const prepared = prepareAdmittedTriage(
      snapshot.packet,
      digest(snapshot.packet),
      key,
      Math.min(12000, config.maxStateBytes),
    );
    const snapshotHash = digest({
      source: snapshot.snapshotHash,
      packet: prepared.packetHash,
      questions: prepared.questionHash,
      provider: provider.id,
      model: config.model,
      rubric: RUBRIC_VERSION,
    });
    view.snapshotHash = snapshotHash;
    view.step = snapshot.step;
    view.record =
      records.find((r) => r.subject.run?.snapshotHash === snapshotHash) ??
      records.find((r) => r.subject.run?.step === snapshot.step);
    view.stale = !!view.record && view.record.subject.run?.snapshotHash !== snapshotHash;
    view.advice = view.record && advice(view.record);
    view.retryAllowed = !view.stale && !!view.record && canRetry(view.record);
    view.availability = 'ready';
    view.reason =
      !view.stale && view.record?.status === 'started'
        ? 'An assessment of this snapshot is already running.'
        : !view.stale &&
            ['skipped', 'disabled'].includes(view.record?.status ?? '') &&
            view.record?.result?.attempted === false
          ? 'No provider call was made. Retry explicitly when the settings and evidence are ready.'
          : !view.stale && view.record?.status === 'interrupted'
            ? 'The previous attempt has no saved result; its charge is unknown. Retry only explicitly.'
            : 'One optional assessment of this approved failure snapshot. No recovery action is available.';
    return {
      view,
      ready: {
        policy,
        snapshot,
        prepared,
        provider: provider.id,
        model: config.model,
        snapshotHash,
      },
    };
  } catch (error) {
    // Optional prerequisite failures are visible and suppress the request. Never return
    // filesystem/config exception text, which may contain source content or credentials.
    view.availability = error instanceof TriageSnapshotUnavailable ? error.reason : 'unavailable';
    view.reason =
      error instanceof TriageSnapshotUnavailable
        ? error.message
        : {
            history: 'Assessment history could not be read.',
            settings:
              'Triage settings are invalid. Check triage-policy.json and assessment settings.',
            evaluation:
              'Approved evaluation receipts are missing or changed. Check receiptDirectory.',
            source: 'Approved text could not be read or prepared.',
          }[stage];
    return { view };
  }
}

export async function getFailureTriage(
  ownerId: string,
  params: FailureTriageGetParams,
): Promise<FailureTriageView> {
  const { view } = await inspect(ownerId, params);
  if (params.includeEvidence && view.record?.requestedIdentity?.inputDigest) {
    const hash = view.record.requestedIdentity.inputDigest;
    const input = await readAssessmentArtifact(ownerId, 'inputs', hash);
    if (digest(input) !== hash) throw new Error('Saved triage input changed');
    // Shape is bound to the admitted input hash; return only the preserved model packet.
    view.input = input as FailureTriageView['input'];
  }
  return view;
}

export async function analyzeFailureTriage(
  ownerId: string,
  params: FailureTriageAnalyzeParams,
): Promise<FailureTriageView> {
  const { view, ready } = await inspect(ownerId, params);
  if (!ready) return view;
  if (params.snapshotHash !== ready.snapshotHash)
    return {
      ...view,
      availability: 'rejected-data',
      reason: 'The snapshot changed. Refresh before requesting advice.',
    };
  if (params.retryOf) {
    const prior = await assessmentRecord(ownerId, params.retryOf);
    if (
      prior.consumer !== 'failure-triage' ||
      prior.subject.run?.snapshotHash !== ready.snapshotHash ||
      !canRetry(prior)
    )
      throw new Error(
        'Only a failed, interrupted, or confirmed unattempted assessment of this snapshot can be retried',
      );
  }
  const key =
    !params.retryOf && !view.stale && view.record?.reservation
      ? view.record.reservation.key
      : digest({ ownerId, snapshotHash: ready.snapshotHash, retryOf: params.retryOf });
  const existing = pending.get(key);
  if (existing) return existing;
  const operation = (async (): Promise<FailureTriageView> => {
    const { policy, snapshot, prepared, provider, model, snapshotHash } = ready;
    let reserved: Awaited<ReturnType<typeof reserveAssessment>>;
    try {
      reserved = await reserveAssessment(
        {
          ownerId,
          consumer: 'failure-triage',
          policyVersion: `${RUBRIC_VERSION}/${policy.policyVersion}`,
          subject: {
            run: {
              id: params.runId,
              project: snapshot.project,
              step: snapshot.step,
              snapshotHash,
              sources: snapshot.sources,
            },
          },
          requestedIdentity: {
            provider,
            model,
            inputDigest: prepared.packetHash,
            questionSchemaHash: prepared.questionHash,
          },
        },
        {
          key,
          maxUsd: (policy.price.maxRequestTokens * policy.price.inputUsdPerMillion) / 1_000_000,
          priceHash: digest(policy.price),
          price: policy.price,
        },
        { maxCalls: policy.maxCalls, maxUsd: policy.maxUsd },
      );
    } catch {
      recordAuditFailure();
      return {
        ...view,
        availability: 'unavailable',
        reason: 'Request history could not be reserved; no model call was made.',
      };
    }
    if (reserved.status === 'budget-blocked')
      return {
        ...view,
        availability: 'budget-blocked',
        reason:
          reserved.cause === 'spend-bound'
            ? 'A previous response exceeded or could not establish this price snapshot’s token bound. Verify a new price snapshot before requesting advice.'
            : 'The shared daily assessment budget is exhausted.',
      };
    if (reserved.status === 'reserved') {
      await completeAssessment(reserved.record, async (): Promise<AssessmentResult> => {
        try {
          await saveAssessmentArtifact(ownerId, 'inputs', prepared.packetHash, prepared.packet);
        } catch {
          recordAuditFailure();
          return {
            status: 'unavailable',
            attempted: false,
            provider,
            requestedModel: model,
            error: 'Admitted input could not be saved; no model call was made',
          };
        }
        const current = await inspect(ownerId, { runId: params.runId, step: snapshot.step });
        // Snapshot caching excludes unrelated policy edits; full policy equality still
        // catches admission changes such as projects or receiptDirectory before transport.
        if (
          !current.ready ||
          current.ready.snapshotHash !== snapshotHash ||
          current.ready.policy.policyVersion !== policy.policyVersion
        )
          return {
            status: 'skipped',
            attempted: false,
            provider,
            requestedModel: model,
            error: 'Triage settings or sources changed before the request',
          };
        const result = await assess(
          {
            provider,
            model,
            timeoutMs: 10000,
            state: {
              version: prepared.packet.version,
              caseId: prepared.packet.caseId,
              failure: { ...prepared.packet.failure },
              evidence: prepared.packet.evidence.map((e) => ({ ...e })),
            },
            questions: prepared.questions,
          },
          providers,
        );
        const usage = result.usage;
        if (usage) {
          for (const n of [usage.inputTokens, usage.outputTokens])
            if (n !== undefined && (!Number.isSafeInteger(n) || n < 0))
              return {
                status: 'unavailable',
                attempted: true,
                provider,
                requestedModel: model,
                error: 'Triage response failed its bounded contract',
              };
        }
        const priced = priceTriageResult(result, policy.price, result.returnedModel === model);
        if (priced.status !== 'completed') return priced;
        if (priced.returnedModel !== model)
          return {
            ...priced,
            status: 'unavailable',
            answers: undefined,
            error: 'Returned model does not match the evaluated model',
          };
        try {
          triagePrediction(priced.answers ?? {}, prepared.packet);
          return priced;
        } catch {
          return {
            ...priced,
            status: 'unavailable',
            answers: undefined,
            error: 'Triage response failed its bounded contract',
          };
        }
      });
    }
    // Re-read storage: an uncertain/failed write cannot become a completed UI result.
    // Recheck admission after transport to mark changes during inference as stale.
    const record = await assessmentRecord(ownerId, reserved.record.id);
    const current = await inspect(ownerId, { runId: params.runId, step: snapshot.step });
    return {
      ...current.view,
      record,
      advice: advice(record),
      stale: current.view.snapshotHash !== snapshotHash,
      reason:
        current.view.availability !== 'ready'
          ? current.view.reason
          : ['skipped', 'disabled'].includes(record.status) && record.result?.attempted === false
            ? 'No provider call was made. Retry explicitly when the settings and evidence are ready.'
            : record.status === 'interrupted'
              ? 'The previous attempt has no saved result; its charge is unknown. Retry only explicitly.'
              : record.status === 'unavailable'
                ? (record.result?.error ?? 'Assessment unavailable.')
                : reserved.status === 'existing'
                  ? 'Saved advice; no new provider call.'
                  : 'Assessment saved. This does not change the run verdict.',
    };
  })();
  pending.set(key, operation);
  try {
    return await operation;
  } finally {
    pending.delete(key);
  }
}

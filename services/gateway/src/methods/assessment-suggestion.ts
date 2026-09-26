import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  AssessmentRecord,
  AssessmentResult,
  AssessmentSuggestionAnalyzeParams,
  AssessmentSuggestionInput,
  AssessmentSuggestionView,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { saveAssessmentArtifact } from '../assessment/artifacts.js';
import { getAssessmentConfig } from '../assessment/config.js';
import { defaultAssessmentProviders } from '../assessment/default-providers.js';
import { boundedAssessmentFetch } from '../assessment/failure-triage/transport.js';
import { assess, assessmentProviderStatus } from '../assessment/index.js';
import { prepareAssessmentInput } from '../assessment/input.js';
import { completeAssessment } from '../assessment/monitor.js';
import {
  ASSESSMENT_RESPONSE_VALIDATION_ERROR,
  type AssessmentProviderRegistry,
  TRIAGE_SPEND_BOUND_EXCEEDED,
  TRIAGE_SPEND_BOUND_UNVERIFIABLE,
} from '../assessment/provider.js';
import { assessmentRecord, reserveAssessment } from '../assessment/store.js';
import { suggestionPacket } from '../assessment/suggestion-packet.js';
import { getRunWithArchived } from '../runs/store.js';
import { currentSessionOriginator } from '../security/work-originator.js';

const providers = defaultAssessmentProviders(boundedAssessmentFetch(), fetch);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const POLICY_VERSION = 'assessment-suggestion-v1';
// The approval covers the packet, selected provider/model, and operator-verified price.
const confirmationHash = (
  packetHash: string,
  provider?: string,
  model?: string,
  price?: SuggestionPrice,
) => digest({ packetHash, provider, model, price });

interface SuggestionPrice {
  version: 1;
  provider: string;
  model: string;
  verifiedAt: string;
  source: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}
interface SuggestionPolicy {
  version: 1;
  enabled: boolean;
  price: SuggestionPrice;
  limits: { maxCalls: number; maxUsd: number };
}
async function readPolicy(): Promise<SuggestionPolicy | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(path.join(farmslotHome(), 'assessment-suggestion-policy.json'), 'utf8'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Suggestion policy unavailable');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid suggestion policy');
  const p = value as SuggestionPolicy;
  if (
    Object.keys(p).some((key) => !['version', 'enabled', 'price', 'limits'].includes(key)) ||
    p.version !== 1 ||
    typeof p.enabled !== 'boolean' ||
    !p.price ||
    typeof p.price !== 'object' ||
    Array.isArray(p.price) ||
    Object.keys(p.price).some(
      (key) =>
        ![
          'version',
          'provider',
          'model',
          'verifiedAt',
          'source',
          'inputUsdPerMillion',
          'outputUsdPerMillion',
          'maxInputTokens',
          'maxOutputTokens',
        ].includes(key),
    ) ||
    p.price.version !== 1 ||
    !p.limits ||
    typeof p.limits !== 'object' ||
    Array.isArray(p.limits) ||
    Object.keys(p.limits).some((key) => !['maxCalls', 'maxUsd'].includes(key)) ||
    !Number.isSafeInteger(p.limits.maxCalls) ||
    p.limits.maxCalls < 1 ||
    p.limits.maxCalls > 24 ||
    !Number.isFinite(p.limits.maxUsd) ||
    p.limits.maxUsd <= 0 ||
    p.limits.maxUsd > 0.1
  )
    throw new Error('Invalid suggestion policy');
  return p;
}
function validPrice(price: SuggestionPrice, provider: string, model: string, outputCap?: number) {
  const age = Date.now() - Date.parse(price.verifiedAt);
  return (
    price.provider === provider &&
    price.model === model &&
    typeof price.source === 'string' &&
    /^https:\/\/[^\s]+$/.test(price.source) &&
    Number.isFinite(age) &&
    age >= -60_000 &&
    age <= 7 * 86400_000 &&
    Number.isFinite(price.inputUsdPerMillion) &&
    price.inputUsdPerMillion > 0 &&
    Number.isFinite(price.outputUsdPerMillion) &&
    price.outputUsdPerMillion >= 0 &&
    Number.isSafeInteger(price.maxInputTokens) &&
    price.maxInputTokens >= 8192 &&
    price.maxInputTokens <= 65536 &&
    Number.isSafeInteger(price.maxOutputTokens) &&
    price.maxOutputTokens > 0 &&
    price.maxOutputTokens <= 65536 &&
    (price.outputUsdPerMillion === 0 ||
      (outputCap !== undefined && price.maxOutputTokens >= outputCap))
  );
}
function owner() {
  const origin = currentSessionOriginator();
  if (origin.kind !== 'principal') throw new Error('Authenticated principal required');
  return origin.principalId;
}
async function prepare(input: AssessmentSuggestionInput) {
  const run =
    input.kind === 'copilot-context' && typeof input.runId === 'string'
      ? await getRunWithArchived(input.runId)
      : undefined;
  const draft = suggestionPacket(
    input,
    run ? { id: run.id, project: run.project, status: run.status } : undefined,
  );
  const config = getAssessmentConfig();
  const providerStatus = assessmentProviderStatus();
  const provider = providerStatus.provider && providers.get(providerStatus.provider);
  const key = provider && process.env[provider.credentialEnv]?.trim();
  const packet = prepareAssessmentInput(
    draft.state,
    draft.questions,
    Math.min(config.maxStateBytes, 65_536),
    key ?? '',
  );
  // The audit context must describe exactly what would be sent. Refuse a packet
  // requiring redaction rather than retaining unsanitized operator input.
  if (JSON.stringify(packet.state) !== JSON.stringify(draft.state))
    throw new Error('Suggestion input contains a credential');
  return { ...draft, packet, config, providerStatus, provider };
}
function fitsPricedInput(
  packet: ReturnType<typeof prepareAssessmentInput>,
  price: SuggestionPrice,
): boolean {
  // Provider adapters add instructions and a response schema around the packet.
  // Allow for those bytes and tokenizer variance before reserving the priced ceiling.
  return Buffer.byteLength(JSON.stringify(packet), 'utf8') * 2 + 4096 <= price.maxInputTokens;
}

function guard(
  result: AssessmentResult,
  price: SuggestionPrice,
  expectedQuestions: string[],
): AssessmentResult {
  const usage = result.usage;
  const replied =
    result.status === 'completed' || result.error === ASSESSMENT_RESPONSE_VALIDATION_ERROR;
  if (
    !usage ||
    usage.inputTokens === undefined ||
    (price.outputUsdPerMillion > 0 && usage.outputTokens === undefined)
  )
    return replied
      ? {
          ...result,
          status: 'unavailable',
          answers: undefined,
          error: TRIAGE_SPEND_BOUND_UNVERIFIABLE,
        }
      : result;
  const pricedUsage = {
    ...usage,
    ...(result.returnedModel === price.model
      ? {
          costUsd:
            (usage.inputTokens * price.inputUsdPerMillion +
              (usage.outputTokens ?? 0) * price.outputUsdPerMillion) /
            1_000_000,
          costKind: 'estimated' as const,
        }
      : { costUsd: undefined, costKind: undefined }),
  };
  if (usage.inputTokens > price.maxInputTokens || (usage.outputTokens ?? 0) > price.maxOutputTokens)
    return {
      ...result,
      usage: pricedUsage,
      status: 'unavailable',
      answers: undefined,
      error: TRIAGE_SPEND_BOUND_EXCEEDED,
    };
  if (replied && result.returnedModel !== price.model)
    return {
      ...result,
      usage: pricedUsage,
      status: 'unavailable',
      answers: undefined,
      error: TRIAGE_SPEND_BOUND_UNVERIFIABLE,
    };
  if (result.status !== 'completed') return { ...result, usage: pricedUsage };
  if (
    !result.answers ||
    Object.keys(result.answers).length !== expectedQuestions.length ||
    !expectedQuestions.every((id) => result.answers?.[id]?.type === 'choice')
  )
    return {
      ...result,
      usage: pricedUsage,
      status: 'unavailable',
      answers: undefined,
      error: 'Invalid suggestion answers',
    };
  return { ...result, usage: pricedUsage };
}

/** Preview is read-only. The operator must confirm this exact packet before any paid call. */
export async function assessmentSuggestionPreview(
  input: AssessmentSuggestionInput,
): Promise<AssessmentSuggestionView> {
  owner();
  const { packetHash, packet, config, providerStatus, provider } = await prepare(input);
  const policy = await readPolicy();
  let reason: AssessmentSuggestionView['reason'];
  if (!policy?.enabled) reason = 'disabled';
  else if (!config.enabled || !provider || !providerStatus.model || !providerStatus.keyAvailable)
    reason = 'provider-unavailable';
  else if (!validPrice(policy.price, provider.id, providerStatus.model, provider.maxOutputTokens))
    reason = 'price-unavailable';
  else if (!fitsPricedInput(packet, policy.price)) reason = 'price-unavailable';
  else if (
    (policy.price.maxInputTokens * policy.price.inputUsdPerMillion +
      policy.price.maxOutputTokens * policy.price.outputUsdPerMillion) /
      1_000_000 >
    policy.limits.maxUsd
  )
    reason = 'budget-blocked';
  return {
    eligible: !reason,
    ...(reason ? { reason } : {}),
    packetHash: confirmationHash(
      packetHash,
      providerStatus.provider,
      providerStatus.model,
      policy?.price,
    ),
    provider: providerStatus.provider,
    model: providerStatus.model,
    packet,
  };
}

export async function assessmentSuggestionAnalyze(
  params: AssessmentSuggestionAnalyzeParams,
  registry: AssessmentProviderRegistry = providers,
): Promise<AssessmentSuggestionView> {
  if (
    !params ||
    typeof params !== 'object' ||
    Array.isArray(params) ||
    Object.keys(params).some(
      (key) => !['input', 'expectedPacketHash', 'confirmed'].includes(key),
    ) ||
    params.confirmed !== true ||
    typeof params.expectedPacketHash !== 'string' ||
    !HASH.test(params.expectedPacketHash)
  )
    throw new Error('Confirm the previewed suggestion packet');
  const ownerId = owner();
  const selected = await prepare(params.input);
  const policy = await readPolicy();
  const { providerStatus, provider, config } = selected;
  const base = {
    packetHash: confirmationHash(
      selected.packetHash,
      providerStatus.provider,
      providerStatus.model,
      policy?.price,
    ),
    provider: providerStatus.provider,
    model: providerStatus.model,
    packet: selected.packet,
  };
  if (base.packetHash !== params.expectedPacketHash)
    return { ...base, eligible: false, reason: 'stale' };
  const model = providerStatus.model;
  if (!policy?.enabled) return { ...base, eligible: false, reason: 'disabled' };
  if (!config.enabled || !provider || !model || !providerStatus.keyAvailable)
    return { ...base, eligible: false, reason: 'provider-unavailable' };
  const price = policy.price;
  if (!validPrice(price, provider.id, model, provider.maxOutputTokens))
    return { ...base, eligible: false, reason: 'price-unavailable' };
  if (!fitsPricedInput(selected.packet, price))
    return { ...base, eligible: false, reason: 'price-unavailable' };
  const maxUsd =
    (price.maxInputTokens * price.inputUsdPerMillion +
      price.maxOutputTokens * price.outputUsdPerMillion) /
    1_000_000;
  if (maxUsd > policy.limits.maxUsd) return { ...base, eligible: false, reason: 'budget-blocked' };
  const priceHash = digest(price);
  const reservation: NonNullable<AssessmentRecord['reservation']> = {
    key: digest({ packetHash: selected.packetHash, priceHash, provider: provider.id, model }),
    maxUsd,
    priceHash,
    price: { ...price, maxRequestTokens: price.maxInputTokens + price.maxOutputTokens },
  };
  const reserved = await reserveAssessment(
    {
      ownerId,
      consumer: params.input.kind,
      subject: selected.subject,
      policyVersion: POLICY_VERSION,
      requestedIdentity: {
        provider: provider.id,
        model,
        inputDigest: selected.packetHash,
        questionSchemaHash: digest(selected.packet.questions),
      },
    },
    reservation,
    policy.limits,
  );
  if (reserved.status === 'budget-blocked')
    return { ...base, eligible: false, reason: 'budget-blocked' };
  if (reserved.status === 'existing') {
    const record = reserved.record;
    return {
      ...base,
      eligible: record.status === 'completed',
      ...(record.result ? { assessment: record.result } : {}),
      ...(record.status === 'interrupted'
        ? { reason: 'assessment-interrupted' }
        : record.status === 'started'
          ? { reason: 'assessment-pending' }
          : record.status !== 'completed'
            ? { reason: 'saved-attempt' }
            : {}),
    };
  }
  const value = (await completeAssessment(reserved.record, async () => {
    const current = await readPolicy();
    const fresh = await prepare(params.input);
    if (
      !current?.enabled ||
      digest(current.price) !== priceHash ||
      fresh.packetHash !== selected.packetHash
    )
      return {
        status: 'skipped' as const,
        attempted: false,
        error: 'Suggestion changed before provider call',
      };
    await saveAssessmentArtifact(ownerId, 'inputs', digest(reserved.record.id), {
      policyVersion: POLICY_VERSION,
      source: params.input.source,
      packet: selected.packet,
      packetHash: selected.packetHash,
    });
    const result = await assess(
      {
        ...selected.packet,
        provider: provider.id,
        model,
        timeoutMs: Math.min(config.timeoutMs, 10_000),
      },
      registry,
    );
    return guard(result, price, Object.keys(selected.packet.questions));
  })) as AssessmentResult;
  if (value.monitoringError)
    return { ...base, eligible: false, reason: 'assessment-unavailable', assessment: value };
  const saved = await assessmentRecord(ownerId, reserved.record.id);
  return { ...base, eligible: saved.status === 'completed', assessment: saved.result };
}

/** Provider-neutral Choice assessment of the first evidence source to read. No text generation. */
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import type { AssessmentProvider } from '../../services/gateway/src/assessment/provider.js';
import { sealCases, type NavigationAdvice, type NavigationCase } from './workflow-navigation.mts';
import type { RunnerApproval, RunnerConfig } from './workflow-navigation-runner.mts';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const INSTRUCTIONS =
  'Which named source should the worker inspect first to investigate this recorded failure? Choose none if no available source is promising. This choice is only a navigation hint, not a diagnosis.';

export interface AdviceConfig {
  provider: string;
  model: string;
  /** Required by the Responses-compatible LLM adapter; TypeSafe uses its SDK endpoint. */
  baseUrl?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxTotalUsd: number;
  minimumConfidence: number;
  price: RunnerConfig['price'];
}
export interface AdvicePlan {
  version: 1;
  source: 'synthetic';
  cases: NavigationCase[];
  caseHash: string;
  workerLimits?: { maxTurns: number; maxReads: number };
  hash: string;
}
export interface NavigationAdviceResult {
  advice: NavigationAdvice[];
  stopReason: string;
  advicePlanHash: string;
  configHash: string;
  provider: string;
  model: string;
  journalSha256: string;
}
export function sealAdvicePlan(
  cases: NavigationCase[],
  workerLimits?: { maxTurns: number; maxReads: number },
): AdvicePlan {
  const frozen = sealCases(cases);
  if (workerLimits !== undefined) {
    assert(
      workerLimits !== null &&
        typeof workerLimits === 'object' &&
        Object.keys(workerLimits).sort().join(',') === 'maxReads,maxTurns' &&
        Number.isSafeInteger(workerLimits.maxTurns) &&
        workerLimits.maxTurns >= 2 &&
        workerLimits.maxTurns <= 12 &&
        Number.isSafeInteger(workerLimits.maxReads) &&
        workerLimits.maxReads > 0 &&
        workerLimits.maxReads < workerLimits.maxTurns,
      'Invalid worker limits',
    );
    assert(cases.length * 2 * workerLimits.maxTurns <= 60, 'Study exceeds 60-call cap');
  }
  const body = {
    version: 1 as const,
    source: 'synthetic' as const,
    cases: frozen.cases,
    caseHash: frozen.hash,
    ...(workerLimits !== undefined && {
      workerLimits: { maxTurns: workerLimits.maxTurns, maxReads: workerLimits.maxReads },
    }),
  };
  return { ...body, hash: hash(JSON.stringify(body)) };
}
export function adviceState(item: NavigationCase) {
  return { failure: item.failure, available: item.sources.map(({ id, title }) => ({ id, title })) };
}
export function adviceQuestions(item: NavigationCase) {
  return {
    first_read: {
      type: 'choice' as const,
      instructions: INSTRUCTIONS,
      criteria: {
        ...Object.fromEntries(item.sources.map(({ id, title }) => [id, title])),
        none: 'No promising source among the available options',
      },
    },
  };
}
export function adviceReservation(plan: AdvicePlan, config: AdviceConfig) {
  assert(
    JSON.stringify(sealAdvicePlan(plan.cases, plan.workerLimits)) === JSON.stringify(plan),
    'Advice plan changed after sealing',
  );
  assert(plan.cases.length <= 10, 'Advice batch exceeds ten-case cap');
  assert(
    /^[\w.-]{1,100}$/.test(config.provider) && /^[\w.-]{1,100}$/.test(config.model),
    'Invalid provider identity',
  );
  if (config.provider === 'llm-response') {
    // The shared LLM assessment adapter enforces this exact cap in its request.
    assert(config.maxOutputTokens === 2048, 'LLM output cap must match assessment adapter');
    assert(typeof config.baseUrl === 'string', 'Responses endpoint required');
    const endpoint = new URL(config.baseUrl.replace(/\/$/, '') + '/responses');
    assert(
      !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash &&
        (endpoint.protocol === 'https:' ||
          (endpoint.protocol === 'http:' &&
            ['localhost', '127.0.0.1'].includes(endpoint.hostname))),
      'Invalid Responses endpoint',
    );
  }
  assert(
    Number.isSafeInteger(config.maxInputTokens) &&
      config.maxInputTokens >= 64 &&
      Number.isSafeInteger(config.maxOutputTokens) &&
      config.maxOutputTokens >= 16 &&
      config.maxOutputTokens <= 2048 &&
      Number.isSafeInteger(config.maxTotalTokens) &&
      config.maxTotalTokens > 0 &&
      Number.isFinite(config.maxTotalUsd) &&
      config.maxTotalUsd > 0 &&
      config.maxTotalUsd <= 0.1 &&
      Number.isFinite(config.minimumConfidence) &&
      config.minimumConfidence >= 0 &&
      config.minimumConfidence <= 1,
    'Invalid advice limits',
  );
  const price = config.price;
  const ageMs = Date.now() - Date.parse(price.verifiedAt);
  assert(
    price.source.startsWith('https://') &&
      Number.isFinite(ageMs) &&
      ageMs >= 0 &&
      ageMs <= 7 * 24 * 60 * 60 * 1000 &&
      Number.isFinite(price.inputUsdPerMillion) &&
      price.inputUsdPerMillion >= 0 &&
      Number.isFinite(price.outputUsdPerMillion) &&
      price.outputUsdPerMillion >= 0 &&
      Number.isFinite(price.cacheReadMultiplier) &&
      price.cacheReadMultiplier >= 0 &&
      Number.isFinite(price.cacheWriteMultiplier) &&
      price.cacheWriteMultiplier >= 0,
    'Verified price required',
  );
  for (const item of plan.cases)
    assert(
      Buffer.byteLength(
        JSON.stringify({ state: adviceState(item), questions: adviceQuestions(item) }),
      ) +
        1024 <=
        config.maxInputTokens,
      'Advice request including reserved envelope exceeds input-byte ceiling',
    );
  const ceilingTokens = plan.cases.length * (config.maxInputTokens + config.maxOutputTokens);
  const ceilingUsd =
    (plan.cases.length *
      (config.maxInputTokens *
        price.inputUsdPerMillion *
        Math.max(1, price.cacheReadMultiplier, price.cacheWriteMultiplier) +
        config.maxOutputTokens * price.outputUsdPerMillion)) /
    1e6;
  assert(
    ceilingTokens <= config.maxTotalTokens && ceilingUsd <= config.maxTotalUsd,
    'Advice exceeds reserved budget',
  );
  return {
    configHash: hash(JSON.stringify(config)),
    ceilingTokens,
    ceilingUsd,
    calls: plan.cases.length,
  };
}

/** The provider is injected: TypeSafe and regular LLM adapters implement the same Choice contract. */
export async function generateNavigationAdvice(
  plan: AdvicePlan,
  config: AdviceConfig,
  paths: { approvalPath: string; methodologyPath: string; journalPath: string; apiKey: string },
  provider: AssessmentProvider,
): Promise<NavigationAdviceResult> {
  const budget = adviceReservation(plan, config);
  assert(
    provider.id === config.provider && provider.capabilities.includes('choice'),
    'Choice provider mismatch',
  );
  assert(
    provider.maxOutputTokens === undefined || provider.maxOutputTokens <= config.maxOutputTokens,
    'Provider output cap exceeds reservation',
  );
  assert(
    paths.apiKey && paths.journalPath.startsWith('/'),
    'Key and absolute journal path required',
  );
  const [approvalText, methodText] = await Promise.all([
    readFile(paths.approvalPath, 'utf8'),
    readFile(paths.methodologyPath, 'utf8'),
  ]);
  assert(approvalText.length <= 4096, 'Invalid advice approval file');
  const approval: RunnerApproval = JSON.parse(approvalText);
  assert(
    approval.conclusion === 'approved' &&
      approval.planHash === plan.hash &&
      approval.configHash === budget.configHash &&
      approval.methodologyHash === hash(methodText) &&
      approval.journalPath === paths.journalPath &&
      /^[\w.-]{2,100}$/.test(approval.reviewer),
    'Independent advice approval does not match frozen inputs and price',
  );
  const journal = await open(paths.journalPath, 'wx', 0o600);
  let journalClosed = false;
  try {
    const used = await open(paths.approvalPath + '.used', 'wx', 0o600);
    try {
      await used.writeFile(plan.hash);
      await used.sync();
    } finally {
      await used.close();
    }
    const write = async (value: unknown) => {
      await journal.writeFile(JSON.stringify(value) + '\n');
      await journal.sync();
    };
    await write({
      kind: 'approved',
      planHash: plan.hash,
      configHash: budget.configHash,
      config,
      approvalHash: hash(approvalText),
      methodologyHash: approval.methodologyHash,
    });
    const advice: NavigationAdvice[] = [];
    const identities = new Set<string>();
    let attempts = 0;
    let stopReason = 'completed';
    for (const item of plan.cases) {
      const state = adviceState(item);
      const questions = adviceQuestions(item);
      const promptHash = hash(JSON.stringify({ state, questions }));
      await write({ kind: 'started', caseId: item.id, promptHash });
      attempts++;
      const started = performance.now();
      let response: Awaited<ReturnType<AssessmentProvider['assess']>>;
      try {
        response = await provider.assess({
          state,
          questions,
          model: config.model,
          apiKey: paths.apiKey,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        // Provider errors can carry known usage, but an absent receipt may hide a charge. Never retry.
        const usage =
          error && typeof error === 'object' && 'usage' in error ? error.usage : undefined;
        await write({
          kind: 'failed',
          caseId: item.id,
          reason: 'provider-error-unknown-charge',
          usage,
        });
        stopReason = 'unknown-charge';
        break;
      }
      const answer = response.answers.first_read;
      const usage = response.usage;
      const read = answer?.type === 'choice' ? answer.choice : undefined;
      const confidence =
        answer?.type === 'choice' && 'confidence' in answer && typeof answer.confidence === 'number'
          ? answer.confidence
          : null;
      const input = usage.inputTokens;
      const output = usage.outputTokens;
      const cacheRead = usage.cacheReadTokens ?? null;
      const cacheWrite = usage.cacheWriteTokens ?? null;
      const discounted =
        config.price.cacheReadMultiplier !== 1 || config.price.cacheWriteMultiplier !== 1;
      const costUsd =
        input === undefined ||
        output === undefined ||
        (discounted && (cacheRead === null || cacheWrite === null)) ||
        (cacheRead !== null && cacheWrite !== null && cacheRead + cacheWrite > input)
          ? null
          : ((input -
              (cacheRead ?? 0) -
              (cacheWrite ?? 0) +
              (cacheRead ?? 0) * config.price.cacheReadMultiplier +
              (cacheWrite ?? 0) * config.price.cacheWriteMultiplier) *
              config.price.inputUsdPerMillion +
              output * config.price.outputUsdPerMillion) /
            1e6;
      const receiptHash = hash(JSON.stringify({ promptHash, answer, usage }));
      const receipt = {
        responseId: usage.requestId ?? '',
        receiptHash,
        inputTokens: input ?? null,
        outputTokens: output ?? null,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        costUsd,
        providerDurationMs: usage.durationMs,
        elapsedMs: performance.now() - started,
      };
      if (
        !read ||
        (read !== 'none' && !item.sources.some((source) => source.id === read)) ||
        response.returnedModel !== config.model ||
        !usage.requestId ||
        identities.has(usage.requestId) ||
        identities.has(receiptHash) ||
        costUsd === null ||
        input === undefined ||
        output === undefined ||
        input > config.maxInputTokens ||
        output > config.maxOutputTokens ||
        (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1))
      ) {
        await write({ kind: 'failed', caseId: item.id, reason: 'unverified-response', receipt });
        stopReason = 'unverified-response';
        break;
      }
      identities.add(usage.requestId);
      identities.add(receiptHash);
      const sourceId = confidence !== null && confidence < config.minimumConfidence ? 'none' : read;
      const text =
        sourceId === 'none'
          ? null
          : `Suggested first read: ${sourceId}. Inspect it before drawing a conclusion.`;
      const entry: NavigationAdvice = {
        caseId: item.id,
        text,
        receipt: {
          responseId: usage.requestId,
          receiptHash,
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          costUsd,
          providerDurationMs: usage.durationMs,
          elapsedMs: receipt.elapsedMs,
        },
      };
      advice.push(entry);
      await write({ kind: 'finished', promptHash, answer, usage, ...entry });
    }
    await write({ kind: 'closed', planHash: plan.hash, attempts, stopReason });
    await journal.sync();
    await journal.close();
    journalClosed = true;
    const journalSha256 = hash(await readFile(paths.journalPath));
    return {
      advice,
      stopReason,
      advicePlanHash: plan.hash,
      configHash: budget.configHash,
      provider: config.provider,
      model: config.model,
      journalSha256,
    };
  } finally {
    if (!journalClosed) await journal.close();
  }
}

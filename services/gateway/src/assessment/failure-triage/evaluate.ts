import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { writeAtomicJSON } from '../../core/atomic-json.js';
import { defaultAssessmentProviders } from '../default-providers.js';
import { type AssessmentProvider, AssessmentResponseError } from '../provider.js';
import { assertNoCredentials } from '../record-validation.js';

import { BASELINE_VERSION, cueBaseline, existingBaseline, PATTERN_MAPPING } from './baselines.js';
import { loadTriageCorpus } from './corpus.js';
import { corpusIntegrity, corpusIntegrityPassed } from './corpus-integrity.js';
import { CORPORA, type CorpusVersion } from './corpus-lock.js';
import { percentiles, triageGate, triageMetrics } from './metrics.js';
import {
  digest,
  prepareTriage,
  RUBRIC_VERSION,
  triagePrediction,
  TriageResponseError,
} from './packet.js';
import { boundedAssessmentFetch } from './transport.js';
import type { TriagePrice, TriageResult } from './types.js';

class AssessmentSpendBoundError extends Error {
  constructor() {
    super('spend-bound-exceeded');
    this.name = 'AssessmentSpendBoundError';
  }
}

/** Pure policy checks; the evaluator supplies integrity from the pinned audit. */
export function triageSkipReason(input: {
  mode: 'offline' | 'live' | 'fixture';
  integrityPassed: boolean;
  providerAvailable: boolean;
  keyAvailable: boolean;
  priceReady: boolean;
  budgetExhausted: boolean;
}): string | undefined {
  if (input.mode === 'offline') return 'offline';
  if (input.mode === 'live' && !input.integrityPassed) return 'corpus-integrity-failed';
  if (!input.providerAvailable) return 'unknown-provider';
  if (!input.keyAvailable) return 'missing-key';
  if (input.mode !== 'fixture' && !input.priceReady) return 'unknown-or-stale-price';
  if (input.budgetExhausted) return 'budget-exhausted';
  return undefined;
}

export interface TriageOptions {
  out: string;
  corpus?: CorpusVersion;
  live?: boolean;
  provider?: string;
  model?: string;
  maxCalls?: number;
  maxUsd?: number;
  timeoutMs?: number;
  maxBytes?: number;
  split?: 'development' | 'held-out';
  caseId?: string;
  /** Explicit transport simulation. Never produces eligible live evidence. */
  fixture?:
    | 'valid'
    | 'invalid-label'
    | 'fabricated-evidence'
    | 'timeout'
    | 'rate-limit'
    | 'credential-echo'
    | 'control-action';
}
// Supported reservation envelope: the bundled snapshot documents input-only pricing
// and a 64k request limit. Paid outputs need their own bound before admission.
export function validTriagePrice(
  value: TriagePrice,
  provider: string,
  model: string,
  now = Date.now(),
): boolean {
  const age = now - Date.parse(value.verifiedAt);
  return (
    value.version === 1 &&
    value.provider === provider &&
    value.model === model &&
    /^https:\/\/[^\s]+$/.test(value.source) &&
    Number.isFinite(age) &&
    age >= -60_000 &&
    age <= 7 * 86400_000 &&
    Number.isFinite(value.inputUsdPerMillion) &&
    value.inputUsdPerMillion > 0 &&
    value.outputUsdPerMillion === 0 &&
    Number.isSafeInteger(value.maxRequestTokens) &&
    value.maxRequestTokens >= 64000 &&
    value.maxRequestTokens <= 65536
  );
}
function fixtureProvider(mode: NonNullable<TriageOptions['fixture']>): AssessmentProvider {
  return {
    id: 'fixture',
    defaultModel: 'fixed',
    credentialEnv: 'UNUSED_FIXTURE_KEY',
    capabilities: ['choice'],
    async assess({ state, questions, signal }) {
      if (mode === 'timeout') {
        await new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('fixture deadline')), 15000);
          const abort = () => {
            clearTimeout(timer);
            reject(new Error('timeout'));
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      }
      if (mode === 'rate-limit') throw Object.assign(new Error('fixture'), { status: 429 });
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, q]) => {
          if (q.type !== 'choice') throw new Error('Invalid fixture question');
          const selected =
            id === 'cause'
              ? mode === 'invalid-label'
                ? 'invented'
                : 'unclear'
              : id === 'nextCheck'
                ? mode === 'control-action'
                  ? 'kill-process'
                  : 'inspect_more_context'
                : mode === 'fabricated-evidence'
                  ? 'e999'
                  : 'none';
          return [
            id,
            {
              type: 'choice' as const,
              choice: selected,
              confidence: 1,
              probabilities: Object.fromEntries(
                Object.keys(q.criteria).map((k) => [k, k === selected ? 1 : 0]),
              ),
            },
          ];
        }),
      );
      return {
        returnedModel: mode === 'credential-echo' ? process.env.TRIAGE_PROOF_API_KEY : 'fixed',
        answers,
        usage: {
          inputTokens: Buffer.byteLength(JSON.stringify(state)),
          outputTokens: 30,
          durationMs: 1,
        },
      };
    },
  };
}
export async function evaluateTriage(options: TriageOptions) {
  const started = Date.now();
  const maxCalls = options.maxCalls ?? 60,
    maxUsd = options.maxUsd ?? 0.1,
    timeoutMs = options.timeoutMs ?? 10000;
  if (
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 60 ||
    !Number.isFinite(maxUsd) ||
    maxUsd <= 0 ||
    maxUsd > 0.1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 10000
  )
    throw new Error('Invalid evaluation limits');
  if (options.live && options.fixture)
    throw new Error('Transport fixtures cannot be live evidence');
  const corpusVersion = options.corpus ?? 'v1';
  const corpus = loadTriageCorpus(corpusVersion);
  const corpusHash = CORPORA[corpusVersion].hash;
  const split = options.split ?? 'held-out';
  const cases = corpus.cases.filter(
    (c) => c.split === split && (!options.caseId || c.id === options.caseId),
  );
  if (!cases.length) throw new Error('No selected corpus case');
  await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
  await mkdir(options.out, { mode: 0o700 }); // Exclusive run directory preserves prior attempts.
  const save = async (name: string, value: unknown) => {
    const content = JSON.stringify(value);
    assertNoCredentials(content);
    await writeAtomicJSON(path.join(options.out, name), value);
  };
  const price: TriagePrice = JSON.parse(
    await readFile(
      new URL('../../../../../scripts/failure-triage/prices.json', import.meta.url),
      'utf8',
    ),
  );
  const provider = options.fixture
    ? fixtureProvider(options.fixture)
    : defaultAssessmentProviders(boundedAssessmentFetch()).get(options.provider ?? '');
  const key = options.fixture
    ? 'synthetic-only'
    : provider
      ? process.env[provider.credentialEnv]?.trim()
      : undefined;
  const mode = options.fixture ? 'fixture' : options.live ? 'live' : 'offline';
  const priceReady = Boolean(
    options.provider && options.model && validTriagePrice(price, options.provider, options.model),
  );
  const reservation = (price.maxRequestTokens * price.inputUsdPerMillion) / 1_000_000;
  let attempts = 0,
    reservedUsd = 0,
    violations = 0,
    admissionSkips = 0,
    overBound = false;
  const candidate: TriageResult[] = [],
    baseline: TriageResult[] = [],
    cueSheet: TriageResult[] = [];
  await save('corpus-manifest.json', { corpusHash: corpusHash, ...corpus });
  const runStart = {
    version: 1,
    mode,
    status: 'started',
    startedAt: new Date().toISOString(),
    corpusHash: corpusHash,
    rubricVersion: RUBRIC_VERSION,
    baselineVersion: BASELINE_VERSION,
    price,
    priceHash: digest(price),
    options: { ...options, out: undefined },
    efficiencyClaim: 'not_established',
  };
  await save('run.json', runStart);
  for (const c of cases) {
    const caseStarted = Date.now();
    let prepared;
    try {
      prepared = prepareTriage(c.packet, c, key ?? '', options.maxBytes);
    } catch (error) {
      const benign =
        error instanceof Error &&
        [
          'missing-required-context',
          'invalid-byte-limit',
          'Assessment input limit exceeded',
        ].includes(error.message);
      candidate.push({
        caseId: c.id,
        status: 'skipped',
        reason: benign ? 'missing-or-oversized-required-context' : 'input-not-admitted',
        durationMs: Date.now() - caseStarted,
        reservedUsd: 0,
      });
      if (benign) admissionSkips++;
      else violations++;
      await save('candidate-results.json', candidate);
      continue;
    }
    for (const [fn, rows] of [
      [existingBaseline, baseline],
      [cueBaseline, cueSheet],
    ] as const) {
      const begin = performance.now();
      const prediction = fn(prepared.packet);
      rows.push({
        caseId: c.id,
        status: 'completed',
        prediction,
        packetHash: prepared.packetHash,
        questionHash: prepared.questionHash,
        durationMs: performance.now() - begin,
        reservedUsd: 0,
      });
    }
    const row: TriageResult = {
      caseId: c.id,
      status: 'skipped',
      provider: options.fixture ? 'fixture' : options.provider,
      requestedModel: options.fixture ? 'fixed' : options.model,
      packetHash: prepared.packetHash,
      questionHash: prepared.questionHash,
      omissions: prepared.omissions,
      durationMs: 0,
      reservedUsd: 0,
    };
    candidate.push(row);
    row.reason = triageSkipReason({
      mode,
      integrityPassed: corpusIntegrityPassed(corpusHash),
      providerAvailable: !!provider,
      keyAvailable: !!key,
      priceReady,
      budgetExhausted:
        overBound || attempts >= maxCalls || reservedUsd + reservation > maxUsd + 1e-12,
    });
    if (!row.reason) {
      if (!provider || !key) throw new Error('Assessment policy admitted an unavailable provider');
      attempts++;
      reservedUsd += reservation;
      row.status = 'started';
      row.reservedUsd = reservation;
      await save('candidate-results.json', candidate); // Persist reservation before the call.
      const signal = AbortSignal.timeout(timeoutMs);
      let receivedResponse = false;
      try {
        const response = await provider.assess({
          state: {
            version: 1,
            caseId: prepared.packet.caseId,
            failure: { ...prepared.packet.failure },
            evidence: prepared.packet.evidence.map((e) => ({ ...e })),
          },
          questions: prepared.questions,
          model: options.fixture ? 'fixed' : options.model!,
          apiKey: key,
          signal,
        });
        receivedResponse = true;
        assertNoCredentials(JSON.stringify(response));
        if (response.returnedModel !== undefined && !/^[\w.-]{1,100}$/.test(response.returnedModel))
          throw new TriageResponseError('model-identity');
        const usage = response.usage;
        for (const tokens of [usage.inputTokens, usage.outputTokens])
          if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < 0))
            throw new TriageResponseError('usage');
        if (!Number.isFinite(usage.durationMs) || usage.durationMs < 0)
          throw new TriageResponseError('duration');
        if (!options.fixture && (usage.inputTokens ?? 0) > price.maxRequestTokens) {
          overBound = true;
          throw new AssessmentSpendBoundError();
        }
        row.prediction = triagePrediction(response.answers, prepared.packet);
        row.status = 'completed';
        row.returnedModel = response.returnedModel;
        row.usage = { ...usage, provider: provider.id, requestedModel: row.requestedModel! };
        if (!options.fixture && usage.inputTokens !== undefined)
          row.estimatedUsd = (usage.inputTokens * price.inputUsdPerMillion) / 1_000_000;
      } catch (error) {
        row.status = 'unavailable';
        const status =
          error && typeof error === 'object' && 'status' in error ? error.status : undefined;
        // SDK exceptions may echo context or credentials. Only controlled reason codes persist.
        row.reason =
          error instanceof AssessmentSpendBoundError
            ? 'spend-bound-exceeded'
            : signal.aborted
              ? 'timeout'
              : status === 429
                ? 'rate-limit'
                : receivedResponse || error instanceof AssessmentResponseError
                  ? `invalid-response:${error instanceof TriageResponseError ? error.code : error instanceof AssessmentResponseError ? 'adapter-validation' : 'unclassified'}`
                  : 'provider-request-failed';
      }
    }
    row.durationMs = Date.now() - caseStarted;
    await save('candidate-results.json', candidate);
  }
  await save('baseline-results.json', {
    version: BASELINE_VERSION,
    mapping: PATTERN_MAPPING,
    deterministic: baseline,
    cueSheet,
  });
  const liveStatus =
    mode === 'fixture'
      ? 'fixture'
      : mode === 'offline' ||
          (attempts === 0 && candidate.some((r) => r.reason === 'corpus-integrity-failed'))
        ? 'not_run'
        : candidate.every((r) => r.status === 'completed')
          ? 'completed'
          : 'unavailable';
  const metrics = triageMetrics(cases, candidate),
    deterministic = triageMetrics(cases, baseline),
    diagnostic = triageMetrics(cases, cueSheet);
  const pilotGate = triageGate({
    liveStatus,
    corpusIntegrityPassed: corpusIntegrityPassed(corpusHash),
    metrics,
    baseline: deterministic,
    cueSheet: diagnostic,
    violations,
    withinBudget: !overBound && attempts <= maxCalls && reservedUsd <= maxUsd + 1e-12,
  });
  const report = {
    version: 1,
    corpusHash: corpusHash,
    rubricVersion: RUBRIC_VERSION,
    baselineVersion: BASELINE_VERSION,
    priceHash: digest(price),
    provider: options.provider,
    requestedModel: options.model,
    returnedModels: [
      ...new Set(candidate.flatMap((r) => (r.returnedModel ? [r.returnedModel] : []))),
    ],
    split,
    developmentCases: 9,
    heldOutCases: 21,
    selectedCases: cases.length,
    corpusVersion,
    liveStatus,
    metrics,
    baselines: { deterministic, diagnosticCueSheet: diagnostic },
    usage: {
      accounting: mode === 'fixture' ? 'simulated' : 'provider',
      attempts,
      reservedUsd,
      knownEstimatedUsd: candidate.reduce((n, r) => n + (r.estimatedUsd ?? 0), 0),
      unknownCharges: candidate.filter((r) => r.reservedUsd > 0 && r.estimatedUsd === undefined)
        .length,
      inputTokens: candidate.reduce((n, r) => n + (r.usage?.inputTokens ?? 0), 0),
      outputTokens: candidate.reduce((n, r) => n + (r.usage?.outputTokens ?? 0), 0),
      limits: { maxCalls, maxUsd, timeoutMs },
      price,
    },
    latency: {
      provider: percentiles(candidate.flatMap((r) => (r.usage ? [r.usage.durationMs] : []))),
      endToEnd: percentiles(candidate.map((r) => r.durationMs)),
      batchMs: Date.now() - started,
    },
    safetyViolations: violations,
    admissionSkips,
    corpusIntegrity: corpusIntegrity(corpusHash),
    pilotGate,
    decision: pilotGate.decision,
    efficiencyClaim: 'not_established',
    limitations: [
      'Synthetic known-cause classification and next-check accuracy are proxies, not measured operator time savings.',
      'Twenty-one held-out cases cannot establish broad accuracy. Family counts describe correlation; case-level confidence intervals are unavailable when families repeat.',
      'V2 uses compact virtual fixtures with explicit contracts and component ownership, not sparse production logs. External-service and unclear each have only one held-out family.',
      'The cue sheet was designed against v1 and frozen before v2; it is not an independently authored blind comparator. Historical v1 arithmetic is documented separately and cannot repair its integrity failure.',
      'Next-check references are derived from cause labels; nextCheckCorrect is not an independent measure of diagnostic utility.',
      'The v1 live run had two unattributed invalid-response failures; controlled sub-reasons were added only afterward.',
      'Rubric v1 additionally rejects a definite cause with evidence:none. This rule is now explicit; it was not documented before the frozen run.',
      'No run, slot, recovery, publication or dispatch action is available to this evaluator.',
      'The v1 corpus is quarantined: repair commentary overlaps its reference rationale and HTTP-family variants cross splits. Its numbers cannot establish comparative effectiveness.',
      'Reserved cost covers unknown charges conservatively; reported monetary values are estimates from a price snapshot, not invoices.',
    ],
  };
  await save('evaluation.json', report);
  const jsonl = candidate.map((r) => JSON.stringify(r)).join('\n') + '\n';
  assertNoCredentials(jsonl);
  await writeFile(path.join(options.out, 'candidate-results.jsonl'), jsonl, {
    mode: 0o600,
    flag: 'wx',
  });
  await save('run.json', {
    ...runStart,
    status: 'completed',
    completedAt: new Date().toISOString(),
    corpusHash: corpusHash,
    decision: report.decision,
  });
  return report;
}

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { defaultAssessmentProviders } from '../default-providers.js';

import { cueBaseline, existingBaseline } from './baselines.js';
import { loadTriageCorpus } from './corpus.js';
import { CORPUS_HASH } from './corpus-lock.js';
import { estimateTriageInputCost, evaluateTriage, validTriagePrice } from './evaluate.js';
import { triageGate, triageMetrics } from './metrics.js';
import { prepareTriage, textDigest, triagePrediction } from './packet.js';
import { boundedAssessmentFetch } from './transport.js';
import { CHECK_FOR_LABEL, type TriageCase, type TriagePrice, type TriageResult } from './types.js';

const corpus = loadTriageCorpus();
test('legacy v1 stays byte-frozen without claiming its row groups prove incident independence', () => {
  assert.match(CORPUS_HASH, /^[a-f0-9]{64}$/);
  assert.equal(corpus.cases.length, 30);
  assert.equal(corpus.cases.filter((c) => c.split === 'development').length, 9);
  const seen = new Set<string>();
  for (const c of corpus.cases) {
    assert.ok(!seen.has(c.group));
    seen.add(c.group);
    const p = prepareTriage(c.packet, c);
    assert.equal(p.packet.caseId, c.id);
    assert.equal(Object.hasOwn(p.packet, 'reference'), false); // Structural exclusion does not fix the known commentary leak.
  }
});
test('admission rejects changed evidence and does not trust a provenance flag', () => {
  const c = corpus.cases[0],
    changed = structuredClone(c.packet);
  changed.evidence[0].text = 'private text';
  assert.throws(() => prepareTriage(changed, c), /data-not-admitted/);
  const foreign = JSON.parse(JSON.stringify(c));
  foreign.origin.kind = 'public';
  assert.throws(() => prepareTriage(foreign.packet, foreign), /data-not-admitted/);
});
test('redaction covers environment canaries, URL credentials and query secrets', () => {
  const before = process.env.TRIAGE_PROOF_API_KEY;
  process.env.TRIAGE_PROOF_API_KEY = 'triage-canary-123456789';
  try {
    const c: TriageCase = structuredClone(corpus.cases[0]);
    c.packet.evidence[0].text =
      'authorization: bearer triage-canary-123456789 https://name:pass@example.test/path?token=hidden-value {"password":"json-canary"}';
    c.packet.evidence[0].digest = textDigest(c.packet.evidence[0].text);
    const p = prepareTriage(c.packet, c, 'triage-canary-123456789');
    const bytes = JSON.stringify(p);
    for (const secret of ['triage-canary-123456789', 'name:pass', 'hidden-value', 'json-canary'])
      assert.ok(!bytes.includes(secret));
    assert.equal(p.packet.evidence[0].digest, textDigest(p.packet.evidence[0].text));
  } finally {
    if (before === undefined) delete process.env.TRIAGE_PROOF_API_KEY;
    else process.env.TRIAGE_PROOF_API_KEY = before;
  }
});
test('optional entries are omitted whole; oversized required evidence is rejected', () => {
  const c = structuredClone(corpus.cases[0]);
  const large = 'x'.repeat(30000);
  c.packet.evidence.push({ id: 'e3', text: large, digest: textDigest(large), required: false });
  const p = prepareTriage(c.packet, c);
  assert.deepEqual(p.omissions, [{ id: 'e3', reason: 'byte-limit' }]);
  assert.ok(!p.packet.evidence.some((e) => e.id === 'e3'));
  c.packet.evidence.at(-1)!.required = true;
  assert.throws(() => prepareTriage(c.packet, c), /limit/);
});
const choice = (value: string) => ({
  type: 'choice' as const,
  choice: value,
  confidence: 1,
  probabilities: { [value]: 1 },
});
test('unknown labels, fabricated evidence and unsupported actions fail closed', () => {
  const packet = corpus.cases[0].packet;
  assert.throws(
    () =>
      triagePrediction(
        { cause: choice('invented'), nextCheck: choice('inspect_prepare'), evidence: choice('e1') },
        packet,
      ),
    /label-vocabulary/,
  );
  assert.throws(
    () =>
      triagePrediction(
        {
          cause: choice('environment'),
          nextCheck: choice('inspect_prepare'),
          evidence: choice('e999'),
        },
        packet,
      ),
    /evidence-id/,
  );
  assert.throws(
    () =>
      triagePrediction(
        { cause: choice('environment'), nextCheck: choice('kill-process'), evidence: choice('e1') },
        packet,
      ),
    /check-vocabulary/,
  );
});
test('uncertain cases and missing transport do not masquerade as correct abstentions', () => {
  const cases = corpus.cases.filter((c) => c.split === 'held-out');
  const correct: TriageResult[] = cases.map((c) => ({
    caseId: c.id,
    status: 'completed',
    prediction: {
      label: c.reference.label,
      nextCheck: CHECK_FOR_LABEL[c.reference.label],
      evidenceIds: ['e1'],
    },
    durationMs: 1,
    reservedUsd: 0,
  }));
  const metrics = triageMetrics(cases, correct);
  assert.equal(metrics.accuracy, 1);
  assert.equal(metrics.correctAbstentions, 3);
  const missing = triageMetrics(cases, []);
  assert.equal(missing.correctAbstentions, 0);
  assert.equal(missing.unavailable, 21);
  assert.equal(
    triageGate({
      liveStatus: 'not_run',
      corpusIntegrityPassed: true,
      metrics,
      baseline: missing,
      cueSheet: missing,
      violations: 0,
      withinBudget: true,
    }).eligible,
    false,
  );
  assert.equal(
    triageGate({
      liveStatus: 'completed',
      corpusIntegrityPassed: true,
      metrics,
      baseline: missing,
      cueSheet: missing,
      violations: 0,
      withinBudget: true,
    }).eligible,
    true,
  );
  assert.equal(
    triageGate({
      liveStatus: 'completed',
      corpusIntegrityPassed: true,
      metrics,
      baseline: metrics,
      cueSheet: missing,
      violations: 0,
      withinBudget: true,
    }).eligible,
    false,
  );
});
test('both frozen baselines consume the same packet and abstain on mixed diagnostic cues', () => {
  const c = corpus.cases.find((c) => c.reference.rationale.startsWith('Independent external'))!;
  assert.equal(cueBaseline(c.packet).label, 'unclear');
  assert.ok(existingBaseline(c.packet));
});
test('offline is no-call despite global enable and fixtures cannot satisfy the live gate', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'triage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = process.env.FARMSLOT_ASSESSMENT_ENABLED;
  process.env.FARMSLOT_ASSESSMENT_ENABLED = 'true';
  t.after(() => {
    if (old === undefined) delete process.env.FARMSLOT_ASSESSMENT_ENABLED;
    else process.env.FARMSLOT_ASSESSMENT_ENABLED = old;
  });
  const offline = await evaluateTriage({ out: path.join(root, 'offline') });
  assert.equal(offline.usage.attempts, 0);
  assert.equal(offline.decision, 'hold');
  const fake = await evaluateTriage({
    out: path.join(root, 'fixture'),
    fixture: 'valid',
    maxCalls: 1,
  });
  assert.equal(fake.liveStatus, 'fixture');
  assert.equal(fake.usage.attempts, 1);
  assert.equal(fake.decision, 'hold');
  const rows = JSON.parse(
    await readFile(path.join(root, 'fixture', 'candidate-results.json'), 'utf8'),
  );
  assert.ok(rows.slice(1).every((r: { reason: string }) => r.reason === 'budget-exhausted'));
  await assert.rejects(evaluateTriage({ out: path.join(root, 'offline') }), /EEXIST/);
});
test('failed adapter replies retain received usage and preflight rejections release the reservation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'triage-adapter-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const caseId = corpus.cases.find((c) => c.split === 'held-out')!.id;
  const failed = await evaluateTriage({
    out: path.join(root, 'invalid'),
    fixture: 'adapter-invalid',
    caseId,
    maxCalls: 1,
  });
  const [charged] = JSON.parse(
    await readFile(path.join(root, 'invalid', 'candidate-results.json'), 'utf8'),
  );
  assert.equal(failed.usage.attempts, 1);
  assert.equal(charged.status, 'unavailable');
  assert.equal(charged.usage.inputTokens, 120);
  assert.equal(charged.usage.outputTokens, 20);
  assert.equal(charged.usage.cacheReadTokens, 10);
  assert.equal(charged.returnedModel, 'fixed');
  await evaluateTriage({
    out: path.join(root, 'semantic-invalid'),
    fixture: 'fabricated-evidence',
    caseId,
    maxCalls: 1,
  });
  const [semantic] = JSON.parse(
    await readFile(path.join(root, 'semantic-invalid', 'candidate-results.json'), 'utf8'),
  );
  assert.equal(semantic.status, 'unavailable');
  assert.ok(semantic.usage.inputTokens > 0);
  assert.equal(semantic.usage.outputTokens, 30);
  const preflight = await evaluateTriage({
    out: path.join(root, 'preflight'),
    fixture: 'adapter-preflight',
    caseId,
    maxCalls: 1,
  });
  const [notCharged] = JSON.parse(
    await readFile(path.join(root, 'preflight', 'candidate-results.json'), 'utf8'),
  );
  assert.equal(preflight.usage.attempts, 0);
  assert.equal(preflight.usage.reservedUsd, 0);
  assert.equal(notCharged.reason, 'provider-not-attempted');
  assert.equal(notCharged.reservedUsd, 0);
  assert.equal(notCharged.usage, undefined);
});
test('a received rate-limit without usage keeps its safe status while locking the offline price cohort', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'triage-http-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const caseId = corpus.cases.find((c) => c.split === 'held-out')!.id;
  const result = await evaluateTriage({
    out: path.join(root, 'rate-limit'),
    fixture: 'adapter-http-rate-limit',
    caseId,
    maxCalls: 1,
  });
  const [row] = JSON.parse(
    await readFile(path.join(root, 'rate-limit', 'candidate-results.json'), 'utf8'),
  );
  assert.equal(result.usage.attempts, 1);
  assert.equal(row.status, 'unavailable');
  assert.equal(row.reason, 'spend-bound-unverifiable');
  assert.equal(row.httpStatus, 429);
  assert.equal(row.usage, undefined);
  assert.equal(row.estimatedUsd, undefined);
});
test('an absent or mismatched returned model locks the evaluator price cohort', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'triage-model-price-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const caseId = corpus.cases.find((c) => c.split === 'held-out')!.id;
  for (const fixture of ['wrong-model', 'missing-model'] as const) {
    await evaluateTriage({
      out: path.join(root, fixture),
      fixture,
      caseId,
      maxCalls: 1,
    });
    const [row] = JSON.parse(
      await readFile(path.join(root, fixture, 'candidate-results.json'), 'utf8'),
    );
    assert.equal(row.status, 'unavailable');
    assert.equal(row.returnedModel, fixture === 'wrong-model' ? 'unpriced-model' : undefined);
    assert.equal(row.usage.inputTokens > 0, true);
    assert.equal(row.estimatedUsd, undefined);
    assert.equal(row.reason, 'spend-bound-unverifiable');
  }
  assert.equal(estimateTriageInputCost(120, { inputUsdPerMillion: 1 }, false, false), undefined);
  assert.equal(estimateTriageInputCost(120, { inputUsdPerMillion: 1 }, true, false), 0.00012);
});
test('price validation refuses unknown models, expired snapshots and paid outputs without bounds', () => {
  const price: TriagePrice = {
    version: 1,
    provider: 'typesafe',
    model: 'fixed',
    verifiedAt: new Date().toISOString(),
    source: 'https://docs.typesafe.ai/models',
    inputUsdPerMillion: 0.042,
    outputUsdPerMillion: 0,
    maxRequestTokens: 65536,
  };
  assert.equal(validTriagePrice(price, 'typesafe', 'fixed'), true);
  assert.equal(validTriagePrice(price, 'typesafe', 'unknown'), false);
  assert.equal(
    validTriagePrice({ ...price, verifiedAt: '2020-01-01' }, 'typesafe', 'fixed'),
    false,
  );
  assert.equal(validTriagePrice({ ...price, outputUsdPerMillion: 1 }, 'typesafe', 'fixed'), false);
});

test('transport forbids redirects and rejects oversized bodies before SDK parsing', async () => {
  let redirected: string | undefined;
  const fake: typeof fetch = async (_input, init) => {
    redirected = init?.redirect;
    return new Response('x'.repeat(65537));
  };
  await assert.rejects(boundedAssessmentFetch(fake)('https://example.test'), /byte limit/);
  assert.equal(redirected, 'error');
  const valid: typeof fetch = async () => new Response('{"ok":true}');
  assert.deepEqual(await (await boundedAssessmentFetch(valid)('https://example.test')).json(), {
    ok: true,
  });
});
test('the LLM adapter reads large bounded SSE replies without the native provider body cap', async () => {
  let calls = 0;
  const fake: typeof fetch = async () => {
    calls++;
    const terminal = {
      type: 'response.completed',
      response: {
        id: 'resp_fixture',
        model: 'fixture-model',
        status: 'completed',
        usage: { input_tokens: 100, output_tokens: 20 },
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '{"answers":{"cause":"environment"}}' }],
          },
        ],
      },
    };
    return new Response(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'x'.repeat(70 * 1024) })}\n\ndata: ${JSON.stringify(terminal)}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const provider = defaultAssessmentProviders(boundedAssessmentFetch(fake), fake).get('codex-lb')!;
  const result = await provider.assess({
    state: { failure: 'synthetic' },
    questions: {
      cause: {
        type: 'choice',
        instructions: 'Cause?',
        criteria: { environment: 'Environment', implementation: 'Code' },
      },
    },
    model: 'fixture-model',
    apiKey: 'fixture-key',
    signal: new AbortController().signal,
  });
  assert.equal(calls, 1);
  assert.equal(result.answers.cause.type, 'choice');
  assert.equal(
    result.answers.cause.type === 'choice' && result.answers.cause.choice,
    'environment',
  );
  assert.equal(result.usage.inputTokens, 100);
});

test('quarantined corpus cannot qualify even with perfect metrics', () => {
  const cases = corpus.cases.filter((c) => c.split === 'held-out');
  const rows: TriageResult[] = cases.map((c) => ({
    caseId: c.id,
    status: 'completed',
    prediction: { label: c.reference.label, nextCheck: c.reference.nextCheck, evidenceIds: ['e1'] },
    durationMs: 0,
    reservedUsd: 0,
  }));
  const m = triageMetrics(cases, rows),
    empty = triageMetrics(cases, []);
  const gate = triageGate({
    liveStatus: 'completed',
    corpusIntegrityPassed: false,
    metrics: m,
    baseline: empty,
    cueSheet: empty,
    violations: 0,
    withinBudget: true,
  });
  assert.equal(gate.eligible, false);
  assert.equal(gate.checks.find((c) => c.id === 'corpus-integrity-reviewed')?.passed, false);
});
test('terminal metadata preserves start/config and size skips are not safety violations', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'triage-meta-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await evaluateTriage({ out: path.join(root, 'out'), maxBytes: 512 });
  assert.equal(result.safetyViolations, 0);
  assert.equal(result.admissionSkips, 21);
  const run = JSON.parse(await readFile(path.join(root, 'out', 'run.json'), 'utf8'));
  assert.ok(run.startedAt);
  assert.equal(run.options.maxBytes, 512);
  assert.ok(run.priceHash);
  assert.equal(run.status, 'completed');
});

test('live v1 is vetoed before transport even with credentials and a valid price', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'triage-quarantine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const price = JSON.parse(
    await readFile(
      new URL('../../../../../scripts/failure-triage/prices.json', import.meta.url),
      'utf8',
    ),
  );
  t.mock.method(Date, 'now', () => Date.parse(price.verifiedAt) + 1000);
  const request = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected transport');
  });
  const old = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-quarantine-canary';
  t.after(() => {
    if (old === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = old;
  });
  const result = await evaluateTriage({
    out: path.join(root, 'out'),
    live: true,
    provider: price.provider,
    model: price.model,
  });
  assert.equal(request.mock.callCount(), 0);
  assert.equal(result.usage.attempts, 0);
  assert.equal(result.liveStatus, 'not_run');
  assert.equal(result.corpusIntegrity.passed, false);
  const rows = JSON.parse(await readFile(path.join(root, 'out', 'candidate-results.json'), 'utf8'));
  assert.ok(rows.every((r: { reason: string }) => r.reason === 'corpus-integrity-failed'));
});
test('definite causes without evidence have a controlled rejection code', () => {
  assert.throws(
    () =>
      triagePrediction(
        {
          cause: choice('implementation'),
          nextCheck: choice('inspect_failed_assertion'),
          evidence: choice('none'),
        },
        corpus.cases[0].packet,
      ),
    /definite-without-evidence/,
  );
});

test('a future approved corpus still requires provider, credentials, pricing and budget', async () => {
  const { triageSkipReason } = await import('./evaluate.js');
  const valid = {
    mode: 'live' as const,
    integrityPassed: true,
    providerAvailable: true,
    keyAvailable: true,
    priceReady: true,
    budgetExhausted: false,
  };
  assert.equal(triageSkipReason(valid), undefined);
  assert.equal(triageSkipReason({ ...valid, mode: 'offline' }), 'offline');
  assert.equal(triageSkipReason({ ...valid, mode: 'fixture', priceReady: false }), undefined);
  assert.equal(triageSkipReason({ ...valid, providerAvailable: false }), 'unknown-provider');
  assert.equal(triageSkipReason({ ...valid, keyAvailable: false }), 'missing-key');
  assert.equal(triageSkipReason({ ...valid, priceReady: false }), 'unknown-or-stale-price');
  assert.equal(triageSkipReason({ ...valid, budgetExhausted: true }), 'budget-exhausted');
  assert.equal(
    triageSkipReason({ ...valid, integrityPassed: false, providerAvailable: false }),
    'corpus-integrity-failed',
  );
});

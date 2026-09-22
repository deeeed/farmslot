import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cueBaseline, existingBaseline } from './baselines.js';
import { loadTriageCorpus } from './corpus.js';
import { CORPUS_HASH } from './corpus-lock.js';
import { evaluateTriage, validTriagePrice } from './evaluate.js';
import { triageGate, triageMetrics } from './metrics.js';
import { prepareTriage, textDigest, triagePrediction } from './packet.js';
import { CHECK_FOR_LABEL, type TriageCase, type TriagePrice, type TriageResult } from './types.js';

const corpus = loadTriageCorpus();
test('frozen corpus has thirty admitted cases and an incident-disjoint 9/21 split', () => {
  assert.match(CORPUS_HASH, /^[a-f0-9]{64}$/);
  assert.equal(corpus.cases.length, 30);
  assert.equal(corpus.cases.filter((c) => c.split === 'development').length, 9);
  const seen = new Set<string>();
  for (const c of corpus.cases) {
    assert.ok(!seen.has(c.group));
    seen.add(c.group);
    const p = prepareTriage(c.packet, c);
    assert.equal(p.packet.caseId, c.id);
    assert.ok(!JSON.stringify(p.packet).includes(c.reference.rationale));
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
    /invalid-label/,
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
    /invalid-label-or-evidence/,
  );
  assert.throws(
    () =>
      triagePrediction(
        { cause: choice('environment'), nextCheck: choice('kill-process'), evidence: choice('e1') },
        packet,
      ),
    /invalid-label/,
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
  const { boundedAssessmentFetch } = await import('./transport.js');
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

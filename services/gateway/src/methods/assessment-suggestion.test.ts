import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AssessmentSuggestionInput } from '@farmslot/protocol';

import { readAssessmentArtifact } from '../assessment/artifacts.js';
import {
  AssessmentResponseError,
  createAssessmentProviderRegistry,
} from '../assessment/provider.js';
import { assessmentRecords, recordAssessmentFeedback } from '../assessment/store.js';
import { createRun, deleteRun, updateRun } from '../runs/store.js';
import { runWithSessionOriginator } from '../security/work-originator.js';

import {
  assessmentSuggestionAnalyze,
  assessmentSuggestionPreview,
} from './assessment-suggestion.js';

const principal = {
  id: 'suggestion-test',
  subject: { type: 'person' as const, displayName: 'Tester' },
  roles: [],
};
const asOperator = <T>(work: () => T) => runWithSessionOriginator(principal, work);
const base = {
  source: { classification: 'synthetic' as const, ref: 'synthetic:assessment-fixture' },
  context: 'Changed the API routing after a user action; no screenshots are available.',
  pr: { host: 'github.com', repo: 'example/app', number: 42, headSha: 'a'.repeat(40) },
};
const routing: AssessmentSuggestionInput = { kind: 'review-routing', ...base };

function setup(t: test.TestContext) {
  const home = mkdtempSync(path.join(tmpdir(), 'suggestion-'));
  const old = Object.fromEntries(
    [
      'FARMSLOT_HOME',
      'FARMSLOT_ASSESSMENT_ENABLED',
      'FARMSLOT_ASSESSMENT_PROVIDER',
      'FARMSLOT_ASSESSMENT_MODEL',
      'TYPESAFE_API_KEY',
    ].map((key) => [key, process.env[key]]),
  );
  process.env.FARMSLOT_HOME = home;
  process.env.FARMSLOT_ASSESSMENT_ENABLED = 'true';
  process.env.FARMSLOT_ASSESSMENT_PROVIDER = 'typesafe';
  process.env.FARMSLOT_ASSESSMENT_MODEL = 'jev-1.13.0';
  process.env.TYPESAFE_API_KEY = 'fake-synthetic-test-key';
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  const policy = {
    version: 1,
    enabled: true,
    price: {
      version: 1,
      provider: 'typesafe',
      model: 'jev-1.13.0',
      verifiedAt: new Date().toISOString(),
      source: 'https://docs.typesafe.ai/models',
      inputUsdPerMillion: 0.042,
      outputUsdPerMillion: 0,
      maxInputTokens: 8192,
      maxOutputTokens: 512,
    },
    limits: { maxCalls: 4, maxUsd: 0.01 },
  };
  const writePolicy = () =>
    writeFileSync(path.join(home, 'assessment-suggestion-policy.json'), JSON.stringify(policy));
  return { home, policy, writePolicy };
}

test('explicit preview, confirmed call, durable history and feedback never mutate a review', async (t) => {
  const { policy, writePolicy } = setup(t);
  let calls = 0;
  const registry = createAssessmentProviderRegistry([
    {
      id: 'typesafe',
      credentialEnv: 'TYPESAFE_API_KEY',
      defaultModel: 'jev-1.13.0',
      capabilities: ['choice'] as const,
      assess: async ({ questions }) => {
        calls++;
        return {
          returnedModel: 'jev-1.13.0',
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              {
                type: 'choice',
                choice: id === 'route' ? 'full-live' : 'abstain',
                choices: Object.keys(
                  questions[id]!.type === 'choice' ? questions[id]!.criteria : {},
                ),
              },
            ]),
          ),
          usage: { inputTokens: 230, outputTokens: 12, durationMs: 17 },
        };
      },
    },
  ]);
  const disabled = await asOperator(() => assessmentSuggestionPreview(routing));
  assert.equal(disabled.eligible, false);
  assert.equal(disabled.reason, 'disabled');
  assert.equal(calls, 0);
  writePolicy();
  policy.price.verifiedAt = '2000-01-01T00:00:00.000Z';
  writePolicy();
  const expired = await asOperator(() => assessmentSuggestionPreview(routing));
  assert.equal(expired.reason, 'price-unavailable');
  policy.price.verifiedAt = new Date().toISOString();
  policy.limits.maxUsd = 0.00001;
  writePolicy();
  const overBudget = await asOperator(() => assessmentSuggestionPreview(routing));
  assert.equal(overBudget.reason, 'budget-blocked');
  policy.limits.maxUsd = 0.01;
  writePolicy();
  const preview = await asOperator(() => assessmentSuggestionPreview(routing));
  assert.equal(preview.eligible, true);
  assert.equal(calls, 0);
  assert.equal((await asOperator(() => assessmentRecords(principal.id))).length, 0);
  process.env.FARMSLOT_ASSESSMENT_MODEL = 'jev-next';
  const switched = await asOperator(() =>
    assessmentSuggestionAnalyze(
      { input: routing, expectedPacketHash: preview.packetHash!, confirmed: true },
      registry,
    ),
  );
  assert.equal(switched.reason, 'stale');
  assert.equal(calls, 0);
  process.env.FARMSLOT_ASSESSMENT_MODEL = 'jev-1.13.0';
  policy.price.verifiedAt = new Date(Date.now() - 60_000).toISOString();
  writePolicy();
  const repriced = await asOperator(() =>
    assessmentSuggestionAnalyze(
      { input: routing, expectedPacketHash: preview.packetHash!, confirmed: true },
      registry,
    ),
  );
  assert.equal(repriced.reason, 'stale');
  policy.price.verifiedAt = new Date().toISOString();
  writePolicy();
  // The original price snapshot and model must be previewed again after any change.
  const renewed = await asOperator(() => assessmentSuggestionPreview(routing));
  await assert.rejects(
    asOperator(() =>
      assessmentSuggestionAnalyze(
        { input: routing, expectedPacketHash: renewed.packetHash!, confirmed: false as true },
        registry,
      ),
    ),
    /Confirm/,
  );
  const stale = await asOperator(() =>
    assessmentSuggestionAnalyze(
      {
        input: { ...routing, context: 'Changed context' },
        expectedPacketHash: renewed.packetHash!,
        confirmed: true,
      },
      registry,
    ),
  );
  assert.equal(stale.reason, 'stale');
  assert.equal(calls, 0);
  const result = await asOperator(() =>
    assessmentSuggestionAnalyze(
      { input: routing, expectedPacketHash: renewed.packetHash!, confirmed: true },
      registry,
    ),
  );
  assert.equal(result.assessment?.answers?.route?.type, 'choice');
  assert.equal(result.assessment?.usage?.costKind, 'estimated');
  assert.equal(calls, 1);
  const saved = (await asOperator(() => assessmentRecords(principal.id)))[0]!;
  assert.equal(saved.consumer, 'review-routing');
  assert.equal(saved.subject.suggestion?.context, routing.context);
  assert.equal(saved.result?.assessmentId, saved.id);
  assert.equal(saved.feedback.length, 0);
  const updated = await asOperator(() =>
    recordAssessmentFeedback(principal.id, {
      id: saved.id,
      expectedRevision: 0,
      questionId: 'route',
      verdict: 'correct',
      evidenceRef: 'synthetic:assessment-fixture',
      adviceUsed: false,
      adviceShown: true,
    }),
  );
  assert.equal(updated.feedback[0]?.verdict, 'correct');
  await asOperator(() =>
    assessmentSuggestionAnalyze(
      { input: routing, expectedPacketHash: renewed.packetHash!, confirmed: true },
      registry,
    ),
  );
  assert.equal(calls, 1);
});

test('full twelve-item form previews within the bounded packet and saved refusals stay visible', async (t) => {
  const { policy, writePolicy } = setup(t);
  writePolicy();
  const input: AssessmentSuggestionInput = {
    kind: 'static-review-checklist',
    ...base,
    items: Array.from({ length: 12 }, (_, index) => ({
      id: `item${index}`,
      text: 'Changed navigation retains the destination',
      evidence: 'src/nav.ts:12 redirects to /account; '.repeat(47),
    })),
  };
  const tooLarge = await asOperator(() => assessmentSuggestionPreview(input));
  assert.equal(tooLarge.eligible, false);
  assert.equal(tooLarge.reason, 'price-unavailable');
  assert.equal(Object.keys(tooLarge.packet?.questions ?? {}).length, 12);
  let calls = 0;
  const unavailable = createAssessmentProviderRegistry([
    {
      id: 'typesafe',
      credentialEnv: 'TYPESAFE_API_KEY',
      defaultModel: 'jev-1.13.0',
      capabilities: ['choice'] as const,
      assess: async () => {
        calls++;
        throw new AssessmentResponseError(
          'Synthetic provider refusal',
          true,
          { inputTokens: 128, outputTokens: 0, durationMs: 1 },
          'jev-1.13.0',
          true,
        );
      },
    },
  ]);
  const refused = await asOperator(() =>
    assessmentSuggestionAnalyze(
      { input, expectedPacketHash: tooLarge.packetHash!, confirmed: true },
      unavailable,
    ),
  );
  assert.equal(refused.reason, 'price-unavailable');
  assert.equal(calls, 0);
  assert.equal((await asOperator(() => assessmentRecords(principal.id))).length, 0);
  policy.price.maxInputTokens = 65_536;
  writePolicy();
  const preview = await asOperator(() => assessmentSuggestionPreview(input));
  assert.equal(preview.eligible, true);
  const first = await asOperator(() =>
    assessmentSuggestionAnalyze(
      { input, expectedPacketHash: preview.packetHash!, confirmed: true },
      unavailable,
    ),
  );
  assert.equal(first.assessment?.status, 'unavailable');
  assert.equal(calls, 1);
  const inputArtifact = await readAssessmentArtifact(
    principal.id,
    'inputs',
    createHash('sha256').update(JSON.stringify(first.assessment!.assessmentId!)).digest('hex'),
  );
  assert.equal(
    (inputArtifact as { packet: { state: { items: unknown[] } } }).packet.state.items.length,
    12,
  );
  const saved = await asOperator(() =>
    assessmentSuggestionAnalyze(
      { input, expectedPacketHash: preview.packetHash!, confirmed: true },
      unavailable,
    ),
  );
  assert.equal(saved.eligible, false);
  assert.equal(saved.reason, 'saved-attempt');
  assert.equal(saved.assessment?.status, 'unavailable');
});

test('provider replies respect spend, identity, usage, answer and daily limits', async (t) => {
  const cases = [
    {
      name: 'over input limit',
      inputTokens: 8193,
      model: 'jev-1.13.0',
      answers: true,
      error: 'spend-bound-exceeded',
    },
    {
      name: 'returned model differs',
      inputTokens: 128,
      model: 'other-build',
      answers: true,
      error: 'spend-bound-unverifiable',
    },
    {
      name: 'missing usage',
      inputTokens: undefined,
      model: 'jev-1.13.0',
      answers: true,
      error: 'spend-bound-unverifiable',
    },
    {
      name: 'missing answer',
      inputTokens: 128,
      model: 'jev-1.13.0',
      answers: false,
      error: 'Invalid suggestion answers',
    },
  ] as const;
  for (const scenario of cases) {
    await t.test(scenario.name, async (sub) => {
      const { writePolicy } = setup(sub);
      writePolicy();
      const registry = createAssessmentProviderRegistry([
        {
          id: 'typesafe',
          credentialEnv: 'TYPESAFE_API_KEY',
          defaultModel: 'jev-1.13.0',
          capabilities: ['choice'] as const,
          assess: async ({ questions }) => ({
            returnedModel: scenario.model,
            answers: scenario.answers
              ? Object.fromEntries(
                  Object.keys(questions).map((id) => [
                    id,
                    {
                      type: 'choice' as const,
                      choice: 'full-live',
                      choices: ['static-code', 'full-live', 'abstain'],
                    },
                  ]),
                )
              : {},
            usage: { inputTokens: scenario.inputTokens as number, outputTokens: 10, durationMs: 1 },
          }),
        },
      ]);
      const preview = await asOperator(() => assessmentSuggestionPreview(routing));
      assert.equal(preview.eligible, true);
      const reply = await asOperator(() =>
        assessmentSuggestionAnalyze(
          { input: routing, expectedPacketHash: preview.packetHash!, confirmed: true },
          registry,
        ),
      );
      assert.equal(reply.assessment?.status, 'unavailable');
      assert.equal(reply.assessment?.error, scenario.error);
      if (scenario.error.startsWith('spend-bound')) {
        const other = { ...routing, context: 'A distinct synthetic routing change.' };
        const otherPreview = await asOperator(() => assessmentSuggestionPreview(other));
        const stopped = await asOperator(() =>
          assessmentSuggestionAnalyze(
            { input: other, expectedPacketHash: otherPreview.packetHash!, confirmed: true },
            registry,
          ),
        );
        assert.equal(stopped.reason, 'budget-blocked');
      }
    });
  }
  await t.test('daily calls cap blocks a second packet', async (sub) => {
    const { policy, writePolicy } = setup(sub);
    policy.limits.maxCalls = 1;
    writePolicy();
    const registry = createAssessmentProviderRegistry([
      {
        id: 'typesafe',
        credentialEnv: 'TYPESAFE_API_KEY',
        defaultModel: 'jev-1.13.0',
        capabilities: ['choice'] as const,
        assess: async () => ({
          returnedModel: 'jev-1.13.0',
          answers: {
            route: {
              type: 'choice' as const,
              choice: 'full-live',
              choices: ['static-code', 'full-live', 'abstain'],
            },
          },
          usage: { inputTokens: 128, outputTokens: 10, durationMs: 1 },
        }),
      },
    ]);
    const first = await asOperator(() => assessmentSuggestionPreview(routing));
    await asOperator(() =>
      assessmentSuggestionAnalyze(
        { input: routing, expectedPacketHash: first.packetHash!, confirmed: true },
        registry,
      ),
    );
    const other = { ...routing, context: 'A distinct synthetic routing change.' };
    const second = await asOperator(() => assessmentSuggestionPreview(other));
    const stopped = await asOperator(() =>
      assessmentSuggestionAnalyze(
        { input: other, expectedPacketHash: second.packetHash!, confirmed: true },
        registry,
      ),
    );
    assert.equal(stopped.reason, 'budget-blocked');
  });
});

test('checklist items and copilot candidates share the same persisted provider path', async (t) => {
  const { writePolicy } = setup(t);
  writePolicy();
  const run = createRun({ flowType: 'fix-bug', project: 'example', ticketOrPr: 'SYNTH-42' });
  t.after(async () => {
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
  });
  const inputs: AssessmentSuggestionInput[] = [
    {
      kind: 'static-review-checklist',
      ...base,
      items: [
        {
          id: 'navigation',
          text: 'Navigation target is correct',
          evidence: 'src/nav.ts:12 redirects to /account',
        },
      ],
    },
    {
      kind: 'copilot-context',
      source: base.source,
      context: 'Find the failed step source',
      runId: run.id,
      candidates: [
        { id: 'status', description: 'Status snapshot' },
        { id: 'logs', description: 'Bounded logs' },
      ],
    },
  ];
  const registry = createAssessmentProviderRegistry([
    {
      id: 'typesafe',
      credentialEnv: 'TYPESAFE_API_KEY',
      defaultModel: 'jev-1.13.0',
      capabilities: ['choice'] as const,
      assess: async ({ questions }) => ({
        returnedModel: 'jev-1.13.0',
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, question]) => [
            id,
            {
              type: 'choice',
              choice: 'abstain',
              choices: Object.keys(question.type === 'choice' ? question.criteria : {}),
            },
          ]),
        ),
        usage: { inputTokens: 210, outputTokens: 4, durationMs: 6 },
      }),
    },
  ]);
  for (const input of inputs) {
    const preview = await asOperator(() => assessmentSuggestionPreview(input));
    assert.equal(preview.eligible, true);
    const result = await asOperator(() =>
      assessmentSuggestionAnalyze(
        { input, expectedPacketHash: preview.packetHash!, confirmed: true },
        registry,
      ),
    );
    assert.equal(result.assessment?.status, 'completed');
    assert.ok(
      Object.values(result.assessment.answers ?? {}).every(
        (answer) => answer.type === 'choice' && answer.choice === 'abstain',
      ),
    );
  }
  const records = await asOperator(() => assessmentRecords(principal.id));
  assert.deepEqual(
    new Set(records.map((row) => row.consumer)),
    new Set(['static-review-checklist', 'copilot-context']),
  );
  assert.equal(records.find((row) => row.consumer === 'copilot-context')?.subject.run?.id, run.id);
});

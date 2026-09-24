import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cases = JSON.parse(readFileSync(new URL('./cases.v3.json', import.meta.url), 'utf8'));
const labels = JSON.parse(readFileSync(new URL('./labels.v3.json', import.meta.url), 'utf8'));
const { evaluate } = await import('./evaluate.mjs');

test('new synthetic AC cases exercise gateway methods and audit store', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'farmslot-ac-v3-'));
  const previous = Object.fromEntries(
    [
      'FARMSLOT_HOME',
      'FARMSLOT_ACCEPTANCE_EVIDENCE_ENABLED',
      'FARMSLOT_ASSESSMENT_ENABLED',
      'FARMSLOT_ASSESSMENT_PROVIDER',
      'FARMSLOT_ASSESSMENT_MODEL',
      'CODEX_LB_API_KEY',
      'TMUX',
      'TMUX_TMPDIR',
    ].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    FARMSLOT_HOME: home,
    FARMSLOT_ACCEPTANCE_EVIDENCE_ENABLED: 'true',
    FARMSLOT_ASSESSMENT_ENABLED: 'true',
    FARMSLOT_ASSESSMENT_PROVIDER: 'codex-lb',
    FARMSLOT_ASSESSMENT_MODEL: 'fixture-model',
    CODEX_LB_API_KEY: 'synthetic-test-credential',
    TMUX: '',
    TMUX_TMPDIR: home,
  });
  const { createRun, deleteRun, updateRun } =
    await import('../../services/gateway/src/runs/store.js');
  const { acceptanceEvidenceGet } =
    await import('../../services/gateway/src/methods/acceptance-evidence.js');
  const runs: string[] = [];
  const runForCase = new Map<string, string>();
  const policyEntries: Array<Record<string, string>> = [];
  try {
    for (const entry of cases.cases) {
      const run = createRun({ flowType: 'fix-bug', project: 'example-farm', ticketOrPr: entry.id });
      runs.push(run.id);
      runForCase.set(entry.id, run.id);
      const dir = path.join(home, 'tasks', run.id);
      mkdirSync(path.join(dir, 'inputs'), { recursive: true });
      mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
      updateRun(run.id, { taskFile: path.join(dir, 'TASK.md') });
      writeFileSync(
        path.join(dir, 'inputs', 'handoff.json'),
        JSON.stringify({
          task: { acceptanceCriteria: [entry.criterion] },
        }),
      );
      writeFileSync(
        path.join(dir, 'artifacts', 'acceptance-status.json'),
        JSON.stringify({
          schemaVersion: 1,
          criteria: [
            {
              id: entry.criterionId,
              text: entry.criterion,
              verdict: 'weak',
              proofMode: entry.proofMode,
              evidence: entry.evidence.map(({ id }: { id: string }) => id),
              recipeNodes: [],
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      );
      if (entry.proofMode === 'state') {
        for (const evidence of entry.evidence) {
          const file = path.join(dir, evidence.id);
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, evidence.text);
        }
      }
      const result = await acceptanceEvidenceGet({ runId: run.id, criterionId: entry.criterionId });
      if (entry.proofMode !== 'state') {
        assert.equal(result.reason, 'non-textual', entry.id);
        assert.equal(result.snapshotHash, undefined, entry.id);
        continue;
      }
      assert.equal(result.reason, 'not-admitted', entry.id);
      assert.equal(result.criterion?.text, entry.criterion, entry.id);
      assert.deepEqual(result.evidence, entry.evidence, entry.id);
      const packet = {
        version: 1,
        criterion: { id: entry.criterionId, text: entry.criterion },
        evidence: entry.evidence.map(({ id, text }: { id: string; text: string }) => ({
          id,
          text,
        })),
      };
      const expected = createHash('sha256')
        .update(JSON.stringify({ runId: run.id, packet }))
        .digest('hex');
      assert.equal(result.snapshotHash, expected, entry.id);
      policyEntries.push({
        runId: run.id,
        criterionId: entry.criterionId,
        snapshotHash: expected,
        classification: 'synthetic',
        sourceRef: `synthetic:acceptance-evidence-v3/${entry.id}`,
      });
    }
    writeFileSync(
      path.join(home, 'acceptance-evidence-policy.json'),
      JSON.stringify({
        version: 1,
        entries: policyEntries,
        price: {
          version: 1,
          provider: 'codex-lb',
          model: 'fixture-model',
          verifiedAt: new Date().toISOString(),
          source: 'https://example.org/prices',
          inputUsdPerMillion: 0.05,
          outputUsdPerMillion: 0,
          maxInputTokens: 8192,
          maxOutputTokens: 500,
        },
        limits: { maxCalls: 12, maxUsd: 0.02 },
      }),
    );
    const { createAssessmentProviderRegistry } =
      await import('../../services/gateway/src/assessment/provider.js');
    const { assessmentRecords } = await import('../../services/gateway/src/assessment/store.js');
    const { runWithSessionOriginator } =
      await import('../../services/gateway/src/security/work-originator.js');
    const { acceptanceEvidenceAnalyze } =
      await import('../../services/gateway/src/methods/acceptance-evidence.js');
    const principal = {
      id: 'ac-v3-gateway-test',
      subject: { type: 'person' as const, displayName: 'AC v3 test' },
      roles: [],
    };
    const withPrincipal = <T,>(operation: () => T) =>
      runWithSessionOriginator(principal, operation);
    let providerCalls = 0;
    const expected = new Map<string, string>(
      labels.labels.map((label: { id: string; expected: string }) => [label.id, label.expected]),
    );
    let nextVerdict = 'insufficient';
    let nextCaseId = '';
    const registry = createAssessmentProviderRegistry([
      {
        id: 'codex-lb',
        defaultModel: 'fixture-model',
        credentialEnv: 'CODEX_LB_API_KEY',
        capabilities: ['choice'],
        async assess(request) {
          providerCalls++;
          const entry = cases.cases.find((item: { id: string }) => item.id === nextCaseId);
          assert.ok(entry, nextCaseId);
          assert.deepEqual(request.state, {
            version: 1,
            criterion: { id: entry.criterionId, text: entry.criterion },
            evidence: entry.evidence,
          });
          assert.equal(JSON.stringify(request.state).includes(nextCaseId), false);
          assert.equal(
            JSON.stringify(request.state).includes('synthetic:acceptance-evidence-v3'),
            false,
          );
          return {
            returnedModel: 'fixture-model',
            answers: {
              verdict: {
                type: 'choice' as const,
                choice: nextVerdict,
                choices: ['supported', 'contradicted', 'insufficient'],
              },
            },
            usage: { inputTokens: 100, outputTokens: 4, durationMs: 15 },
          };
        },
      },
    ]);
    for (const excluded of cases.cases.filter(
      (entry: { proofMode: string }) => entry.proofMode !== 'state',
    )) {
      const refused = await withPrincipal(() =>
        acceptanceEvidenceAnalyze(
          {
            runId: runForCase.get(excluded.id)!,
            criterionId: excluded.criterionId,
            expectedSnapshotHash: 'a'.repeat(64),
          },
          registry,
        ),
      );
      assert.equal(refused.reason, 'non-textual', excluded.id);
    }
    assert.equal(providerCalls, 0);
    for (const admitted of policyEntries) {
      const caseId = admitted.sourceRef.split('/').at(-1)!;
      nextCaseId = caseId;
      nextVerdict = expected.get(caseId)!;
      const result = await withPrincipal(() =>
        acceptanceEvidenceAnalyze(
          {
            runId: admitted.runId,
            criterionId: admitted.criterionId,
            expectedSnapshotHash: admitted.snapshotHash,
          },
          registry,
        ),
      );
      assert.equal(result.verdict, nextVerdict, admitted.sourceRef);
    }
    assert.equal(providerCalls, 12);
    const records = await assessmentRecords(principal.id);
    assert.equal(records.length, 12);
    const study = {
      version: 1,
      corpusVersion: 3,
      cases: cases.cases.map((entry: { id: string; proofMode: string }) => {
        if (entry.proofMode !== 'state')
          return { caseId: entry.id, baseline: null, assisted: null, assessmentRecordIds: [] };
        const runId = runForCase.get(entry.id);
        const record = records.find((item) => item.subject.run?.id === runId);
        assert.ok(record, entry.id);
        const arm = {
          judgment: expected.get(entry.id)!,
          elapsedMs: 100,
          workerTokens: 100,
          workerCostUsd: 0.01,
        };
        return {
          caseId: entry.id,
          assistedRunId: runId,
          assessmentRecordIds: [record.id],
          baseline: arm,
          assisted: arm,
        };
      }),
      assessmentRecords: records,
    };
    const evaluated = evaluate(study, cases, labels);
    assert.equal(evaluated.assessment.attemptedCalls, 12);
    assert.equal(evaluated.assessment.unknownUsageOrCostCalls, 0);
    assert.equal(evaluated.assessment.totals.tokens, 1248);
    assert.ok(Math.abs(evaluated.assessment.totals.cost - 0.00006) < 1e-12);
    assert.equal(evaluated.assessment.totals.latency, 180);
    assert.equal(evaluated.quality.provider.heldOut.correct, 9);
    assert.equal(evaluated.gate, 'inconclusive'); // Equal arms: correct labels prove no savings.
    const wrongAnswer = structuredClone(study);
    const insufficientRecord = wrongAnswer.assessmentRecords.find(
      (record) => record.subject.run.criterion.text === 'Unauthorized request U4 received HTTP 403',
    );
    assert.ok(insufficientRecord);
    insufficientRecord.result.answers.verdict.choice = 'supported';
    assert.equal(evaluate(wrongAnswer, cases, labels).gate, 'hold');
    const tampered = structuredClone(study);
    tampered.assessmentRecords[0].subject.run.snapshotHash = 'a'.repeat(64);
    assert.throws(() => evaluate(tampered, cases, labels), /snapshot, input or admission/);
    const wrongSource = structuredClone(study);
    wrongSource.assessmentRecords[0].subject.run.admission.sourceRef = 'synthetic:other-source';
    assert.throws(() => evaluate(wrongSource, cases, labels), /snapshot, input or admission/);
    const wrongInput = structuredClone(study);
    wrongInput.assessmentRecords[0].requestedIdentity.inputDigest = 'b'.repeat(64);
    assert.throws(() => evaluate(wrongInput, cases, labels), /snapshot, input or admission/);
    const wrongEvidence = structuredClone(study);
    wrongEvidence.assessmentRecords[0].subject.run.sources[0].digest = 'c'.repeat(64);
    assert.throws(() => evaluate(wrongEvidence, cases, labels), /snapshot, input or admission/);
    const missingSources = structuredClone(study);
    delete missingSources.assessmentRecords[0].subject.run.sources;
    assert.throws(() => evaluate(missingSources, cases, labels), /snapshot, input or admission/);
    const reorderedSources = structuredClone(study);
    const multiSource = reorderedSources.assessmentRecords.find(
      (record) => record.subject.run.sources.length > 1,
    );
    assert.ok(multiSource);
    multiSource.subject.run.sources.reverse();
    assert.throws(() => evaluate(reorderedSources, cases, labels), /snapshot, input or admission/);
    const missingSource = structuredClone(study);
    missingSource.assessmentRecords[0].subject.run.sources.pop();
    assert.throws(() => evaluate(missingSource, cases, labels), /snapshot, input or admission/);
    const wrongSourceId = structuredClone(study);
    wrongSourceId.assessmentRecords[0].subject.run.sources[0].sourceId = 'artifacts/other.log';
    assert.throws(() => evaluate(wrongSourceId, cases, labels), /snapshot, input or admission/);
    const swappedAdmission = structuredClone(study);
    const first = swappedAdmission.assessmentRecords[0];
    const second = swappedAdmission.assessmentRecords[1];
    [first.subject.run.admission.sourceRef, second.subject.run.admission.sourceRef] = [
      second.subject.run.admission.sourceRef,
      first.subject.run.admission.sourceRef,
    ];
    assert.throws(() => evaluate(swappedAdmission, cases, labels), /snapshot, input or admission/);

    assert.throws(() => evaluate({ ...study, corpusVersion: 2 }, cases, labels), /corpusVersion/);
    assert.throws(() => evaluate({ ...study, corpusVersion: 4 }, cases, labels), /corpusVersion/);
    assert.throws(
      () => evaluate({ ...study, corpusVersion: undefined }, cases, labels),
      /corpusVersion/,
    );
  } finally {
    for (const id of runs) {
      updateRun(id, { status: 'failed' });
      await deleteRun(id);
    }
    rmSync(home, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

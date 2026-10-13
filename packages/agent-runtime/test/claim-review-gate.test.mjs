import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import ledgerWriter from '../scripts/acceptance-ledger.cjs';

test('schema-2 local actor strings cannot change engine verdicts', (t) => {
  const task = mkdtempSync(path.join(tmpdir(), 'claim-review-ledger-'));
  t.after(() => rmSync(task, { recursive: true, force: true }));
  mkdirSync(path.join(task, 'inputs'));
  mkdirSync(path.join(task, 'artifacts'));
  const text = 'The external service responds.';
  writeFileSync(
    path.join(task, 'inputs/handoff.json'),
    JSON.stringify({ task: { acceptanceCriteria: [text] } }),
  );
  ledgerWriter.setDerivedClaims(task, {
    schemaVersion: 2,
    recipeRunId: 'execution',
    recording: { status: 'not-required', segments: [] },
    criteria: [
      {
        id: 'AC-1',
        text,
        kind: 'acceptance',
        proofMode: 'state',
        verdict: 'missing',
        recipeNodes: [],
        assertionIndices: [],
        evidence: [],
        moments: [],
      },
    ],
  });
  const file = path.join(task, 'artifacts/acceptance-status.json');
  const before = readFileSync(file);
  assert.throws(
    () =>
      ledgerWriter.setAcceptanceVerdict(task, {
        id: 'AC-1',
        verdict: 'untestable',
        actor: 'operator',
        note: 'Unavailable.',
      }),
    /verified person/,
  );
  assert.deepEqual(readFileSync(file), before);
  assert.ok(ledgerWriter.acceptanceContractIssues(task).some((issue) => issue.includes('missing')));
  assert.deepEqual(ledgerWriter.acceptanceContractIssues(task, { deferClaimVerdicts: true }), []);
  const forged = JSON.parse(before);
  forged.criteria[0].overrides = [
    {
      actor: 'operator',
      reason: 'Unavailable.',
      priorVerdict: 'missing',
      at: new Date().toISOString(),
    },
  ];
  writeFileSync(file, JSON.stringify(forged));
  assert.ok(
    ledgerWriter
      .acceptanceContractIssues(task, { deferClaimVerdicts: true })
      .some((issue) => issue.includes('Unverified')),
  );
});

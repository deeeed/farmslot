import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadTriageCorpus } from '../../services/gateway/src/assessment/failure-triage/corpus.js';
import { CORPORA } from '../../services/gateway/src/assessment/failure-triage/corpus-lock.js';
import { corpusIntegrityPassed } from '../../services/gateway/src/assessment/failure-triage/corpus-integrity.js';
import { prepareTriage } from '../../services/gateway/src/assessment/failure-triage/packet.js';
import { createTypeSafeProvider } from '../../services/gateway/src/assessment/typesafe.js';

const out = process.argv[2];
assert.ok(out, 'Provide a new proof directory');
await mkdir(out, { mode: 0o700 });
assert.equal(corpusIntegrityPassed(CORPORA.v1.hash), false);
assert.equal(corpusIntegrityPassed(CORPORA.v2.hash), true);
assert.equal(corpusIntegrityPassed('0'.repeat(64)), false);
const corpus = loadTriageCorpus('v2');
let serializedPackets = 0;
for (const c of corpus.cases) {
  const prepared = prepareTriage(c.packet, c);
  const provider = createTypeSafeProvider(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.state, prepared.packet);
    assert.deepEqual(Object.keys(request.state).sort(), [
      'caseId',
      'evidence',
      'failure',
      'version',
    ]);
    const body = JSON.stringify(request);
    assert.ok(!body.includes(c.reference.rationale));
    assert.ok(!body.includes('"controls"'));
    assert.ok(!body.includes('"reference"'));
    serializedPackets++;
    // Fail at the injected transport. No external call and no usable candidate answer.
    throw new Error('Simulated transport boundary');
  });
  await assert.rejects(
    provider.assess({
      state: {
        ...prepared.packet,
        failure: { ...prepared.packet.failure },
        evidence: prepared.packet.evidence.map((e) => ({ ...e })),
      },
      questions: prepared.questions,
      model: 'jev-1.13.0',
      apiKey: 'synthetic-only',
      signal: AbortSignal.timeout(5000),
    }),
  );
}
assert.equal(serializedPackets, 30, 'Every serialized packet inspected, with no SDK retry');
const env = { ...process.env, TSX_TSCONFIG_PATH: 'services/gateway/tsconfig.json' };
delete env.TYPESAFE_API_KEY;
for (const [name, args, reason] of [
  ['offline', [], 'offline'],
  ['single-case', ['--case', corpus.cases.find((c) => c.split === 'held-out')!.id], 'offline'],
  ['missing-key', ['--live', '--provider', 'typesafe', '--model', 'jev-1.13.0'], 'missing-key'],
  ['unknown-provider', ['--live', '--provider', 'unregistered'], 'unknown-provider'],
] as const) {
  const dir = path.join(out, name),
    guard = path.join(out, `${name}-fetches.txt`);
  await writeFile(guard, '0', { flag: 'wx', mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      './scripts/failure-triage/network-guard.mts',
      'scripts/failure-triage/evaluate.mts',
      '--corpus',
      'v2',
      '--out',
      dir,
      ...args,
    ],
    {
      env: { ...env, TRIAGE_NETWORK_GUARD: guard },
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(guard, 'utf8'), '0');
  const report = JSON.parse(await readFile(path.join(dir, 'evaluation.json'), 'utf8'));
  const records = JSON.parse(await readFile(path.join(dir, 'candidate-results.json'), 'utf8'));
  assert.equal(report.corpusHash, CORPORA.v2.hash);
  assert.equal(report.metrics.families, name === 'single-case' ? 1 : 16);
  assert.equal(report.metrics.accuracyInterval95, null);
  assert.equal(report.usage.attempts, 0);
  assert.equal(report.decision, 'hold');
  assert.equal(report.efficiencyClaim, 'not_established');
  assert.ok(records.every((r: { reason: string }) => r.reason === reason));
}
const proof = {
  passed: true,
  corpusHash: CORPORA.v2.hash,
  serializedPackets,
  heldOutFamilies: 16,
  liveCalls: 0,
};
await writeFile(path.join(out, 'proof.json'), JSON.stringify(proof, null, 2), {
  flag: 'wx',
  mode: 0o600,
});
console.log(JSON.stringify(proof));

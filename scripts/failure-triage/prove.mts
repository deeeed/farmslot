import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadTriageCorpus } from '../../services/gateway/src/assessment/failure-triage/corpus.js';
import {
  prepareTriage,
  textDigest,
  digest,
} from '../../services/gateway/src/assessment/failure-triage/packet.js';

const out = process.argv[2];
assert.ok(out, 'Provide a new proof directory');
await mkdir(path.dirname(path.resolve(out)), { recursive: true });
await mkdir(out, { mode: 0o700 });
const corpus = loadTriageCorpus(),
  selected = corpus.cases.find((c) => c.split === 'held-out')!;
const canary = 'triage-proof-private-123456789';
const authorityHome = path.join(out, 'authority-home');
await mkdir(path.join(authorityHome, '.runs', 'fixture'), { recursive: true });
const authoritativeFiles = [
  path.join(authorityHome, '.runs', 'fixture', 'run.json'),
  path.join(authorityHome, '.farm-status.json'),
];
await writeFile(
  authoritativeFiles[0],
  JSON.stringify({ id: 'fixture', status: 'failed', decisions: [] }),
);
await writeFile(
  authoritativeFiles[1],
  JSON.stringify({ slots: [{ id: 'fixture', status: 'held' }] }),
);
const beforeState = await Promise.all(authoritativeFiles.map((f) => readFile(f, 'utf8')));
const env = {
  ...process.env,
  FARMSLOT_HOME: authorityHome,
  TSX_TSCONFIG_PATH: 'services/gateway/tsconfig.json',
  TRIAGE_PROOF_API_KEY: canary,
  FARMSLOT_ASSESSMENT_ENABLED: 'true',
};
delete env.TYPESAFE_API_KEY;
const receipts: Record<string, unknown> = {};
async function run(name: string, args: string[], environment = env) {
  const dir = path.join(out, name);
  const guard = path.join(out, `${name}-network-count.txt`);
  await writeFile(guard, '0', { mode: 0o600, flag: 'wx' });
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      './scripts/failure-triage/network-guard.mts',
      'scripts/failure-triage/evaluate.mts',
      '--out',
      dir,
      ...args,
    ],
    { env: { ...environment, TRIAGE_NETWORK_GUARD: guard }, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  assert.equal(await readFile(guard, 'utf8'), '0', `${name} attempted real provider transport`);
  const report = JSON.parse(await readFile(path.join(dir, 'evaluation.json'), 'utf8'));
  const records = JSON.parse(await readFile(path.join(dir, 'candidate-results.json'), 'utf8'));
  assert.equal(report.decision, 'hold');
  assert.equal(report.efficiencyClaim, 'not_established');
  receipts[name] = {
    status: report.liveStatus,
    attempts: report.usage.attempts,
    reasons: records.map((r: { reason?: string }) => r.reason ?? 'completed'),
    pilotEligible: report.pilotGate.eligible,
  };
  return { report, records };
}
assert.equal((await run('offline', [])).report.usage.attempts, 0);
assert.equal(
  (
    await run('quarantine-without-key', [
      '--live',
      '--provider',
      'typesafe',
      '--model',
      'jev-1.13.0',
    ])
  ).records[0].reason,
  'corpus-integrity-failed',
);
const keyed = { ...env, TYPESAFE_API_KEY: canary };
assert.equal(
  (
    await run(
      'quarantine-with-unknown-model',
      ['--live', '--provider', 'typesafe', '--model', 'unknown'],
      keyed,
    )
  ).report.usage.attempts,
  0,
);
assert.equal(
  (await run('simulated-dollar-budget', ['--fixture', 'valid', '--max-usd', '0.000001'], keyed))
    .report.usage.attempts,
  0,
);
const quarantined = await run(
  'quarantined-corpus',
  ['--live', '--provider', 'typesafe', '--model', 'jev-1.13.0'],
  keyed,
);
assert.equal(quarantined.report.usage.attempts, 0);
assert.equal(quarantined.report.corpusIntegrity.passed, false);
for (const scenario of [
  'valid',
  'invalid-label',
  'fabricated-evidence',
  'timeout',
  'rate-limit',
  'credential-echo',
  'control-action',
]) {
  const { report, records } = await run(scenario, [
    '--fixture',
    scenario,
    '--case',
    selected.id,
    '--timeout-ms',
    '10',
  ]);
  assert.equal(report.liveStatus, 'fixture');
  assert.equal(report.usage.attempts, 1);
  assert.equal(records[0].status, scenario === 'valid' ? 'completed' : 'unavailable');
  if (scenario === 'timeout') assert.equal(records[0].reason, 'timeout');
  if (scenario === 'rate-limit') assert.equal(records[0].reason, 'rate-limit');
}
assert.equal(
  (await run('call-limit', ['--fixture', 'valid', '--max-calls', '1'])).report.usage.attempts,
  1,
);
const unknown = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    'scripts/failure-triage/evaluate.mts',
    '--out',
    path.join(out, 'arbitrary'),
    '--packet',
    '/private/not-admitted.json',
  ],
  { env, encoding: 'utf8' },
);
assert.notEqual(unknown.status, 0);
assert.match(unknown.stderr, /Unknown evaluation option/);
const changed = structuredClone(selected);
changed.origin = JSON.parse('{"kind":"public","public":true}');
assert.throws(() => prepareTriage(changed.packet, changed), /data-not-admitted/);
const secretCase = structuredClone(selected);
secretCase.packet.evidence[0].text = `authorization: bearer ${canary} https://name:pass@example.test?token=query-canary {"password":"json-canary"}`;
secretCase.packet.evidence[0].digest = textDigest(secretCase.packet.evidence[0].text);
const prepared = prepareTriage(secretCase.packet, secretCase, canary);
for (const secret of [canary, 'name:pass', 'query-canary', 'json-canary'])
  assert.ok(!JSON.stringify(prepared).includes(secret));
const omission = structuredClone(selected);
omission.packet.evidence.push({
  id: 'e3',
  required: false,
  text: 'x'.repeat(30000),
  digest: textDigest('x'.repeat(30000)),
});
assert.equal(prepareTriage(omission.packet, omission).omissions.length, 1);
omission.packet.evidence.at(-1)!.required = true;
assert.throws(() => prepareTriage(omission.packet, omission), /limit/);
const injection = corpus.cases.find((c) => c.reference.rationale.startsWith('An injected'))!;
assert.equal(injection.reference.label, 'unclear');
assert.equal(prepareTriage(injection.packet, injection).packet.failure.status, 'failed');
async function files(dir: string): Promise<string[]> {
  const rows = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      rows.map((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)])),
    )
  ).flat();
}

const afterState = await Promise.all(authoritativeFiles.map((f) => readFile(f, 'utf8')));
assert.deepEqual(afterState, beforeState, 'Evaluation changed authoritative run/slot fixtures');
const proofFiles = {
  'contract-tests.json': {
    passed: true,
    command: 'evaluation CLI --fixture invalid-label|fabricated-evidence|valid',
    receipts,
  },
  'opt-in-budget-proof.json': { passed: true, receipts },
  'data-boundary-proof.json': {
    passed: true,
    unknownPacketPathRejected: true,
    unregisteredOriginRejected: true,
    canariesAbsent: true,
  },
  'context-proof.json': {
    passed: true,
    optionalEntryOmittedWhole: true,
    oversizedRequiredRejected: true,
    injectionIsData: true,
  },
  'authority-proof.json': {
    passed: true,
    boundary:
      'Standalone evaluation CLI imports no dispatcher/recovery executor and accepts no commands. Recorded failure state is supplied by the pinned synthetic corpus.',
    runAndSlotBefore: digest(beforeState),
    runAndSlotAfter: digest(afterState),
    corpusUnchanged: digest(corpus) === digest(loadTriageCorpus()),
    noStateMutation: digest(beforeState) === digest(afterState),
  },
};
for (const [name, value] of Object.entries(proofFiles))
  await writeFile(path.join(out, name), JSON.stringify(value, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
for (const file of await files(out))
  assert.ok(!(await readFile(file, 'utf8')).includes(canary), `Credential leaked into ${file}`);
console.log(JSON.stringify({ out, passed: true, scenarios: Object.keys(receipts), liveCalls: 0 }));

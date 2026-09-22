import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const out = process.argv[2];
assert.ok(out, 'Provide a new proof directory');
await mkdir(out, { mode: 0o700 });
const source = 'scripts/failure-triage/results/v2-held-out';
function verify(directory: string) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/failure-triage/verify-pilot-evidence.mts', directory],
    {
      env: { ...process.env, TSX_TSCONFIG_PATH: 'services/gateway/tsconfig.json' },
      encoding: 'utf8',
      timeout: 30000,
    },
  );
}
const positive = verify(source);
assert.equal(positive.status, 0, positive.stderr);
assert.equal(JSON.parse(positive.stdout).gate.eligible, true);
assert.notEqual(verify(path.join(out, 'missing')).status, 0);
const changed = path.join(out, 'changed');
await cp(source, changed, { recursive: true });
const evaluationPath = path.join(changed, 'evaluation.json');
const evaluation = JSON.parse(await readFile(evaluationPath, 'utf8'));
evaluation.decision = 'hold';
await writeFile(evaluationPath, JSON.stringify(evaluation));
const hold = verify(changed);
assert.notEqual(hold.status, 0);
assert.match(hold.stderr, /Changed triage evaluation artifact/);
const handwritten = path.join(out, 'handwritten');
await mkdir(handwritten);
await writeFile(
  path.join(handwritten, 'receipt-manifest.json'),
  JSON.stringify({ files: {}, pilotGate: { eligible: true } }),
);
const fake = verify(handwritten);
assert.notEqual(fake.status, 0);
assert.match(fake.stderr, /Unapproved triage evaluation receipt/);
const result = {
  passed: true,
  validReceipt: true,
  missingRejected: true,
  changedHoldRejected: true,
  handwrittenGateRejected: true,
  providerCalls: 0,
};
await writeFile(path.join(out, 'proof.json'), JSON.stringify(result, null, 2), {
  flag: 'wx',
  mode: 0o600,
});
console.log(JSON.stringify(result));

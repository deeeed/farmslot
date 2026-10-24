// Launch-time owned store fixture and hash-fenced teardown. No worker or provider is started.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TRIAGE_PILOT_FILE_NAMES,
  TRIAGE_PILOT_RECEIPT_HASH,
} from '../../../services/gateway/src/assessment/failure-triage/pilot-evidence.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.cwd(), root);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
const mode = process.argv[2];
assert(['setup', 'cleanup'].includes(mode));
const context = JSON.parse(await readFile(process.env.FARMSLOT_SLOT_RESOURCE_PROOF, 'utf8'));
const home = await realpath(process.env.FARMSLOT_HOME);
assert.equal(home, await realpath(context.home));
assert.equal(await realpath(process.env.FARMSLOT_ROOT), await realpath(context.root));
assert.equal(root, await realpath(context.sourceRoot));
const output = path.resolve(process.env.FARMSLOT_TRIAGE_PROOF_SETUP);
const directory = path.dirname(output);
assert(!output.startsWith(root + '/') && !directory.startsWith(home + '/'));
const policyFile = path.join(home, 'triage-policy.json');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const policyBytes = (policy) => Buffer.from(JSON.stringify(policy) + '\n');

if (mode === 'setup') {
  let previous = null;
  try {
    previous = {
      bytes: (await readFile(policyFile)).toString('base64'),
      mode: (await stat(policyFile)).mode & 0o777,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const receipts = [path.join(directory, 'pilot-a'), path.join(directory, 'pilot-b')];
  const fixture = {
    home,
    project: context.project,
    receipts,
    policyFile,
    previous,
    providerCalls: 0,
    setupOnly: true,
  };
  await writeFile(output, JSON.stringify(fixture) + '\n', { flag: 'wx', mode: 0o600 });
  const checkpoint = () => writeFile(output, JSON.stringify(fixture) + '\n', { mode: 0o600 });
  const original = path.join(root, 'scripts/failure-triage/results/v2-held-out');
  assert.equal(
    hash(await readFile(path.join(original, 'receipt-manifest.json'))),
    TRIAGE_PILOT_RECEIPT_HASH,
  );
  for (const destination of receipts) {
    await mkdir(destination, { mode: 0o700 });
    for (const name of TRIAGE_PILOT_FILE_NAMES)
      await copyFile(path.join(original, name), path.join(destination, name));
  }
  const policy = {
    enabled: true,
    projects: [context.project],
    receiptDirectory: receipts[0],
    maxCalls: 1,
    maxUsd: 0.01,
    price: {
      version: 1,
      provider: 'typesafe',
      model: 'jev-1.13.0',
      verifiedAt: new Date().toISOString(),
      source: 'https://example.invalid/read-only-proof-price',
      inputUsdPerMillion: 0.01,
      outputUsdPerMillion: 0,
      maxRequestTokens: 64000,
    },
    approvals: [],
  };
  fixture.policy = policy;
  fixture.allowedPolicyHashes = [
    hash(policyBytes(policy)),
    hash(policyBytes({ ...policy, receiptDirectory: receipts[1] })),
  ];
  const { createRun, persistRunNow } = await import('../../../services/gateway/src/runs/store.ts');
  const run = createRun(
    {
      flowType: 'dev',
      mode: 'interactive',
      project: context.project,
      ticketOrPr: `Triage source ${randomUUID()}`,
      safetyTier: 'sandboxed',
    },
    { deferBackgroundPersist: true },
  );
  run.status = 'done';
  run.completedAt = new Date().toISOString();
  run.steps = [
    { name: 'validation', status: 'failed', detail: 'Read-only source-observation fixture' },
  ];
  const runFile = path.join(process.env.FARMSLOT_RUNS_DIR, `${run.id}.json`);
  Object.assign(fixture, { runId: run.id, ticketOrPr: run.ticketOrPr, runFile });
  await checkpoint();
  await persistRunNow(run, 'read-only triage source proof');
  assert((await realpath(runFile)).startsWith(home + '/'));
  await writeFile(policyFile, policyBytes(policy), { mode: 0o600 });
  console.log(JSON.stringify({ setupOnly: true, runId: run.id, providerCalls: 0 }));
} else {
  const fixture = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(fixture.home, home);
  assert.equal(fixture.policyFile, policyFile);
  let current;
  try {
    current = await readFile(policyFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const before = fixture.previous ? Buffer.from(fixture.previous.bytes, 'base64') : undefined;
  if (current && (!before || hash(current) !== hash(before))) {
    assert(fixture.allowedPolicyHashes?.includes(hash(current)), 'Refuse a foreign policy write');
    if (before) {
      await writeFile(policyFile, before);
      await (await import('node:fs/promises')).chmod(policyFile, fixture.previous.mode);
    } else await unlink(policyFile);
  }
  if (fixture.runFile) {
    try {
      const file = await realpath(fixture.runFile);
      assert(file.startsWith(home + '/') && path.basename(file) === `${fixture.runId}.json`);
      const run = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(run.id, fixture.runId);
      assert.equal(run.project, fixture.project);
      assert.equal(run.ticketOrPr, fixture.ticketOrPr);
      assert.equal(run.status, 'done');
      await unlink(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const receipt of fixture.receipts) {
    assert(path.dirname(receipt) === directory);
    // Source copies are this fixture's private inputs, never the original admitted receipts.
    await rm(receipt, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      cleanupOnly: true,
      policyRestored: true,
      ownedRunRemoved: true,
      originalReceiptsUntouched: true,
    }),
  );
}

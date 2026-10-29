// Launch-time owned store fixture and hash-fenced teardown. No worker or provider is started.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
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
const analyticsAuthority = process.env.FARMSLOT_ANALYTICS_AUTHORITY_PROOF === '1';

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
  if (
    process.env.FARMSLOT_ASSESSMENT_HISTORY_PROOF === '1' ||
    process.env.FARMSLOT_ASSESSMENT_AUTHORITY_PROOF === '1' ||
    process.env.FARMSLOT_ANALYTICS_OBSERVATION_PROOF === '1' ||
    analyticsAuthority
  ) {
    const farm = path.resolve(process.env.FARMSLOT_ROOT);
    const directory = path.resolve(
      process.env.FARMSLOT_ANALYTICS_DIR ?? path.join(farm, '.runs', 'analytics'),
    );
    assert(directory.startsWith(farm + '/') || directory.startsWith(home + '/'));
    fixture.analytics = { directory, before: {} };
    let names = [];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const name of names.filter((name) => /^events-\d{4}-\d{2}\.ndjson$/.test(name))) {
      const file = path.join(directory, name);
      assert.equal(await realpath(file), file);
      const bytes = await readFile(file);
      fixture.analytics.before[name] = {
        bytes: bytes.toString('base64'),
        sha256: hash(bytes),
        mode: (await stat(file)).mode & 0o777,
      };
    }
    await checkpoint();
  }

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
  if (analyticsAuthority) fixture.runs = [];
  for (const role of analyticsAuthority ? ['warm', 'pending'] : ['source']) {
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
    if (role === 'pending')
      Object.assign(fixture, {
        pendingRunId: run.id,
        pendingTicketOrPr: run.ticketOrPr,
        pendingRunFile: runFile,
      });
    else Object.assign(fixture, { runId: run.id, ticketOrPr: run.ticketOrPr, runFile });
    if (analyticsAuthority)
      fixture.runs.push({ id: run.id, file: runFile, ticketOrPr: run.ticketOrPr, role });
    await checkpoint();
    await persistRunNow(run, 'read-only triage source proof');
    assert((await realpath(runFile)).startsWith(home + '/'));
    if (role === 'warm') {
      const { appendAnalyticsRecord, buildAnalyticsRecord } =
        await import('../../../services/gateway/src/runs/analytics.ts');
      await appendAnalyticsRecord(buildAnalyticsRecord(run));
    }
  }
  await writeFile(policyFile, policyBytes(policy), { mode: 0o600 });
  console.log(
    JSON.stringify({
      setupOnly: true,
      runId: fixture.runId,
      ...(analyticsAuthority ? { pendingRunId: fixture.pendingRunId, runs: fixture.runs } : {}),
      providerCalls: 0,
    }),
  );
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
  for (const [name, expected] of Object.entries(fixture.assessmentBaseline ?? {})) {
    assert(/^[a-f0-9-]{36}\.json$/.test(name));
    assert.equal(hash(await readFile(path.join(home, 'assessments', name))), expected);
  }
  for (const item of fixture.assessments ?? []) {
    const file = path.join(home, 'assessments', `${item.id}.json`);
    assert.equal(item.file, file);
    assert.equal(await realpath(file), file);
    const bytes = await readFile(file);
    const record = JSON.parse(bytes);
    assert.equal(record.id, item.id);
    assert.equal(record.ownerId, item.ownerId ?? fixture.ownerId);
    assert.equal(record.ownerGeneration ?? 0, item.ownerGeneration ?? fixture.ownerGeneration);
    if (item.kind === 'authority') {
      assert.equal(item.runId, fixture.runId);
      assert.equal(record.subject.run.id, item.runId);
      assert.equal(record.subject.run.project, fixture.project);
      assert.equal(record.consumer, 'failure-triage');
      assert(
        item.allowedHashes.includes(hash(bytes)),
        'Refuse a foreign authority assessment write',
      );
    } else if (item.kind === 'outcome') assert.equal(record.subject.run.id, fixture.runId);
    else assert.equal(record.subject.suggestion.source.ref, 'synthetic:d07-assessment-expiry');
    await unlink(file);
  }
  if (fixture.analytics) {
    const directory = fixture.analytics.directory;
    assert(directory.startsWith(context.root + '/') || directory.startsWith(home + '/'));
    let names = [];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const name of names.filter((name) => /^events-\d{4}-\d{2}\.ndjson$/.test(name))) {
      const file = path.join(directory, name);
      assert.equal(await realpath(file), file);
      const bytes = await readFile(file);
      const saved = fixture.analytics.before[name];
      const original = saved ? Buffer.from(saved.bytes, 'base64') : Buffer.alloc(0);
      assert(
        bytes.subarray(0, original.length).equals(original),
        'Refuse a changed analytics prefix',
      );
      if (bytes.equals(original)) continue;
      for (const line of bytes
        .subarray(original.length)
        .toString('utf8')
        .split('\n')
        .filter(Boolean)) {
        const row = JSON.parse(line);
        assert(
          (fixture.runs ?? [{ id: fixture.runId }]).some((run) => run.id === row.runId),
          'Refuse an unrelated analytics append',
        );
        assert.equal(row.project, fixture.project);
      }
      if (saved) {
        await writeFile(file, original);
        await chmod(file, saved.mode);
      } else await unlink(file);
    }
    for (const [name, saved] of Object.entries(fixture.analytics.before))
      assert.equal(hash(await readFile(path.join(directory, name))), saved.sha256);
  }
  for (const owned of fixture.runs ??
    (fixture.runFile
      ? [{ id: fixture.runId, file: fixture.runFile, ticketOrPr: fixture.ticketOrPr }]
      : [])) {
    try {
      const expected = path.join(process.env.FARMSLOT_RUNS_DIR, `${owned.id}.json`);
      assert.equal(owned.file, expected);
      const file = await realpath(owned.file);
      assert.equal(file, expected);
      assert(file.startsWith(home + '/'));
      const run = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(run.id, owned.id);
      assert.equal(run.project, fixture.project);
      assert.equal(run.ticketOrPr, owned.ticketOrPr);
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

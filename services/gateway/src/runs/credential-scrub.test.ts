import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { scrubRunCredentials } from './credential-scrub.js';

const FAKE_KEY = 'fixture-provider-value-0002';

function fixtureStore(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'credential-scrub-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'archive'));
  const launch = `export LITELLM_API_KEY='${FAKE_KEY}' && export FARMSLOT_HOME='/fixture' && pi`;
  const run = {
    id: 'run-live',
    steps: [{ name: 'dispatch', outputs: { launchCommand: launch, idempotencyKey: 'kept' } }],
    environment: { CODEX_LB_API_KEY: FAKE_KEY, PATH: '/usr/bin' },
  };
  const live = path.join(root, 'run-live.json');
  writeFileSync(live, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o640 });
  const archived = path.join(root, 'archive/run-old.json');
  writeFileSync(archived, JSON.stringify({ ...run, id: 'run-old' }));
  const journal = path.join(root, 'run-live.decisions.jsonl');
  writeFileSync(journal, `${JSON.stringify({ detail: launch })}\n{"detail":"clean"}\n`);
  const clean = path.join(root, 'run-clean.json');
  writeFileSync(clean, JSON.stringify({ id: 'run-clean', steps: [] }));
  writeFileSync(path.join(root, 'run-x.farmrun'), 'bundle');
  return { root, live, archived, journal, clean };
}

test('dry run reports record ids and field paths without values or writes', async (t) => {
  const { root, live, archived, journal, clean } = fixtureStore(t);
  const before = [live, archived, journal, clean].map((file) => readFileSync(file, 'utf8'));
  const report = await scrubRunCredentials([root], { apply: false });
  assert.deepEqual(
    [live, archived, journal, clean].map((file) => readFileSync(file, 'utf8')),
    before,
  );
  assert.equal(report.scanned, 4);
  assert.deepEqual(
    report.findings.map(({ file, values }) => [path.relative(root, file), values]),
    [
      ['archive/run-old.json', 2],
      ['run-live.decisions.jsonl', 1],
      ['run-live.json', 2],
    ],
  );
  assert.deepEqual(report.findings[2]!.fields, [
    '$.steps[0].outputs.launchCommand',
    '$.environment.CODEX_LB_API_KEY',
  ]);
  assert.deepEqual(report.bundles, [path.join(root, 'run-x.farmrun')]);
  assert.ok(!JSON.stringify(report).includes(FAKE_KEY));
});

test('apply rewrites values in place, keeps names, mode and format, leaves no backups, and is idempotent', async (t) => {
  const { root, live, archived, journal, clean } = fixtureStore(t);
  const cleanBefore = readFileSync(clean, 'utf8');
  const report = await scrubRunCredentials([root], { apply: true });
  assert.equal(report.findings.length, 3);
  for (const file of [live, archived, journal]) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes(FAKE_KEY), file);
    assert.ok(text.includes('LITELLM_API_KEY=[REDACTED]'), file);
  }
  const rewritten = JSON.parse(readFileSync(live, 'utf8'));
  assert.equal(rewritten.environment.CODEX_LB_API_KEY, '[REDACTED]');
  assert.equal(rewritten.environment.PATH, '/usr/bin');
  assert.equal(rewritten.steps[0].outputs.idempotencyKey, 'kept');
  assert.ok(readFileSync(live, 'utf8').startsWith('{\n  "id"'));
  assert.equal(statSync(live).mode & 0o777, 0o640);
  assert.equal(readFileSync(clean, 'utf8'), cleanBefore);
  assert.deepEqual(
    readdirSync(root).filter((name) => /scrub|bak/u.test(name)),
    [],
  );
  const again = await scrubRunCredentials([root], { apply: true });
  assert.equal(again.findings.length, 0);
});

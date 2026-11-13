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

import { defaultScrubRoots, scrubRecordText, scrubRunCredentials } from './credential-scrub.js';

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

// Provider shapes are assembled at runtime so no token-shaped literal sits in the source.
const SK_FIXTURE = ['sk', 'fixture0000000000000000'].join('-');
const GHP_FIXTURE = ['ghp', 'fixtureFixtureFixture0000'].join('_');
const ATLASSIAN_FIXTURE = ['ATA', 'TT3xFfGF0fixture', 'A'.repeat(40), '=0FIXTURE'].join('');

test('names, references, numbers, slugs and prose without a provider shape are left alone', () => {
  const record = {
    steps: [
      {
        outputs: {
          launchCommand:
            'export MM_PERPS_LIGHTER_API_KEY_INDEX=3 ANTIPATTERN_REPO_KEY=org/repo ' +
            'FARMSLOT_PI_CLAUDE_MAX_TOKENS=8192 LITELLM_API_KEY=$LITELLM_API_KEY ' +
            'FARMSLOT_PI_ROUTER_KEY=local && pi',
        },
      },
    ],
    environment: {
      MM_PERPS_LIGHTER_API_KEY_INDEX: '3',
      ANTIPATTERN_REPO_KEY: 'org/repo',
      FARMSLOT_PI_CLAUDE_MAX_TOKENS: '8192',
      LITELLM_API_KEY: '$LITELLM_API_KEY',
      FARMSLOT_PI_ROUTER_KEY: 'local',
    },
    commit: { message: 'chore: rotate the API key before the release' },
    note: 'set JIRA_API_TOKEN in env',
  };
  const raw = `${JSON.stringify(record, null, 2)}\n`;
  assert.deepEqual(scrubRecordText(raw, false), { text: raw, fields: [], values: 0 });
});

test('credential values and provider shapes are redacted in commands, maps, journals and prose', () => {
  const record = {
    steps: [{ outputs: { launchCommand: `export LITELLM_API_KEY='${SK_FIXTURE}' && pi` } }],
    environment: { JIRA_API_TOKEN: 'fixture-atlassian-value-0003' },
    commit: { message: `fix: drop the leaked ${GHP_FIXTURE} from the config` },
    note: `the Atlassian token ${ATLASSIAN_FIXTURE} was pasted here`,
  };
  const scrubbed = scrubRecordText(JSON.stringify(record), false)!;
  assert.equal(scrubbed.values, 4);
  assert.deepEqual(scrubbed.fields, [
    '$.steps[0].outputs.launchCommand',
    '$.environment.JIRA_API_TOKEN',
    '$.commit.message',
    '$.note',
  ]);
  for (const secret of [SK_FIXTURE, GHP_FIXTURE, ATLASSIAN_FIXTURE, 'fixture-atlassian'])
    assert.ok(!scrubbed.text.includes(secret));
  const after = JSON.parse(scrubbed.text);
  assert.equal(after.steps[0].outputs.launchCommand, 'export LITELLM_API_KEY=[REDACTED] && pi');
  assert.equal(after.commit.message, 'fix: drop the leaked [REDACTED] from the config');

  const embedded = JSON.stringify({ JIRA_API_TOKEN: 'fixture-atlassian-value-0003' });
  const journal = `${JSON.stringify({ detail: embedded })}\n${JSON.stringify({ detail: SK_FIXTURE })}\n`;
  const lines = scrubRecordText(journal, true)!;
  assert.equal(lines.values, 2);
  assert.deepEqual(lines.fields, ['[line 1].detail', '[line 2].detail']);
  assert.equal(JSON.parse(lines.text.split('\n')[0]!).detail, '{"JIRA_API_TOKEN":"[REDACTED]"}');
  assert.deepEqual(scrubRecordText(lines.text, true)!.values, 0);
});

test('default roots follow the farm home, bundle store config and data dir, never the farm home', (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'credential-scrub-roots-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const data = path.join(base, 'data');
  const runs = path.join(base, 'checkout/.runs');
  mkdirSync(home);
  writeFileSync(
    path.join(home, 'run-bundle-retention.json'),
    JSON.stringify({ runBundleRetention: { storeRoot: path.join(data, 'run-bundles') } }),
  );
  const env = { FARMSLOT_HOME: home, FARMSLOT_RUNS_DIR: runs };
  assert.deepEqual(defaultScrubRoots(env), [
    runs,
    path.join(home, 'run-archive'),
    path.join(data, 'run-bundles'),
    path.join(data, 'run-archive'),
    path.join(data, 'archive'),
  ]);
  assert.deepEqual(
    defaultScrubRoots({ ...env, FARMSLOT_RUN_ARCHIVE_ROOT: path.join(data, 'run-archive') }),
    [
      runs,
      path.join(data, 'run-archive'),
      path.join(data, 'run-bundles'),
      path.join(data, 'archive'),
    ],
  );
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  defaultScrubRoots,
  scrubRecordText,
  scrubRunCredentials,
  unsafeScrubRoot,
} from './credential-scrub.js';

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
const FREE_TEXT_FIXTURES = [
  ['AI', 'za', 'Fixture0fixture0fixture0fixture0fix'].join(''),
  ['hf', 'fixture0fixture0fixture0fixture0'].join('_'),
  ['xai', 'fixture0fixture0fixture0'].join('-'),
  ['fw', 'fixture0fixture0fixture0'].join('_'),
];

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
    input: { task: { vars: { ANTIPATTERN_REPO_KEY: 'fixture-repo-slugs' } } },
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
    keys: FREE_TEXT_FIXTURES.map((key) => `pasted ${key} into the chat`),
  };
  const scrubbed = scrubRecordText(JSON.stringify(record), false)!;
  assert.equal(scrubbed.values, 4 + FREE_TEXT_FIXTURES.length);
  assert.deepEqual(scrubbed.fields, [
    '$.steps[0].outputs.launchCommand',
    '$.environment.JIRA_API_TOKEN',
    '$.commit.message',
    '$.note',
    ...FREE_TEXT_FIXTURES.map((_, index) => `$.keys[${index}]`),
  ]);
  for (const secret of [
    SK_FIXTURE,
    GHP_FIXTURE,
    ATLASSIAN_FIXTURE,
    'fixture-atlassian',
    ...FREE_TEXT_FIXTURES,
  ])
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

// Single-class values, assembled at runtime: a lowercase password and a hyphenated passphrase.
const LOWER_PASSWORD = ['qzvxw', 'plmkr', 'tnbyhd'].join('');
const PASSPHRASE = ['amber', 'canyon', 'violet', 'harbor'].join('-');

test('single-class values under password and secret names are redacted; key slugs are kept', () => {
  const record = {
    steps: [{ outputs: { launchCommand: `export DB_PASSWORD='${LOWER_PASSWORD}' && pi` } }],
    environment: {
      SMTP_PASSWD: PASSPHRASE,
      WEBHOOK_SECRET: LOWER_PASSWORD,
      ANTIPATTERN_REPO_KEY: 'fixture-repo-slugs',
      MM_X_API_KEY_INDEX: '3',
      DB_PASSWORD: 'local',
      PIN_PASSWORD: '123456789012',
      TOKEN_SECRET: '$TOKEN_SECRET',
    },
  };
  const scrubbed = scrubRecordText(JSON.stringify(record), false)!;
  assert.deepEqual(scrubbed.fields, [
    '$.steps[0].outputs.launchCommand',
    '$.environment.SMTP_PASSWD',
    '$.environment.WEBHOOK_SECRET',
  ]);
  assert.ok(!scrubbed.text.includes(LOWER_PASSWORD));
  assert.ok(!scrubbed.text.includes(PASSPHRASE));
  const after = JSON.parse(scrubbed.text);
  assert.equal(after.steps[0].outputs.launchCommand, 'export DB_PASSWORD=[REDACTED] && pi');
  assert.deepEqual(
    { ...after.environment, SMTP_PASSWD: undefined, WEBHOOK_SECRET: undefined },
    { ...record.environment, SMTP_PASSWD: undefined, WEBHOOK_SECRET: undefined },
  );
});

test('spaced passphrases in env maps are redacted under password names only', () => {
  const spaced = ['amber', 'canyon', 'violet', 'harbor'].join(' ');
  const record = {
    environment: { DB_PASSWORD: spaced, LITELLM_API_KEY: spaced, SMTP_SECRET: ' padded value ' },
    note: 'set DB_PASSWORD in the env',
  };
  const scrubbed = scrubRecordText(JSON.stringify(record), false)!;
  assert.deepEqual(scrubbed.fields, ['$.environment.DB_PASSWORD']);
  assert.deepEqual(JSON.parse(scrubbed.text), {
    ...record,
    environment: { ...record.environment, DB_PASSWORD: '[REDACTED]' },
  });
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

test('--root replaces the default roots in both flag forms; unknown flags scan nothing', (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'credential-scrub-only-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const data = path.join(base, 'data');
  const chosen = path.join(base, 'chosen');
  for (const dir of [home, path.join(data, 'archive'), chosen]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(home, 'run-bundle-retention.json'),
    JSON.stringify({ runBundleRetention: { storeRoot: path.join(data, 'run-bundles') } }),
  );
  const env = { FARMSLOT_HOME: home, FARMSLOT_RUNS_DIR: path.join(base, 'runs') };
  const skipped = path.join(data, 'archive/run-skip.json');
  assert.ok(defaultScrubRoots(env).includes(path.dirname(skipped)));
  const record = JSON.stringify({ environment: { CODEX_LB_API_KEY: FAKE_KEY } });
  writeFileSync(skipped, record);
  const script = path.resolve(import.meta.dirname, '../../../../scripts/scrub-run-credentials.mts');
  for (const rootArgs of [['--root', chosen], [`--root=${chosen}`]]) {
    const target = path.join(chosen, 'run-pick.json');
    writeFileSync(target, record);
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', script, ...rootArgs, '--apply'],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          ...env,
          TSX_TSCONFIG_PATH: path.resolve(import.meta.dirname, '../../tsconfig.json'),
        },
      },
    );
    assert.equal(readFileSync(skipped, 'utf8'), record, rootArgs.join(' '));
    assert.ok(!readFileSync(target, 'utf8').includes(FAKE_KEY), rootArgs.join(' '));
    assert.ok(!output.includes(path.dirname(skipped)), output);
  }
  assert.throws(
    () =>
      execFileSync(process.execPath, ['--import', 'tsx', script, '--roots', chosen, '--apply'], {
        stdio: 'ignore',
        env: { PATH: process.env.PATH, ...env },
      }),
    { status: 2 },
  );
  assert.equal(readFileSync(skipped, 'utf8'), record);
});

test('--root refuses the filesystem root, home directory and farm home before scanning', (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'credential-scrub-refuse-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const userHome = path.join(base, 'user');
  const farmHome = path.join(base, 'farm/home');
  const store = path.join(farmHome, 'run-archive');
  mkdirSync(store, { recursive: true });
  mkdirSync(path.join(userHome, 'runs'), { recursive: true });
  const record = JSON.stringify({ environment: { CODEX_LB_API_KEY: FAKE_KEY } });
  const files = [path.join(farmHome, 'credentials.json'), path.join(store, 'run-a.json')];
  for (const file of files) writeFileSync(file, record);
  symlinkSync(path.join(base, 'farm'), path.join(userHome, 'farm-link'));
  const script = path.resolve(import.meta.dirname, '../../../../scripts/scrub-run-credentials.mts');
  const env = {
    PATH: process.env.PATH,
    HOME: userHome,
    FARMSLOT_HOME: farmHome,
    FARMSLOT_RUNS_DIR: path.join(base, 'runs'),
    TSX_TSCONFIG_PATH: path.resolve(import.meta.dirname, '../../tsconfig.json'),
  };
  // The filesystem root is checked without the script so a regression cannot scan the real disk.
  assert.equal(unsafeScrubRoot('/', env), 'filesystem root');
  for (const [root, reason] of [
    [userHome, /home directory/u],
    [farmHome, /farm home/u],
    [path.join(base, 'farm'), /contains the farm home/u],
    [base, /contains the farm home/u],
    [path.join(userHome, 'farm-link'), /contains the farm home .*resolves to/u],
  ] as const) {
    let failure: { status?: number; stderr?: string; stdout?: string } = {};
    try {
      execFileSync(process.execPath, ['--import', 'tsx', script, '--root', root, '--apply'], {
        encoding: 'utf8',
        stdio: 'pipe',
        env,
      });
    } catch (error) {
      failure = error as typeof failure;
    }
    assert.equal(failure.status, 2, root);
    assert.match(
      failure.stderr ?? '',
      new RegExp(`refusing --root ${root}: ${reason.source}`, 'u'),
    );
    assert.equal(failure.stdout, '', root);
    for (const file of files) assert.equal(readFileSync(file, 'utf8'), record, `${root} ${file}`);
  }
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', script, '--root', path.join(userHome, 'runs')],
    { encoding: 'utf8', env },
  );
  assert.match(output, /scanned=0/u);
});

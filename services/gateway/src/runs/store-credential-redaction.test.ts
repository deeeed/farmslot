import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { redactCommandCredentials } from '../core/credential-redaction.js';

import {
  buildRunRecord,
  createRun,
  discardUndurableRun,
  getRun,
  normalizePersistedRun,
  persistRunNow,
  runsDirectory,
  updateRun,
  updateRunStep,
} from './store.js';

const FAKE_KEY = 'fixture-provider-value-0001';
const FAKE_TOKEN = "fixture-quoted'token-0001";
const launch = [
  `export LITELLM_API_KEY='${FAKE_KEY}'`,
  `export JIRA_API_TOKEN='${FAKE_TOKEN.replace(/'/g, `'\\''`)}'`,
  "export FARMSLOT_HOME='/fixture/home'",
  `/usr/bin/env -i \${LITELLM_API_KEY+"LITELLM_API_KEY=$LITELLM_API_KEY"} pi`,
].join(' && ');

test('command redaction keeps names, references and shell shape, and is idempotent', () => {
  const first = redactCommandCredentials(launch);
  assert.equal(first.count, 2);
  assert.ok(!first.text.includes(FAKE_KEY));
  assert.ok(!first.text.includes('fixture-quoted'));
  assert.match(
    first.text,
    /export LITELLM_API_KEY=\[REDACTED\] && export JIRA_API_TOKEN=\[REDACTED\]/u,
  );
  assert.ok(first.text.includes("export FARMSLOT_HOME='/fixture/home'"));
  assert.ok(first.text.includes('"LITELLM_API_KEY=$LITELLM_API_KEY"'));
  assert.deepEqual(redactCommandCredentials(first.text), { text: first.text, count: 0 });
  assert.equal(
    redactCommandCredentials(
      'GIT_CONFIG_KEY_0=credential.helper GH_TOKEN=x GITHUB_TOKEN=fixture-github-value-0004 cmd',
    ).text,
    'GIT_CONFIG_KEY_0=credential.helper GH_TOKEN=x GITHUB_TOKEN=[REDACTED] cmd',
  );
});

test('command redaction catches single-class passwords but keeps key slugs', () => {
  const password = ['qzvxw', 'plmkr', 'tnbyhd'].join('');
  const passphrase = ['amber', 'canyon', 'violet', 'harbor'].join('-');
  assert.deepEqual(
    redactCommandCredentials(
      `DB_PASSWORD=${password} SMTP_SECRET='${passphrase}' ANTIPATTERN_REPO_KEY=fixture-repo-slugs MM_X_API_KEY_INDEX=3 cmd`,
    ),
    {
      text: 'DB_PASSWORD=[REDACTED] SMTP_SECRET=[REDACTED] ANTIPATTERN_REPO_KEY=fixture-repo-slugs MM_X_API_KEY_INDEX=3 cmd',
      count: 2,
    },
  );
});

test('command redaction catches quoted spaced passphrases under password names only', () => {
  const spaced = ['amber', 'canyon', 'violet', 'harbor'].join(' ');
  assert.deepEqual(
    redactCommandCredentials(
      `DB_PASSWORD='${spaced}' SMTP_SECRET="${spaced}" LITELLM_API_KEY='${spaced}' cmd`,
    ),
    {
      text: `DB_PASSWORD=[REDACTED] SMTP_SECRET=[REDACTED] LITELLM_API_KEY='${spaced}' cmd`,
      count: 2,
    },
  );
  assert.deepEqual(redactCommandCredentials(`{"DB_PASSWORD": "${spaced}"}`), {
    text: '{"DB_PASSWORD": "[REDACTED]"}',
    count: 1,
  });
  for (const prose of [
    'set DB_PASSWORD in the env',
    `DB_PASSWORD: ${spaced}`,
    `DB_PASSWORD="$DB_PASSWORD and more words"`,
  ])
    assert.deepEqual(redactCommandCredentials(prose), { text: prose, count: 0 });
});

test('persisted and served dispatch outputs keep credential names, never values', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: randomUUID() });
  t.after(async () => {
    await persistRunNow(run);
    await discardUndurableRun(run.id);
  });
  updateRun(run.id, { steps: [{ name: 'dispatch', status: 'running' }] });
  updateRunStep(run.id, 'dispatch', {
    status: 'done',
    outputs: { success: true, launchCommand: launch, failedCommand: launch },
  });
  await persistRunNow(getRun(run.id)!);
  const stored = await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8');
  const served = JSON.stringify(getRun(run.id));
  for (const record of [stored, served]) {
    assert.ok(record.includes('LITELLM_API_KEY'));
    assert.ok(record.includes('JIRA_API_TOKEN'));
    assert.ok(!record.includes(FAKE_KEY));
    assert.ok(!record.includes('fixture-quoted'));
  }
});

test('loading a legacy record redacts its stored launch line', () => {
  const legacy = buildRunRecord({ flowType: 'dev', project: 'demo', ticketOrPr: randomUUID() });
  legacy.steps = [{ name: 'dispatch', status: 'done', outputs: { launchCommand: launch } }];
  normalizePersistedRun(legacy);
  const stored = String(legacy.steps[0].outputs?.launchCommand);
  assert.ok(stored.includes('LITELLM_API_KEY=[REDACTED]'));
  assert.ok(!stored.includes(FAKE_KEY));
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runWithSessionOriginator } from '../security/work-originator.js';

import { assessmentStatus, assessmentTest } from './assessment.js';

const previousHome = process.env.FARMSLOT_HOME;
const testHome = mkdtempSync(path.join(tmpdir(), 'assessment-method-'));
process.env.FARMSLOT_HOME = testHome;
test.after(() => {
  if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
  else process.env.FARMSLOT_HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
});

test('assessment status reports providers and never returns the credential', () => {
  const previous = process.env.TYPESAFE_API_KEY;
  const previousProvider = process.env.FARMSLOT_ASSESSMENT_PROVIDER;
  process.env.TYPESAFE_API_KEY = 'private-test-key';
  process.env.FARMSLOT_ASSESSMENT_PROVIDER = 'typesafe';
  try {
    const result = assessmentStatus();
    assert.equal(result.enabled, false);
    assert.equal(result.keyAvailable, true);
    assert.equal(result.providers[0]?.id, 'typesafe');
    assert.equal(JSON.stringify(result).includes('private-test-key'), false);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
    if (previousProvider === undefined) delete process.env.FARMSLOT_ASSESSMENT_PROVIDER;
    else process.env.FARMSLOT_ASSESSMENT_PROVIDER = previousProvider;
  }
});

test('assessment test remains optional when the configured provider has no key', async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const result = await runWithSessionOriginator(
      { id: 'test-owner', subject: { type: 'person', displayName: 'Tester' }, roles: [] },
      () => assessmentTest({ provider: 'typesafe' }),
    );
    assert.equal(result.status, 'skipped');
    assert.match(result.error ?? '', /not configured/);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test('assessment status reports corrupt optional configuration without throwing', () => {
  const corruptHome = mkdtempSync(path.join(tmpdir(), 'assessment-corrupt-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = corruptHome;
  try {
    writeFileSync(path.join(corruptHome, 'assessment-config.json'), '{bad', 'utf8');
    const result = assessmentStatus();
    assert.equal(result.enabled, false);
    assert.equal(result.error, 'Assessment configuration unavailable');
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    rmSync(corruptHome, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assess } from './index.js';
import { createAssessmentProviderRegistry } from './provider.js';

const request = {
  state: { diff: 'changed button label' } as const,
  questions: {
    visual: { type: 'boolean' as const, instructions: 'Does this require visual review?' },
  },
};

const previousHome = process.env.FARMSLOT_HOME;
const testHome = mkdtempSync(path.join(tmpdir(), 'assessment-index-'));
process.env.FARMSLOT_HOME = testHome;
test.after(() => {
  if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
  else process.env.FARMSLOT_HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
});

test('assessment is disabled when no explicit opt-in is present', async () => {
  const previous = process.env.FARMSLOT_ASSESSMENT_ENABLED;
  delete process.env.FARMSLOT_ASSESSMENT_ENABLED;
  try {
    const result = await assess(request);
    assert.equal(result.status, 'disabled');
    assert.equal(result.answers, undefined);
    assert.equal(result.stateHash, undefined); // No input was prepared or sent.
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_ASSESSMENT_ENABLED;
    else process.env.FARMSLOT_ASSESSMENT_ENABLED = previous;
  }
});

test('explicit assessment with no provider key is skipped without exposing credentials', async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const result = await assess({ ...request, provider: 'typesafe', enabled: true });
    assert.equal(result.status, 'skipped');
    assert.doesNotMatch(result.error ?? '', /TYPESAFE_API_KEY|Bearer/);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test('provider selection does not bypass the saved opt-in', async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-key';
  try {
    const result = await assess({ ...request, provider: 'typesafe' });
    assert.equal(result.status, 'disabled');
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test('oversized assessment input is skipped before provider transport', async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-key';
  try {
    const result = await assess({
      state: { text: 'x'.repeat(70 * 1024) },
      questions: request.questions,
      provider: 'typesafe',
      enabled: true,
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.error, 'Assessment input limit exceeded');
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test('unknown provider is unavailable and does not change the normal workflow', async () => {
  const result = await assess({ ...request, provider: 'missing-provider', enabled: true });
  assert.equal(result.status, 'unavailable');
  assert.match(result.error ?? '', /unknown structured assessment provider/);
});

test('attempt accounting distinguishes transport invocation from disabled requests', async () => {
  const previous = process.env.ASSESSMENT_TEST_KEY;
  process.env.ASSESSMENT_TEST_KEY = 'fixture-key';
  let calls = 0;
  let fail = false;
  const providers = createAssessmentProviderRegistry([
    {
      id: 'fixture',
      defaultModel: 'fixed',
      credentialEnv: 'ASSESSMENT_TEST_KEY',
      capabilities: ['boolean'],
      async assess() {
        calls++;
        if (fail) throw new Error('simulated transport failure');
        return {
          answers: { visual: { type: 'boolean', probability: 0.5 } },
          usage: { durationMs: 1 },
        };
      },
    },
  ]);
  try {
    const disabled = await assess({ ...request, provider: 'fixture', enabled: false }, providers);
    assert.equal(disabled.attempted, false);
    assert.equal(calls, 0);
    const completed = await assess({ ...request, provider: 'fixture', enabled: true }, providers);
    assert.equal(completed.attempted, true);
    assert.equal(calls, 1);
    fail = true;
    const failed = await assess({ ...request, provider: 'fixture', enabled: true }, providers);
    assert.equal(failed.status, 'unavailable');
    assert.equal(failed.attempted, true);
    assert.equal(calls, 2);
  } finally {
    if (previous === undefined) delete process.env.ASSESSMENT_TEST_KEY;
    else process.env.ASSESSMENT_TEST_KEY = previous;
  }
});

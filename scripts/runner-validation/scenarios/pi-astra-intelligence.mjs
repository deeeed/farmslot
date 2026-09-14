import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { rpc } from './native-worker-lifecycle.mjs';

export const SCENARIO_ID = 'pi-astra-intelligence';

export async function runScenario({ outDir, via }) {
  const provider =
    via === 'anthropic-scope' ? 'anthropic' : via === 'codex-lb' ? 'codex-lb' : 'openai-codex';
  const report = { runner: 'codex', checks: [], pass: false, error: null };
  let fixtureProfile;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    const proof = process.env.FARMSLOT_PI_ASTRA_PROOF;
    assert.ok(
      proof && path.resolve(proof).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
    );
    assert.equal(fs.existsSync(proof), false, 'Use a fresh private proof path');
    const pids = execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/)
      .map(Number);
    assert.equal(pids.length, 1);
    assert.ok(fs.existsSync(`${proof}.${pids[0]}.loaded`));
    if (provider === 'anthropic') {
      // A synthetic credential and stopped HTTP transport prove request construction only.
      // No provider inference or subscription claim is made by this branch.
      const profiles = rpc('llm.auth.list').profiles;
      assert.ok(
        !profiles.some((profile) => profile.provider === provider),
        'Use a private home without an Anthropic profile',
      );
      fixtureProfile = `anthropic:reasoning-proof-${randomUUID()}`;
      rpc('llm.auth.add', {
        provider,
        type: 'api_key',
        profileId: fixtureProfile,
        credential: 'private-validation-not-a-provider-key',
      });
      fs.writeFileSync(proof, JSON.stringify({ gatewayPid: pids[0], provider }), { mode: 0o600 });
      const result = rpc('llm.auth.test', { provider, model: 'sonnet' }, 90000);
      assert.equal(result.ok, false);
      const requests = fs
        .readFileSync(`${proof}.requests`, 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.ok(requests.length > 0);
      for (const request of requests) {
        assert.equal(request.provider, provider);
        assert.equal(request.stoppedBeforeTransport, true);
        assert.ok(
          ['disabled', 'omitted'].includes(request.thinking),
          'Codex default enabled thinking for another provider',
        );
        assert.equal(request.tools, 0);
      }
      report.requests = requests;
      report.inferenceExpected = false;
      report.checks.push(
        'Real gateway authentication-test route leaves other provider thinking disabled, observed before transport',
      );
      report.pass = true;
    } else {
      const config = rpc('llm.config.get');
      assert.equal(config.defaultProvider, provider);
      assert.equal(config.intelligenceModel, 'gpt-6-astra');
      assert.equal(config.intelligenceEffort, 'low');
      fs.writeFileSync(proof, JSON.stringify({ gatewayPid: pids[0], provider }), { mode: 0o600 });
      const result = rpc(
        'llm.auth.test',
        { provider: config.defaultProvider, model: config.intelligenceModel },
        90000,
      );
      assert.equal(result.ok, true, result.error);
      assert.equal(result.provider, provider);
      assert.equal(result.model, 'gpt-6-astra');
      assert.notEqual(result.source, 'cli');
      if (provider === 'codex-lb') assert.equal(result.source, 'env:CODEX_LB_API_KEY');
      assert.equal(result.usage?.provider, provider);
      assert.equal(result.usage?.model, 'gpt-6-astra');
      assert.match(result.responsePreview ?? '', /\bOK\b/);
      assert.equal(result.usage?.costUsd, undefined, 'API list price is not subscription billing');
      assert.ok(result.usage?.inputTokens > 0 && result.usage?.outputTokens > 0);
      const requests = fs
        .readFileSync(`${proof}.requests`, 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.ok(requests.length > 0);
      for (const request of requests) {
        assert.equal(request.provider, provider);
        assert.equal(request.model, 'gpt-6-astra');
        assert.equal(request.effort, 'low');
        assert.equal(request.tools, 0);
        assert.equal(request.store, false);
      }
      report.requests = requests;
      report.usage = result.usage;
      report.checks.push(
        'Gateway intelligence defaults reach existing Codex provider at Astra/low without tools or reported subscription cost',
      );
      report.pass = true;
    }
  } catch (error) {
    report.error = error.message;
  } finally {
    if (fixtureProfile)
      assert.equal(rpc('llm.auth.remove', { profileId: fixtureProfile }).ok, true);
  }
  const outPath = writeEvidence(report, SCENARIO_ID, 'codex', outDir);
  return { scenario: SCENARIO_ID, runner: 'codex', pass: report.pass, outPath, report };
}

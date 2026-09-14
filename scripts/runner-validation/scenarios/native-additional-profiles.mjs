import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Methods } from '@farmslot/protocol';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { connect } from './native-node-broker-smoke.mjs';

export const SCENARIO_ID = 'native-additional-profiles';
export const RUNNER_AGNOSTIC = true;

/** Empty configuration profiles must report native login status without inheriting the ambient login. */
export async function runScenario({ outDir, explicit }) {
  if (!explicit) return { scenario: SCENARIO_ID, runner: 'native', pass: true, skipped: true };
  const report = { runner: 'native', checks: [], pass: false, inferenceExpected: false };
  let client;
  const profiles = [];
  try {
    const url = new URL(process.env.FARMSLOT_GATEWAY);
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.port && url.port !== '7777',
      'Use a private local gateway',
    );
    client = await connect(process.env.FARMSLOT_GATEWAY_TOKEN, 'ui');
    const ok = async (method, params) => {
      const r = await client.request(method, params, 90000);
      assert.equal(r.ok, true, `${method}: ${r.error?.code}`);
      return r.payload;
    };
    await ok(Methods.PRINCIPAL_LIST, {});
    const nonce = randomUUID();
    for (const runner of ['cursor', 'grok']) {
      const directory = path.join(
        ROOT,
        'temp/native-validation/g005-current-audit/profiles',
        `${runner}-${nonce}`,
      );
      const { profile } = await ok(Methods.NATIVE_PROFILE_ADD, {
        profileId: `${runner}-${nonce}`,
        runner,
        directory,
      });
      profiles.push(profile);
      const status = await ok(Methods.NATIVE_PROFILE_STATUS, { profileId: profile.id });
      assert.equal(status.profile.directory, directory);
      assert.equal(status.account.installed, true, `${runner} native executable is required`);
      assert.equal(
        status.account.identity,
        undefined,
        'Empty profile unexpectedly reported an inherited account identity',
      );
      if (runner === 'cursor') {
        assert.equal(status.account.login, 'signed-out');
        assert.ok(
          status.loginCommand.includes("'-u' 'CURSOR_AUTH_TOKEN'"),
          'Cursor native auth-token override survives generated login command',
        );
        assert.ok(status.loginCommand.includes(`'HOME=${directory}'`));
        assert.ok(status.loginCommand.includes("'AGENT_CLI_CREDENTIAL_STORE=file'"));
      } else {
        assert.ok(['signed-out', 'unavailable'].includes(status.account.login));
        assert.ok(status.loginCommand.includes(`'GROK_HOME=${directory}'`));
        assert.ok(status.loginCommand.includes("'-u' 'XAI_API_KEY'"));
      }
      assert.notEqual(status.account.login, 'authenticated');
      report.checks.push({
        name: `${runner}-empty-native-profile-status`,
        pass: true,
        login: status.account.login,
        mode: status.account.mode,
        reason: status.account.reason,
        version: status.account.version,
      });
    }
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (client)
      for (const profile of profiles) {
        try {
          const result = await client.request(
            Methods.NATIVE_PROFILE_REMOVE,
            { profileId: profile.id, accountContextId: profile.accountContextId },
            90000,
          );
          assert.equal(result.ok, true, 'Private profile cleanup failed');
        } catch (error) {
          report.pass = false;
          report.cleanupError = error.message;
        }
      }
    client?.ws.close();
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}

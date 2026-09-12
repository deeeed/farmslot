import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'native-session-authorization-smoke';
export const RUNNER_AGNOSTIC = true;

// Use a separately activated validation gateway. Both accounts must authenticate;
// the second account should also be admin so this proves native profile ownership.
// FARMSLOT_GATEWAY_TOKEN is the owner. FARMSLOT_NATIVE_OTHER_TOKEN is the other admin.
// Tokens are passed through the child environment, never CLI arguments or evidence.
function rpc(token, method, params = {}) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FARMSLOT_GATEWAY_TOKEN: token, FARMSLOT_GATEWAY_PASSWORD: '' },
      },
    );
    return { ok: true, payload: JSON.parse(stdout) };
  } catch (error) {
    const code = String(error.stderr ?? '').match(/"code":"([A-Z_]+)"/)?.[1];
    return { ok: false, code: code ?? 'TRANSPORT_FAILURE' };
  }
}

function successful(token, method, params) {
  const response = rpc(token, method, params);
  assert.equal(response.ok, true, `${method} failed: ${response.code}`);
  return response.payload;
}

export async function runScenario({ outDir }) {
  const report = {
    runner: 'codex',
    gateway: process.env.FARMSLOT_GATEWAY,
    inferenceExpected: false,
    checks: [],
    pass: false,
    error: null,
  };
  const owner = process.env.FARMSLOT_GATEWAY_TOKEN;
  const other = process.env.FARMSLOT_NATIVE_OTHER_TOKEN;
  let session;
  try {
    assert.ok(report.gateway, 'Set FARMSLOT_GATEWAY to the isolated authorization gateway');
    assert.ok(
      owner && other && owner !== other,
      'Two distinct validation credentials are required',
    );
    // Both must reach the administrative API, ruling out invalid credentials or
    // generic role denial as the reason the native methods later refuse access.
    successful(owner, 'principal.list', {});
    successful(other, 'principal.list', {});
    report.checks.push({ name: 'both-admin-credentials-authenticate', pass: true });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'farmslot-native-auth-'));
    execFileSync('git', ['init', '--quiet'], { cwd });
    const before = successful(owner, 'native.session.list', {}).sessions;
    session = successful(owner, 'native.session.create', { runner: 'codex', cwd }).session;
    const initial = successful(owner, 'native.session.read', { sessionId: session.id });
    assert.equal(initial.session.state, 'idle');
    assert.ok(initial.session.nativeSessionId);
    report.sessionId = session.id;
    report.ownerPrincipalId = session.ownerPrincipalId;
    const target = { sessionId: session.id };
    const attempts = [
      ['native.session.list', {}],
      ['native.session.create', { runner: 'codex', cwd }],
      ['native.session.read', target],
      [
        'native.session.send',
        {
          ...target,
          commandId: randomUUID(),
          text: 'Unauthorized negative control; this must never reach inference.',
        },
      ],
      [
        'native.session.respond',
        { ...target, requestId: 'unauthorized-request', decision: 'approve' },
      ],
      ['native.session.interrupt', target],
      ['native.session.close', target],
    ];
    for (const [method, params] of attempts) {
      const result = rpc(other, method, params);
      if (method === 'native.session.send') report.unauthorizedSendAccepted = result.ok;
      assert.equal(result.ok, false, `Other principal accessed ${method}`);
      assert.equal(result.code, 'AUTH_FORBIDDEN', `${method} failed for the wrong reason`);
      report.checks.push({ method, rejected: true, code: result.code });
    }
    const after = successful(owner, 'native.session.read', target);
    assert.equal(after.session.state, 'idle', 'Unauthorized operation changed owner session state');
    assert.deepEqual(after.events, initial.events, 'Unauthorized operation produced owner events');
    assert.equal(successful(owner, 'native.session.list', {}).sessions.length, before.length + 1);
    report.checks.push({ name: 'owner-session-and-events-unchanged', pass: true });
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (session) {
      const result = rpc(owner, 'native.session.close', { sessionId: session.id });
      if (!result.ok) {
        report.pass = false;
        report.cleanupError = `Owner session close failed: ${result.code}`;
      }
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, 'codex', outDir);
  return { scenario: SCENARIO_ID, runner: 'codex', outPath, pass: report.pass, report };
}

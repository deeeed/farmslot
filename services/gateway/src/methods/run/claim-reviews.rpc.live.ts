// Manual loopback protocol proof, outside the default test tier.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { deriveReviewedRecipeClaims } from '@farmslot/adapter-sdk/evidence';
import { Methods, type RunReviewVisualClaimResult } from '@farmslot/protocol';

import { visualReviewAuthority } from '../../run-engine/claim-reviews.js';
import { visualReviewSnapshotIdentity } from '../../run-engine/recorded-evidence-sources.js';
import { getRun } from '../../runs/store.js';

import { fixture } from './claim-reviews.test.js';

test('authenticated public RPC records a text-free confirmation and refuses an empty Issue', async (t) => {
  const f = await fixture(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'one-tap-rpc-'));
  const { createGatewayAuthRuntime } = await import('../../security/auth.js');
  const { createWebSocketServer } = await import('../../server.js');
  const { GatewayClient } = await import('../../../../../packages/cli/src/gateway-client.js');
  const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
  const person = runtime.writer.createPrincipal({ type: 'person', displayName: 'Protocol proof' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const credential = runtime.writer.issueCredential(person.id, 'Disposable proof');
  const grant = runtime.writer.exchangePersonCredential(credential.secret, {
    deviceName: 'Loopback proof',
    deviceKind: 'cli',
  });
  const server = createServer();
  const wss = createWebSocketServer(server, runtime);
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(home, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    timeout: 5000,
    credential: { token: grant.accessToken },
  });
  const { reason: _reason, ...params } = f.params;
  const result = await client.call<RunReviewVisualClaimResult>(
    Methods.RUN_REVIEW_VISUAL_CLAIM,
    params,
  );
  assert.equal(result.receipt.approver.principalId, person.id);
  assert.equal(result.receipt.approver.personSessionId, grant.session.id);
  assert.equal('reason' in result.receipt, false);
  const current = getRun(f.run.id)!;
  assert.equal(current.visualJudgmentReceipts?.at(-1)?.id, result.receipt.id);
  assert.deepEqual(
    deriveReviewedRecipeClaims(f.input, visualReviewAuthority(current, f.input)).map(
      ({ verdict }) => verdict,
    ),
    ['proven', 'proven'],
  );
  await assert.rejects(
    client.call(Methods.RUN_REVIEW_VISUAL_CLAIM, {
      ...params,
      snapshotIdentity: visualReviewSnapshotIdentity(current, f.decision.id),
      verdict: 'rejected',
    }),
    /written reason/,
  );
  assert.equal(getRun(f.run.id)!.visualJudgmentReceipts?.length, 1);
  assert.equal(getRun(f.run.id)!.decisions[0]!.resolvedAt, undefined);
});

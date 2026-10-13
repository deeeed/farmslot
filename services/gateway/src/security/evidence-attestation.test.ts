import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGatewayAuthRuntime, initializeGatewayIdentity } from './auth.js';
import { authorizeEvidenceAttestation } from './evidence-attestation.js';

test('attestation rejects solo, service, node and unprivileged callers; active person authority is rechecked', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'evidence-attestation-auth-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runtime = createGatewayAuthRuntime({
    FARMSLOT_HOME: home,
    FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  });
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  assert.throws(
    () => authorizeEvidenceAttestation(runtime, { authenticated: true, clientKind: 'ui' }),
    /credential-backed person/,
  );
  const roles = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
  for (const subject of [
    { type: 'service' as const, displayName: 'worker' },
    { type: 'node' as const, displayName: 'node', machine: 'fixture' },
  ]) {
    const principal = runtime.writer.createPrincipal(subject, subject.type === 'node' ? [] : roles);
    const issue = runtime.writer.issueCredential(principal.id, 'fixture');
    const session = {
      authenticated: true,
      clientKind: 'ui' as const,
      authentication: { kind: 'credential' as const, credentialId: issue.record.id },
    };
    assert.throws(
      () => authorizeEvidenceAttestation(runtime, session),
      /credential-backed person|Denied/,
    );
  }
  const unprivileged = runtime.writer.createPrincipal(
    { type: 'person', displayName: 'observer' },
    [],
  );
  const unprivilegedIssue = runtime.writer.issueCredential(unprivileged.id, 'observer');
  assert.throws(
    () =>
      authorizeEvidenceAttestation(runtime, {
        authenticated: true,
        authentication: { kind: 'credential', credentialId: unprivilegedIssue.record.id },
      }),
    /Denied/,
  );
  const person = runtime.writer.createPrincipal({ type: 'person', displayName: 'Operator' }, roles);
  const issue = runtime.writer.issueCredential(person.id, 'operator');
  const session = {
    authenticated: true,
    clientKind: 'ui' as const,
    authentication: { kind: 'credential' as const, credentialId: issue.record.id },
  };
  assert.deepEqual(authorizeEvidenceAttestation(runtime, session), {
    principalId: person.id,
    displayName: 'Operator',
    credentialId: issue.record.id,
  });
  runtime.writer.revokeCredential(issue.record.id);
  assert.throws(() => authorizeEvidenceAttestation(runtime, session), /requires authentication/);
});

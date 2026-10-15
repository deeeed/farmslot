import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGatewayAuthRuntime, initializeGatewayIdentity } from './auth.js';
import {
  authorizeEvidenceAttestation,
  authorizeVisualClaimReview,
} from './evidence-attestation.js';

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

test('delegated visual review uses an allowlisted service credential while publication remains person-only', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'delegated-review-auth-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runtime = createGatewayAuthRuntime({
    FARMSLOT_HOME: home,
    FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  });
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  const roles = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
  const person = runtime.writer.createPrincipal({ type: 'person', displayName: 'Operator' }, roles);
  const service = runtime.writer.createPrincipal(
    { type: 'service', displayName: 'Lead reviewer' },
    roles,
  );
  runtime.writer.issueCredential(person.id, 'operator');
  const issue = runtime.writer.issueCredential(service.id, 'lead-review');
  const session = {
    authenticated: true,
    authentication: { kind: 'credential' as const, credentialId: issue.record.id },
  };
  const policy = { delegatedReviewerPrincipalIds: [service.id], delegatorPrincipalId: person.id };
  assert.deepEqual(authorizeVisualClaimReview(runtime, session, 'lead-agent-reviewed', policy), {
    principalId: service.id,
    displayName: 'Lead reviewer',
    credentialId: issue.record.id,
    subjectKind: 'service',
    delegator: { principalId: person.id, displayName: 'Operator' },
  });
  assert.throws(
    () => authorizeVisualClaimReview(runtime, session, 'person-reviewed', policy),
    /own active credential/,
  );
  assert.throws(
    () => authorizeVisualClaimReview(runtime, session, 'lead-agent-reviewed'),
    /own active credential/,
  );
  assert.throws(
    () =>
      authorizeVisualClaimReview(runtime, session, 'lead-agent-reviewed', {
        ...policy,
        delegatedReviewerPrincipalIds: [],
      }),
    /own active credential/,
  );
  assert.throws(
    () =>
      authorizeVisualClaimReview(runtime, session, 'lead-agent-reviewed', {
        ...policy,
        delegatorPrincipalId: service.id,
      }),
    /person delegator/,
  );
  assert.throws(() => authorizeEvidenceAttestation(runtime, session), /credential-backed person/);
  runtime.writer.revokeCredential(issue.record.id);
  assert.throws(
    () => authorizeVisualClaimReview(runtime, session, 'lead-agent-reviewed', policy),
    /requires authentication/,
  );
});

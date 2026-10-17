import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pairingCreate, pairingExchangePersonSession } from '../fleet/pairing.js';

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
    /active person device session/,
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
      /active person device session|Denied/,
    );
  }
  const unprivileged = runtime.writer.createPrincipal(
    { type: 'person', displayName: 'observer' },
    [],
  );
  const unprivilegedIssue = runtime.writer.issueCredential(unprivileged.id, 'observer');
  assert.throws(
    () => authorizeEvidenceAttestation(runtime, personDevice(runtime, unprivilegedIssue.secret)),
    /Denied/,
  );
  const person = runtime.writer.createPrincipal({ type: 'person', displayName: 'Operator' }, roles);
  const issue = runtime.writer.issueCredential(person.id, 'operator');
  const session = personDevice(runtime, issue.secret);
  assert.deepEqual(authorizeEvidenceAttestation(runtime, session), {
    principalId: person.id,
    displayName: 'Operator',
    personSessionId: session.authentication.sessionId,
  });
  assert.equal(
    authorizeVisualClaimReview(runtime, session, 'person-reviewed').personSessionId,
    session.authentication.sessionId,
  );
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
  assert.throws(
    () => authorizeEvidenceAttestation(runtime, session),
    /active person device session/,
  );
  runtime.writer.revokeCredential(issue.record.id);
  assert.throws(
    () => authorizeVisualClaimReview(runtime, session, 'lead-agent-reviewed', policy),
    /requires authentication/,
  );
});

test('a visual-review delegator binds generation zero unless the policy pins its generation', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'delegator-generation-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runtime = createGatewayAuthRuntime({
    FARMSLOT_HOME: home,
    FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  });
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  const roles = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
  const person = { type: 'person' as const, displayName: 'Arthur' };
  runtime.writer.createPrincipal(person, roles, 'arthur');
  const service = runtime.writer.createPrincipal(
    { type: 'service', displayName: 'Lead reviewer' },
    roles,
  );
  const issue = runtime.writer.issueCredential(service.id, 'lead-review');
  const session = {
    authenticated: true,
    authentication: { kind: 'credential' as const, credentialId: issue.record.id },
  };
  const bare = { delegatedReviewerPrincipalIds: [service.id], delegatorPrincipalId: 'arthur' };
  assert.equal(
    authorizeVisualClaimReview(runtime, session, 'lead-agent-reviewed', bare).delegator
      ?.principalId,
    'arthur',
  );
  assert.throws(
    () =>
      authorizeVisualClaimReview(runtime, session, 'lead-agent-reviewed', {
        ...bare,
        delegatorPrincipalGeneration: 1,
      }),
    /arthur has been replaced by a newer identity/,
  );

  runtime.writer.retirePrincipals(['arthur']);
  runtime.writer.createPrincipal(person, roles, 'arthur', { reuseRetiredId: true });
  // A policy written for the retired identity never credits its replacement.
  assert.throws(
    () => authorizeVisualClaimReview(runtime, session, 'lead-agent-reviewed', bare),
    /arthur has been replaced by a newer identity.*delegatorPrincipalGeneration/,
  );
  assert.deepEqual(
    authorizeVisualClaimReview(runtime, session, 'lead-agent-reviewed', {
      ...bare,
      delegatorPrincipalGeneration: 1,
    }).delegator,
    { principalId: 'arthur', displayName: 'Arthur' },
  );
  assert.throws(
    () =>
      authorizeVisualClaimReview(runtime, session, 'lead-agent-reviewed', {
        ...bare,
        delegatorPrincipalGeneration: 2,
      }),
    /arthur has been replaced by a newer identity/,
  );
});

function personDevice(runtime: ReturnType<typeof createGatewayAuthRuntime>, credential: string) {
  const grant = runtime.writer.exchangePersonCredential(credential, {
    deviceName: 'Attestation fixture',
    deviceKind: 'cli',
  });
  const resolved = runtime.resolver.resolveSecret(grant.accessToken, 'token');
  assert.ok(resolved.ok && resolved.authentication?.kind === 'person-session');
  return {
    authenticated: true,
    clientKind: 'ui' as const,
    authentication: resolved.authentication,
  };
}

test('paired person devices retain human approvals without inventing a source credential', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'paired-attestation-auth-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runtime = createGatewayAuthRuntime({
    FARMSLOT_HOME: home,
    FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  });
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  const roles = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
  const service = runtime.writer.createPrincipal(
    { type: 'service', displayName: 'Automation' },
    roles,
  );
  runtime.writer.issueCredential(service.id, 'automation');
  const person = runtime.writer.createPrincipal(
    { type: 'person', displayName: 'Paired admin' },
    roles,
  );
  const invitation = pairingCreate(
    {
      gatewayUrl: 'ws://127.0.0.1:1/ws',
      authority: { kind: 'existing-principal', principalId: person.id },
    },
    runtime,
  );
  const grant = pairingExchangePersonSession(
    invitation.code,
    { deviceName: 'Paired fixture', deviceKind: 'companion' },
    runtime,
  );
  const resolved = runtime.resolver.resolveSecret(grant.accessToken, 'token');
  assert.ok(resolved.ok && resolved.authentication?.kind === 'person-session');
  const authentication = resolved.authentication;
  const session = { authenticated: true, clientKind: 'companion' as const, authentication };
  assert.deepEqual(authorizeEvidenceAttestation(runtime, session), {
    principalId: person.id,
    displayName: 'Paired admin',
    personSessionId: grant.session.id,
  });
  assert.equal(
    authorizeVisualClaimReview(runtime, session, 'person-reviewed').personSessionId,
    grant.session.id,
  );
  runtime.writer.revokeRole(person.id, 'admin', { kind: 'global' });
  assert.throws(() => authorizeEvidenceAttestation(runtime, session), /requires the admin role/);
  runtime.writer.grantRole(person.id, 'admin', { kind: 'global' });
  runtime.writer.revokePersonSession(
    {
      principalId: person.id,
      principalGeneration: person.generation ?? 0,
      sessionId: authentication.sessionId,
      accessId: authentication.accessId,
    },
    authentication.sessionId,
  );
  assert.throws(() => authorizeEvidenceAttestation(runtime, session), /requires authentication/);
});

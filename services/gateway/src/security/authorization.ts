import type { Principal, SafetyTier } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import type { ClientState } from '../server/client-state.js';

import type { GatewayAuthRuntime, GatewayAuthSession } from './auth.js';
import { AUTHORIZATION_METHOD_CLASSIFICATION } from './authorization-classification.generated.js';
import { activeAdminCredentialCount } from './credential-store.js';

const IDENTITY_MANAGEMENT_METHODS = new Set([
  'principal.create',
  'principal.list',
  'principal.grant',
  'principal.revokeRole',
  'credential.issue',
  'credential.list',
  'credential.revoke',
]);

export function authorizeGatewayMethod(
  runtime: GatewayAuthRuntime,
  session: GatewayAuthSession,
  method: string,
): Principal {
  return authorizeGatewayIngress(runtime, session, { kind: 'method', method });
}

export function authorizeGatewayHttp(
  runtime: GatewayAuthRuntime,
  session: GatewayAuthSession,
): Principal {
  return authorizeGatewayIngress(runtime, session, { kind: 'http' });
}

type GatewayIngressRequest =
  | { kind: 'method'; method: string }
  | { kind: 'http' }
  | { kind: 'node-frame' };

function authorizeGatewayIngress(
  runtime: GatewayAuthRuntime,
  session: GatewayAuthSession,
  request: GatewayIngressRequest,
): Principal {
  const resolution = runtime.resolver.resolveSessionPrincipal(session);
  if (!resolution.ok) {
    const target = request.kind === 'method' ? request.method : request.kind;
    throw new GatewayMethodError('AUTH_REQUIRED', `Denied: ${target} requires authentication.`, {
      userAction: 'authenticate with an active credential and retry',
    });
  }
  const principal = resolution.principal;
  if (request.kind === 'node-frame') {
    if (principal.subject.type === 'node') return principal;
    throw new GatewayMethodError('AUTH_FORBIDDEN', 'Node-subject credential required.', {
      userAction: 'issue a node credential and reconnect',
    });
  }
  if (request.kind === 'http') {
    if (isAdminPrincipal(principal)) return principal;
    throw denial(runtime, session, 'HTTP resource access', principal);
  }
  const { method } = request;
  if (principal.subject.type === 'node') {
    if (method === 'node.connect') return principal;
    throw denial(
      runtime,
      session,
      method,
      principal,
      'node-subject credentials may use only the node surface',
    );
  }
  if (hasRole(principal, 'admin')) return principal;
  if (
    IDENTITY_MANAGEMENT_METHODS.has(method) &&
    runtime.store.isActivated() &&
    activeAdminCredentialCount(runtime.store.snapshot()) === 0
  ) {
    throw noActiveAdminDenial(session, runtime, principal);
  }
  const classification = classificationFor(method);
  if (hasRole(principal, 'operator') && classification?.classification === 'operator') {
    return principal;
  }
  throw denial(runtime, session, method, principal, classification?.reason);
}

function noActiveAdminDenial(
  session: GatewayAuthSession,
  runtime: GatewayAuthRuntime,
  principal: Principal,
): GatewayMethodError {
  const credentialName =
    session.authentication?.kind === 'credential'
      ? runtime.store.findCredential(session.authentication.credentialId)?.displayName
      : undefined;
  const roles =
    principal.roles.length > 0
      ? principal.roles.map((binding) => `${binding.role}, ${binding.scope.kind}`).join('; ')
      : 'no roles';
  return new GatewayMethodError(
    'AUTH_FORBIDDEN',
    'This gateway has no active admin credential, so nothing can be issued or revoked over RPC. ' +
      `Your ${credentialName ? `credential '${credentialName}' ` : ''}authenticates as principal '${principal.subject.displayName}' (${roles}).`,
    {
      userAction:
        'stop every gateway in this identity domain, then run\n' +
        '  farmslot credential issue --principal owner --role admin --scope global --offline\n' +
        'and start them again.',
    },
  );
}

export function requireNodeSubjectSession(
  runtime: GatewayAuthRuntime,
  session: GatewayAuthSession,
): Principal {
  return authorizeGatewayIngress(runtime, session, { kind: 'node-frame' });
}

export function isNodeSubjectSession(
  runtime: GatewayAuthRuntime,
  session: GatewayAuthSession,
): boolean {
  try {
    authorizeGatewayIngress(runtime, session, { kind: 'node-frame' });
    return true;
  } catch (error) {
    if (error instanceof GatewayMethodError) return false;
    throw error;
  }
}

export function isAdminPrincipal(principal: Principal): boolean {
  return principal.subject.type !== 'node' && hasRole(principal, 'admin');
}

export function authorizeStoredRunEffect(
  principal: Principal | null,
  itemLabel: string,
  effectiveSafetyTier: SafetyTier | undefined,
): Principal {
  if (principal && isAdminPrincipal(principal)) return principal;
  const authority = principal
    ? `principal '${principal.subject.displayName}' (${principal.id}) no longer has admin/global authority`
    : 'its stored originator cannot be resolved';
  throw new GatewayMethodError(
    'AUTH_FORBIDDEN',
    `Denied queued item '${itemLabel}' at fire time: ${authority}; ` +
      `the resolved effect is run.create at safety tier '${effectiveSafetyTier ?? 'runner-default'}'.`,
    {
      userAction:
        'edit or requeue the item from a current admin session so its authority is explicit',
    },
  );
}

export function canReceiveBroadcast(
  runtime: GatewayAuthRuntime,
  state: ClientState,
  event: string,
): boolean {
  const resolution = runtime.resolver.resolveSessionPrincipal(state);
  if (!resolution.ok) return false;
  const principal = resolution.principal;
  if (isAdminPrincipal(principal)) return true;
  if (!hasRole(principal, 'operator')) return false;
  return /^(?:run\.|queue\.|backlog\.|workGraph\.|node\.health|fleet\.node)/u.test(event);
}

function denial(
  runtime: GatewayAuthRuntime,
  session: GatewayAuthSession,
  method: string,
  principal: Principal,
  reason?: string,
): GatewayMethodError {
  const displayName = principal.subject.displayName;
  const roles =
    principal.roles.length > 0
      ? principal.roles.map((binding) => `${binding.role}, ${binding.scope.kind}`).join('; ')
      : 'no roles';
  const credentialName =
    session.authentication?.kind === 'credential'
      ? runtime.store.findCredential(session.authentication.credentialId)?.displayName
      : undefined;
  if (reason) {
    return new GatewayMethodError(
      'AUTH_FORBIDDEN',
      `Denied: ${method} is not available to your authority on this gateway. ` +
        `It is not on the proven-conformant allowlist: ${reason}. ` +
        `Your ${credentialName ? `credential '${credentialName}' ` : ''}authenticates as principal '${displayName}' (${roles}).`,
      { userAction: 'ask the gateway owner to run it' },
    );
  }
  return new GatewayMethodError(
    'AUTH_FORBIDDEN',
    `Denied: ${method} requires the admin role on this gateway. ` +
      `Your ${credentialName ? `credential '${credentialName}' ` : ''}authenticates as principal '${displayName}' (${roles}).`,
    {
      userAction: `ask the gateway owner to run it, or grant admin with: farmslot principal grant ${principal.id} --role admin --scope global`,
    },
  );
}

function classificationFor(
  method: string,
): { classification: 'admin' | 'operator' | 'node-subject'; reason?: string } | undefined {
  return (
    AUTHORIZATION_METHOD_CLASSIFICATION as Record<
      string,
      { classification: 'admin' | 'operator' | 'node-subject'; reason?: string }
    >
  )[method];
}

function hasRole(principal: Principal, role: 'admin' | 'operator'): boolean {
  return principal.roles.some(
    (binding) => binding.role === role && binding.scope.kind === 'global',
  );
}

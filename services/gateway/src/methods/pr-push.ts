import { resolve } from 'node:path';

import { Events, Methods } from '@farmslot/protocol';

import { farmslotRoot } from '../fleet/state.js';
import type { PRMonitoringService } from '../pr-monitoring/service.js';
import { PRPushService } from '../pr-push/service.js';
import { prPushSources } from '../pr-push/sources.js';
import { assertPushRegistration, PRPushStore } from '../pr-push/store.js';
import type { PRRuleService } from '../pr-rules/service.js';
import type { GatewayAuthRuntime } from '../security/auth.js';
import { isAdminPrincipal } from '../security/authorization.js';
import { currentSessionOriginator } from '../security/work-originator.js';

let service: PRPushService | undefined;
export async function initPRPush(
  auth: GatewayAuthRuntime,
  monitors: PRMonitoringService,
  rules: PRRuleService,
  poll: boolean,
  publish: (ownerId: string, event: string, payload: unknown) => void,
): Promise<void> {
  service?.stop();
  const authorized = (id: string) => {
    const result = auth.resolver.resolvePrincipalId(id);
    return result.ok && isAdminPrincipal(result.principal);
  };
  service = new PRPushService(
    await PRPushStore.load(resolve(farmslotRoot, '.pr-push.json')),
    authorized,
    (id) => prPushSources(id, monitors, rules, authorized),
    undefined,
    (id, value) => publish(id, Events.PR_PUSH_UPDATED, value),
    () => [
      ...monitors.store.snapshot().monitors.map((monitor) => monitor.ownerId),
      ...rules.store
        .snapshot()
        .teams.flatMap((team) => [team.ownerId, ...team.config.notificationPrincipalIds]),
    ],
    async (ownerId, sourceId) => {
      if (sourceId.startsWith('rule:')) {
        await rules.acknowledgeAction(ownerId, sourceId.slice(5));
        return;
      }
      for (const monitor of monitors.store.list(ownerId)) {
        const incident = monitor.incidents.find(
          (incident) => sourceId === `monitor:${monitor.id}:${incident.id}`,
        );
        if (incident) {
          await monitors.acknowledge(monitor.id, ownerId, monitor.revision, incident.id);
          return;
        }
      }
    },
  );
  if (poll) service.start();
}
export async function prPushMethod(method: string, value: unknown): Promise<unknown> {
  if (!service) throw new Error('PR push delivery is not initialized');
  const originator = currentSessionOriginator();
  if (originator.kind !== 'principal')
    throw new Error('An authenticated notification principal is required');
  const id = originator.principalId;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Parameters must be an object');
  const p = value as Record<string, unknown>;
  if (method === Methods.PR_PUSH_LIST) return service.list(id);
  if (method === Methods.PR_PUSH_REGISTER) {
    assertPushRegistration(p);
    return { device: await service.register(id, p) };
  }
  if (method === Methods.PR_PUSH_UNREGISTER) {
    if (typeof p.installationId !== 'string') throw new Error('installationId is required');
    await service.unregister(id, p.installationId);
    return { unregistered: true };
  }
  if (method === Methods.PR_PUSH_ACKNOWLEDGE) {
    if (typeof p.sourceId !== 'string') throw new Error('sourceId is required');
    await service.acknowledge(id, p.sourceId);
    return { acknowledged: true };
  }
  throw new Error('Unknown PR push method');
}

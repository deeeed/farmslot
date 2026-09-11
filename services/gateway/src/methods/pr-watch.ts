import { resolve } from 'node:path';

import {
  assertPRExecutionProfile,
  assertPRMonitorConfig,
  Events,
  Methods,
  monitoredPRKey,
  type PRMonitorConfig,
  type PRProjectMonitorPolicy,
} from '@farmslot/protocol';

import { initPRQueueAdmission } from '../backlog/pr-admission.js';
import { farmslotRoot, loadProjectConfig } from '../fleet/state.js';
import { PRRepairDispatcher } from '../pr-monitoring/dispatch.js';
import { verifyPRSourceAccountChange } from '../pr-monitoring/github-account.js';
import { PRPublicationEnrollment } from '../pr-monitoring/publication.js';
import { PRMonitoringService } from '../pr-monitoring/service.js';
import { PRMonitorStore } from '../pr-monitoring/store.js';
import type { GatewayAuthRuntime } from '../security/auth.js';
import { isAdminPrincipal } from '../security/authorization.js';
import { currentSessionOriginator } from '../security/work-originator.js';

let service: PRMonitoringService | undefined;
let dispatcher: PRRepairDispatcher | undefined;
let enrollment: PRPublicationEnrollment | undefined;
let publishPolicy: ((ownerId: string, policy: PRProjectMonitorPolicy) => void) | undefined;

export function initPRMonitorDispatch(
  auth: GatewayAuthRuntime,
  publish: (ownerId: string, event: string, payload: unknown) => void,
  poll: boolean,
): void {
  if (!service) throw new Error('PR monitoring must be initialized before repair dispatch');
  const monitoring = service;
  dispatcher?.stop();
  dispatcher = new PRRepairDispatcher(
    service.store,
    service,
    (ownerId) => {
      const owner = auth.resolver.resolvePrincipalId(ownerId);
      return owner.ok && isAdminPrincipal(owner.principal);
    },
    (monitor) =>
      publish(monitor.ownerId, Events.PR_WATCH_UPDATED, { monitor: monitoring.present(monitor) }),
  );
  initPRQueueAdmission('repair', dispatcher);
  enrollment?.stop();
  enrollment = new PRPublicationEnrollment(service.store, service, (ownerId) => {
    const owner = auth.resolver.resolvePrincipalId(ownerId);
    return owner.ok && isAdminPrincipal(owner.principal);
  });
  if (poll) dispatcher.start();
  if (poll) enrollment.start();
}

export async function initPRMonitoring(
  auth: GatewayAuthRuntime,
  publish: (ownerId: string, event: string, payload: unknown) => void,
  poll: boolean,
): Promise<PRMonitoringService> {
  publishPolicy = (ownerId, policy) => publish(ownerId, Events.PR_WATCH_POLICY_UPDATED, { policy });
  service?.stop();
  const store = await PRMonitorStore.load(resolve(farmslotRoot, '.pr-monitors.json'));
  const monitoring = new PRMonitoringService(
    store,
    (ownerId) => {
      const owner = auth.resolver.resolvePrincipalId(ownerId);
      return owner.ok && isAdminPrincipal(owner.principal);
    },
    (ownerId, monitor) => {
      publish(ownerId, Events.PR_WATCH_UPDATED, { monitor: monitoring.present(monitor) });
      if (poll) dispatcher?.wake();
    },
  );
  service = monitoring;
  if (poll) service.start();
  return service;
}

function params(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Parameters must be an object');
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function configuration(value: unknown): PRMonitorConfig {
  assertPRMonitorConfig(value);
  return value;
}

export async function routePRWatchMethod(
  method: string,
  value: unknown,
): Promise<{ handled: boolean; value?: unknown }> {
  if (
    !new Set<string>([
      Methods.PR_WATCH_LIST,
      Methods.PR_WATCH_GET,
      Methods.PR_WATCH_SUBSCRIBE,
      Methods.PR_WATCH_CONFIGURE,
      Methods.PR_WATCH_LIFECYCLE,
      Methods.PR_WATCH_ACKNOWLEDGE,
      Methods.PR_WATCH_REFRESH,
      Methods.PR_WATCH_REPAIR,
      Methods.PR_WATCH_PROJECT_POLICY_SET,
    ]).has(method)
  )
    return { handled: false };
  if (!service) throw new Error('PR monitoring service is not initialized');
  const presentMonitor = service.present.bind(service);
  const originator = currentSessionOriginator();
  if (originator.kind !== 'principal')
    throw new Error('An authenticated monitoring principal is required');
  const ownerId = originator.principalId;
  const p = params(value);
  if (method === Methods.PR_WATCH_LIST)
    return {
      handled: true,
      value: {
        monitors: service.store.list(ownerId).map(presentMonitor),
        schedulerError: service.schedulerError ?? dispatcher?.error,
        projectPolicies: service.store.projectPolicies(ownerId),
        publicationErrors: enrollment?.errors(ownerId),
      },
    };
  if (method === Methods.PR_WATCH_SUBSCRIBE) {
    const config = configuration(p.config);
    const existing = service.store
      .list(ownerId)
      .find(
        (monitor) =>
          monitoredPRKey(monitor.config.pr) === monitoredPRKey(config.pr) &&
          monitor.config.account.host.toLowerCase() === config.account.host.toLowerCase() &&
          monitor.config.account.login.toLowerCase() === config.account.login.toLowerCase(),
      );
    await verifyPRSourceAccountChange(config.account, ownerId, existing?.config.account);
    return {
      handled: true,
      value: { monitor: presentMonitor(await service.subscribe(ownerId, config)) },
    };
  }
  if (method === Methods.PR_WATCH_PROJECT_POLICY_SET) {
    const project = string(p.project, 'project');
    if (typeof p.enabled !== 'boolean') throw new Error('enabled must be explicit');
    if (p.enabled && !(await loadProjectConfig(project))?.ci.repo)
      throw new Error('Project has no configured PR repository');
    if (
      p.revision !== undefined &&
      (typeof p.revision !== 'number' || !Number.isSafeInteger(p.revision) || p.revision < 1)
    )
      throw new Error('revision must be a positive integer');
    const config = params(p.config);
    if (['pr', 'project', 'teamId'].some((key) => key in config))
      throw new Error('Project policy config cannot override publication identity');
    const account = params(config.account);
    const full = {
      ...config,
      project,
      pr: { host: account.host, repo: 'validation/validation', number: 1 },
    };
    assertPRMonitorConfig(full);
    const policyConfig: PRProjectMonitorPolicy['config'] = {
      account: full.account,
      policy: full.policy,
      pollIntervalMs: full.pollIntervalMs,
      watchedChecks: full.watchedChecks,
      automaticAttemptLimit: full.automaticAttemptLimit,
      cooldownMs: full.cooldownMs,
    };
    const previousAccount = service.store
      .projectPolicies(ownerId)
      .find((policy) => policy.project === project)?.config.account;
    await verifyPRSourceAccountChange(policyConfig.account, ownerId, previousAccount);
    const policy = await service.store.saveProjectPolicy(
      ownerId,
      project,
      p.enabled,
      policyConfig,
      p.revision as number | undefined,
    );
    publishPolicy?.(ownerId, policy);
    void enrollment?.reconcile();
    return { handled: true, value: { policy } };
  }
  const id = string(p.id, 'id');
  if (method === Methods.PR_WATCH_GET)
    return { handled: true, value: { monitor: presentMonitor(service.store.get(id, ownerId)) } };
  if (method === Methods.PR_WATCH_REFRESH)
    return {
      handled: true,
      value: { monitor: presentMonitor(await service.refresh(id, ownerId)) },
    };
  if (typeof p.revision !== 'number' || !Number.isSafeInteger(p.revision) || p.revision < 1)
    throw new Error('revision must be a positive integer');
  let monitor;
  if (method === Methods.PR_WATCH_REPAIR) {
    const current = service.store.get(id, ownerId);
    const execution =
      p.execution ??
      (current.config.policy.mode === 'automatic-repair'
        ? current.config.policy.execution
        : undefined);
    assertPRExecutionProfile(execution);
    monitor = await service.requestRepair(id, ownerId, p.revision, {
      project: string(p.project ?? current.config.project, 'project'),
      execution,
    });
    dispatcher?.wake();
  } else if (method === Methods.PR_WATCH_CONFIGURE) {
    const config = configuration(p.config);
    await verifyPRSourceAccountChange(
      config.account,
      ownerId,
      service.store.get(id, ownerId).config.account,
    );
    monitor = await service.configure(id, ownerId, p.revision, config);
  } else if (method === Methods.PR_WATCH_ACKNOWLEDGE)
    monitor = await service.acknowledge(
      id,
      ownerId,
      p.revision,
      string(p.incidentId, 'incidentId'),
      p.snoozedUntil === undefined ? undefined : string(p.snoozedUntil, 'snoozedUntil'),
    );
  else {
    if (p.lifecycle !== 'active' && p.lifecycle !== 'paused' && p.lifecycle !== 'stopped')
      throw new Error('Invalid monitor lifecycle');
    monitor = await service.lifecycle(id, ownerId, p.revision, p.lifecycle);
  }
  return { handled: true, value: { monitor: presentMonitor(monitor) } };
}

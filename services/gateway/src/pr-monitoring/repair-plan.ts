import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  assertPRExecutionProfile,
  type PRExecutionProfile,
  type PRMonitor,
  type PRMonitorIncident,
  type PRMonitorRepair,
} from '@farmslot/protocol';

export interface ManualRepairSelection {
  project: string;
  execution: PRExecutionProfile;
}

export function monitorRepairIsOpen(repair: PRMonitorRepair): boolean {
  return repair.state !== 'finished' && repair.state !== 'cancelled';
}

export function automaticRepairIncidentReason(
  monitor: PRMonitor,
  incident: PRMonitorIncident,
  now = Date.now(),
): string | undefined {
  if (incident.resolvedAt || incident.handledAt) return 'Incident is already resolved or handled';
  if (incident.resumeCondition) return incident.resumeCondition;
  if (incident.snoozedUntil && Date.parse(incident.snoozedUntil) > now)
    return `Incident is snoozed until ${incident.snoozedUntil}`;
  if (incident.attemptCount >= monitor.config.automaticAttemptLimit)
    return 'Automatic repair attempt limit reached; request repair explicitly';
  if (
    incident.lastAttemptAt &&
    now < Date.parse(incident.lastAttemptAt) + monitor.config.cooldownMs
  )
    return `Repair cooldown ends at ${new Date(Date.parse(incident.lastAttemptAt) + monitor.config.cooldownMs).toISOString()}`;
  return undefined;
}

/** Mutates only the transaction's private monitor copy. Observation does not consume attempts. */
export function planMonitorRepair(
  monitor: PRMonitor,
  manual?: ManualRepairSelection,
  now = Date.now(),
): PRMonitorRepair | undefined {
  const running = monitor.repairs?.find((repair) => monitorRepairIsOpen(repair) && repair.runId);
  if (running) return running;
  const pendingManual = monitor.repairs?.find(
    (repair) => monitorRepairIsOpen(repair) && repair.mode === 'manual',
  );
  if (
    monitor.lifecycle !== 'active' ||
    monitor.observationError ||
    monitor.observation?.state !== 'open' ||
    now - Date.parse(monitor.observation.checkedAt) > monitor.config.pollIntervalMs + 60_000
  )
    return undefined;
  if (!manual && pendingManual) {
    // Preserve the operator's requested scope, pruning issues resolved while waiting.
    pendingManual.incidentIds = pendingManual.incidentIds.filter((id) =>
      monitor.incidents.some((incident) => incident.id === id && !incident.resolvedAt),
    );
    pendingManual.headSha = monitor.observation.headSha;
    return pendingManual;
  }
  const policy = monitor.config.policy;
  if (!manual && policy.mode !== 'automatic-repair') return undefined;
  const project = manual?.project ?? monitor.config.project;
  const execution =
    manual?.execution ?? (policy.mode === 'automatic-repair' ? policy.execution : undefined);
  if (!project || !execution)
    throw new Error('Repair needs a project and explicit slot/model configuration');
  assertPRExecutionProfile(execution);
  const eligible = monitor.incidents.filter((incident) => {
    if (incident.resolvedAt) return false;
    if (manual) {
      delete incident.handledAt;
      delete incident.resumeCondition;
      delete incident.snoozedUntil;
      delete incident.waitingReason;
      return true;
    }
    const reason = automaticRepairIncidentReason(monitor, incident, now);
    if (reason) {
      incident.waitingReason = reason;
      return false;
    }
    delete incident.waitingReason;
    return true;
  });
  if (!eligible.length) {
    const pending = monitor.repairs?.find(
      (repair) => monitorRepairIsOpen(repair) && !repair.runId && repair.mode === 'automatic',
    );
    if (pending) {
      pending.state = 'blocked';
      pending.waitingReason = 'No incident is currently eligible for automatic repair';
    }
    return undefined;
  }
  const existing = monitor.repairs?.find((repair) => monitorRepairIsOpen(repair));
  const request: PRMonitorRepair = existing ?? {
    id: randomUUID(),
    mode: manual ? 'manual' : 'automatic',
    state: 'pending',
    project,
    execution: structuredClone(execution),
    headSha: monitor.observation.headSha,
    incidentIds: [],
    createdAt: new Date(now).toISOString(),
  };
  if (manual) request.mode = 'manual';
  if (manual) delete request.nextAdmissionAt;
  if (manual || request.mode === 'automatic') {
    request.project = project;
    request.execution = structuredClone(execution);
  }
  request.headSha = monitor.observation.headSha;
  request.incidentIds = eligible.map((incident) => incident.id).sort();
  if (!existing) (monitor.repairs ??= []).push(request);
  return request;
}

export function monitorRepairRefusal(
  monitor: PRMonitor,
  repair: PRMonitorRepair,
): string | undefined {
  if (!monitorRepairIsOpen(repair)) return 'Repair request is no longer active';
  if (repair.nextAdmissionAt && Date.parse(repair.nextAdmissionAt) > Date.now())
    return repair.waitingReason ?? `Repair admission retries at ${repair.nextAdmissionAt}`;
  if (monitor.lifecycle !== 'active') return 'Monitoring is paused or stopped';
  if (repair.mode === 'automatic' && monitor.config.policy.mode !== 'automatic-repair')
    return 'Automatic repair is disabled';
  if (
    repair.mode === 'automatic' &&
    monitor.config.policy.mode === 'automatic-repair' &&
    (repair.project !== monitor.config.project ||
      !isDeepStrictEqual(repair.execution, monitor.config.policy.execution))
  )
    return 'Repair policy changed; execution needs reconciliation';
  if (monitor.observationError)
    return `Fresh PR observations required: ${monitor.observationError}`;
  if (monitor.observation?.state !== 'open') return 'PR is not open';
  if (
    Date.now() - Date.parse(monitor.observation.checkedAt) >
    monitor.config.pollIntervalMs + 60_000
  )
    return 'PR observations are stale';
  if (!monitor.observation.repairAccess?.allowed)
    return (
      monitor.observation.repairAccess?.reason ?? 'Branch write authority has not been verified'
    );
  if (repair.headSha !== monitor.observation.headSha)
    return 'PR head changed; repair request needs reconciliation';
  for (const id of repair.incidentIds) {
    const incident = monitor.incidents.find((entry) => entry.id === id);
    if (!incident || incident.resolvedAt || incident.handledAt || incident.resumeCondition)
      return 'Repair incident set changed; reconcile queued instructions';
    if (repair.mode === 'automatic') {
      const reason = automaticRepairIncidentReason(monitor, incident);
      if (reason) return reason;
    }
  }
  if (
    !repair.incidentIds.some((id) =>
      monitor.incidents.some(
        (incident) =>
          incident.id === id &&
          !incident.resolvedAt &&
          !incident.handledAt &&
          !incident.resumeCondition,
      ),
    )
  )
    return 'No requested incident remains actionable';
  return undefined;
}

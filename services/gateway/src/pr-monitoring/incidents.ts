import { createHash } from 'node:crypto';

import type { PRMonitorIncident, PRMonitorObservation, PRMonitorSignal } from '@farmslot/protocol';

function signalIdentity(signal: PRMonitorSignal): string {
  return JSON.stringify([signal.kind, signal.key, signal.revision]);
}

function repairIssueKey(signal: PRMonitorSignal): string | undefined {
  if (signal.kind === 'check') return `check:${signal.checkName ?? signal.key}`;
  if (signal.kind === 'conflict') return 'conflict';
  return undefined;
}

export function reconcilePRMonitorIncidents(
  previous: PRMonitorIncident[],
  observation: PRMonitorObservation,
): PRMonitorIncident[] {
  const incidents = structuredClone(previous);
  const signals = observation.state === 'open' ? observation.signals : [];
  const current = new Map(signals.map((signal) => [signalIdentity(signal), signal]));
  for (const incident of incidents) {
    const checks = observation.checks?.filter((check) =>
      incident.signal.checkName
        ? check.name === incident.signal.checkName
        : check.key === incident.signal.key,
    );
    const recovered =
      incident.signal.kind === 'check'
        ? checks?.some((check) => check.status === 'passed') &&
          checks.every((check) => ['passed', 'skipped'].includes(check.status))
        : incident.signal.kind === 'conflict' && observation.mergeability === 'mergeable';
    if (recovered && !incident.repairChainClosedAt)
      incident.repairChainClosedAt = observation.checkedAt;
    const identity = signalIdentity(incident.signal);
    const signal = current.get(identity);
    if (signal) {
      incident.signal = structuredClone(signal);
      incident.lastObservedAt = observation.checkedAt;
      delete incident.resolvedAt;
      current.delete(identity);
    } else if (!incident.resolvedAt) {
      // GitHub computes mergeability asynchronously. An unknown read cannot clear a known conflict.
      if (
        observation.state === 'open' &&
        incident.signal.kind === 'conflict' &&
        observation.mergeability === 'unknown'
      )
        continue;
      if (
        observation.state === 'open' &&
        incident.signal.kind === 'check' &&
        observation.checks?.some(
          (check) => check.name === incident.signal.checkName && check.status === 'unknown',
        )
      )
        continue;
      incident.resolvedAt = observation.checkedAt;
    }
  }
  for (const [identity, signal] of current) {
    const id = createHash('sha256').update(identity).digest('hex');
    const issue = repairIssueKey(signal);
    const previous = issue
      ? [...incidents]
          .reverse()
          .find(
            (incident) =>
              !incident.repairChainClosedAt && repairIssueKey(incident.signal) === issue,
          )
      : undefined;
    incidents.push({
      id,
      signal: structuredClone(signal),
      firstObservedAt: observation.checkedAt,
      lastObservedAt: observation.checkedAt,
      attemptCount: previous?.attemptCount ?? 0,
      ...(issue ? { repairChainId: previous?.repairChainId ?? previous?.id ?? id } : {}),
      ...(previous?.lastAttemptAt ? { lastAttemptAt: previous.lastAttemptAt } : {}),
      ...(previous?.resumeCondition ? { resumeCondition: previous.resumeCondition } : {}),
    });
  }
  return incidents;
}

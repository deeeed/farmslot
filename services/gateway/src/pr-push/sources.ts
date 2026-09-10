import type { PRPushAttention } from '@farmslot/protocol';

import type { PRMonitoringService } from '../pr-monitoring/service.js';
import type { PRRuleService } from '../pr-rules/service.js';

export function prPushSources(
  principalId: string,
  monitors: PRMonitoringService,
  rules: PRRuleService,
  authorized: (id: string) => boolean,
  now = Date.now(),
): PRPushAttention[] {
  if (!authorized(principalId)) return [];
  const result: PRPushAttention[] = (rules.list(principalId).notifications ?? []).map((note) => ({
    id: `rule:${note.id}`,
    kind: 'rule',
    teamId: note.teamId,
    title: `${note.pr.repo}#${note.pr.number}`,
    body: `${note.ruleName}: ${note.reasons.join('; ')}`.slice(0, 700),
    route: `/pr-automation?notificationId=${encodeURIComponent(note.id)}`,
    createdAt: note.createdAt,
    current: note.current,
    acknowledgedAt: note.acknowledgedAt,
  }));
  const teams = rules.store.snapshot().teams;
  for (const monitor of monitors.store.snapshot().monitors) {
    if (!authorized(monitor.ownerId)) continue;
    const owner = principalId === monitor.ownerId;
    const team = teams.find(
      (team) => team.id === monitor.config.teamId && team.ownerId === monitor.ownerId,
    );
    const recipient =
      team?.config.notificationPrincipalIds.includes(principalId) &&
      team.config.account.host.toLowerCase() === monitor.config.account.host.toLowerCase() &&
      team.config.account.login.toLowerCase() === monitor.config.account.login.toLowerCase();
    if (!owner && !recipient) continue;
    for (const incident of monitor.incidents) {
      const id = `monitor:${monitor.id}:${incident.id}`;
      result.push({
        id,
        kind: 'monitor',
        teamId: monitor.config.teamId,
        title: `${monitor.config.pr.repo}#${monitor.config.pr.number}`,
        body: incident.signal.summary.slice(0, 700),
        route: `/pr-automation?monitorId=${encodeURIComponent(monitor.id)}&attentionId=${encodeURIComponent(id)}`,
        createdAt: incident.firstObservedAt,
        current:
          monitor.lifecycle === 'active' &&
          !incident.resolvedAt &&
          !incident.handledAt &&
          (!owner || !incident.snoozedUntil || Date.parse(incident.snoozedUntil) <= now),
        acknowledgedAt: owner ? incident.acknowledgedAt : undefined,
      });
    }
  }
  return result;
}

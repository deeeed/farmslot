import type { PRTeamProfile } from '@farmslot/protocol';

import type { PrincipalOwner } from '../security/work-originator.js';

export function teamNotificationAudience(teams: readonly PRTeamProfile[]): PrincipalOwner[] {
  return teams.flatMap((team) => [
    { ownerId: team.ownerId, ownerGeneration: team.ownerGeneration },
    ...team.config.notificationPrincipalIds.map((id) => ({
      ownerId: id,
      ownerGeneration: team.notificationPrincipalGenerations?.[id],
    })),
  ]);
}

import { createHash } from 'node:crypto';

import {
  monitoredPRKey,
  type PRRuleAction,
  type PRRulePreviewItem,
  type PRTeamProfile,
  type PRTriggerRule,
} from '@farmslot/protocol';

import type { PRRuleStoreData } from './store.js';

/** Called inside the rule store transaction that records source admission. */
export function admitRuleAction(
  data: PRRuleStoreData,
  team: PRTeamProfile,
  rule: PRTriggerRule,
  item: PRRulePreviewItem,
  sourceRevision: string,
  action: Exclude<PRRuleAction, { kind: 'review' }>,
  checkedAt: string,
  reserveAdmission: () => boolean,
  revalidating: boolean,
  previousActionId?: string,
  requiresFreshValidation = false,
): string | undefined {
  const id = createHash('sha256')
    .update(
      JSON.stringify([
        rule.id,
        team.config.account.host.toLowerCase(),
        team.config.account.login.toLowerCase(),
        monitoredPRKey(item.subject.pr),
        sourceRevision,
        action.kind,
      ]),
    )
    .digest('hex');
  const records = (data.actions ??= []);
  let record = records.find((entry) => entry.id === id);
  if (!record && revalidating) {
    const previous = records.find((entry) => entry.id === previousActionId);
    if (!previous) return undefined;
    if (previous.status === 'applied') {
      if (
        previous.account.host.toLowerCase() !== team.config.account.host.toLowerCase() ||
        previous.account.login.toLowerCase() !== team.config.account.login.toLowerCase()
      )
        return undefined;
      // A new fact shape is a configuration baseline, not another notification or subscription.
      previous.current = true;
      return previous.id;
    }
  }
  if ((!record || record.status === 'withdrawn') && !revalidating && !reserveAdmission())
    return undefined;
  if (!record) {
    record = {
      id,
      kind: action.kind,
      ownerId: rule.ownerId,
      ruleId: rule.id,
      ruleRevision: rule.revision,
      ruleName: rule.config.name,
      teamId: team.id,
      teamRevision: team.revision,
      teamName: team.config.name,
      account: team.config.account,
      subject: item.subject,
      sourceRevision,
      reasons: item.match.reasons,
      project: item.project,
      monitorPolicy: action.kind === 'monitor' ? action.policy : undefined,
      monitorPollIntervalMs: action.kind === 'monitor' ? action.pollIntervalMs : undefined,
      current: true,
      status: action.kind === 'notify' && !requiresFreshValidation ? 'applied' : 'pending',
      requiresFreshValidation,
      acknowledgedBy: {},
      createdAt: checkedAt,
      updatedAt: checkedAt,
    };
    records.push(record);
  } else {
    record.current = true;
    if (record.status !== 'applied') {
      Object.assign(record, {
        ruleRevision: rule.revision,
        ruleName: rule.config.name,
        teamRevision: team.revision,
        teamName: team.config.name,
        account: team.config.account,
        subject: item.subject,
        reasons: item.match.reasons,
        project: item.project,
        monitorPolicy: action.kind === 'monitor' ? action.policy : undefined,
        monitorPollIntervalMs: action.kind === 'monitor' ? action.pollIntervalMs : undefined,
        status: action.kind === 'notify' && !requiresFreshValidation ? 'applied' : 'pending',
        requiresFreshValidation,
        updatedAt: checkedAt,
      });
    }
  }
  return id;
}

export function withdrawRuleActions(
  data: PRRuleStoreData,
  ruleId: string,
  currentIds = new Set<string>(),
): void {
  for (const action of data.actions ?? []) {
    if (action.ruleId !== ruleId || currentIds.has(action.id)) continue;
    action.current = false;
    if (action.status === 'pending') {
      action.status = 'withdrawn';
      action.updatedAt = new Date().toISOString();
    }
  }
}

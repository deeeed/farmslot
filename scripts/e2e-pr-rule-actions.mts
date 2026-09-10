#!/usr/bin/env tsx
// Real source reads and gateway writes. Validation rules are disabled and monitors stopped in finally.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import type {
  FleetStatus,
  PRMonitor,
  PRRulePreviewResult,
  PRRulesListResult,
  PRRuleSaveResult,
  PRTeamSaveResult,
  PRTriggerRule,
  PRWatchListResult,
  PRRulePredicate,
} from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const repo = process.env.RULE_REPOSITORY;
const login = process.env.RULE_GITHUB_LOGIN;
const project = process.env.RULE_PROJECT;
const slotId = process.env.RULE_SLOT;
assert(
  repo && login && project && slotId,
  'Set RULE_REPOSITORY, RULE_GITHUB_LOGIN, RULE_PROJECT and RULE_SLOT',
);
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 120_000,
});
const connection = await client.connect();
const observer = await client.connect().catch((error) => {
  connection.close();
  throw error;
});
const updates: PRRulesListResult[] = [];
observer.onEvent((event) => {
  if (event.event === 'prRules.updated') updates.push(event.payload as PRRulesListResult);
});
let rule: PRTriggerRule | undefined;
let teamId: string | undefined;
let proof: Record<string, unknown> | undefined;
try {
  const { fleet } = await connection.call<{ fleet: FleetStatus }>('fleet.status');
  assert(
    fleet.slots.some((slot) => slot.slot === slotId && !slot.enabled),
    'Choose a disabled slot so even an enrollment regression cannot start a worker',
  );
  const { team } = await connection.call<PRTeamSaveResult>('prRules.teamSave', {
    config: {
      name: `Rule actions validation ${randomUUID()}`,
      account: { host: 'github.com', login },
      sources: [{ kind: 'repository', repo }],
      predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
      repositories: [{ repo, project, reviewProfile: 'actions-validation', excludedLabels: [] }],
      githubTeams: [],
      notificationPrincipalIds: [],
    },
  });
  teamId = team.id;
  const initial = await connection.call<PRRuleSaveResult>('prRules.ruleSave', {
    config: {
      name: 'Rule actions validation',
      teamId,
      predicate: { kind: 'compare', field: 'draft', operator: 'equals', value: false },
      actions: [{ kind: 'notify' }, { kind: 'monitor', policy: { mode: 'notify-only' } }],
      pollIntervalMs: 86_400_000,
      maxAdmissionsPerScan: 1,
      rereviewOnHeadChange: true,
    },
  });
  rule = initial.rule;
  const first = await connection.call<PRRulePreviewResult>('prRules.preview', { id: rule.id });
  assert(first.preview.complete, first.preview.sourceErrors.join('; '));
  const candidates = first.preview.items.filter((item) => item.match.state === 'match');
  const subject = candidates.find((item) => {
    const branch = item.subject.facts['head-branch'];
    return (
      branch?.state === 'known' &&
      typeof branch.value === 'string' &&
      candidates.filter((candidate) => {
        const other = candidate.subject.facts['head-branch'];
        return other?.state === 'known' && other.value === branch.value;
      }).length === 1
    );
  })?.subject;
  assert(subject, 'Validation needs an open, non-draft PR with a unique head branch');
  const branch = subject.facts['head-branch'];
  assert(branch?.state === 'known' && typeof branch.value === 'string');
  const predicate: PRRulePredicate = {
    kind: 'all',
    items: [
      { kind: 'compare', field: 'draft', operator: 'equals', value: false },
      { kind: 'compare', field: 'head-branch', operator: 'equals', value: branch.value },
    ],
  };
  rule = (
    await connection.call<PRRuleSaveResult>('prRules.ruleSave', {
      id: rule.id,
      revision: rule.revision,
      config: { ...rule.config, predicate },
    })
  ).rule;
  const before = await connection.call<PRRulesListResult>('prRules.list');
  const beforeMonitors = await connection.call<PRWatchListResult>('prWatch.list');
  const preview = await connection.call<PRRulePreviewResult>('prRules.preview', { id: rule.id });
  assert(preview.preview.complete, preview.preview.sourceErrors.join('; '));
  assert.equal(
    preview.preview.items.filter((item) => item.match.state === 'match').length,
    1,
    'Validation must target one PR',
  );
  const afterPreview = await observer.call<PRRulesListResult>('prRules.list');
  assert.deepEqual(afterPreview.actions, before.actions, 'Preview cannot emit action receipts');
  assert.deepEqual(afterPreview.notifications, before.notifications, 'Preview cannot notify');
  assert.equal(
    (await connection.call<PRWatchListResult>('prWatch.list')).monitors.length,
    beforeMonitors.monitors.length,
    'Preview cannot subscribe',
  );
  rule = (
    await connection.call<PRRuleSaveResult>('prRules.setEnabled', {
      id: rule.id,
      revision: rule.revision,
      enabled: true,
      backfill: false,
    })
  ).rule;
  assert(
    !(await connection.call<PRRulesListResult>('prRules.list')).actions?.some(
      (action) => action.ruleId === rule!.id,
    ),
    'Activation must baseline historical matches',
  );
  const existing = (
    await connection.call<{ monitor: PRMonitor }>('prWatch.subscribe', {
      config: {
        pr: subject.pr,
        account: team.config.account,
        teamId,
        policy: { mode: 'notify-only' },
        pollIntervalMs: 120_000,
        watchedChecks: [],
        automaticAttemptLimit: 1,
        cooldownMs: 60_000,
      },
    })
  ).monitor;
  rule = (
    await connection.call<PRRuleSaveResult>('prRules.ruleSave', {
      id: rule.id,
      revision: rule.revision,
      config: {
        ...rule.config,
        actions: [
          { kind: 'notify' },
          {
            kind: 'monitor',
            policy: {
              mode: 'automatic-repair',
              execution: {
                slotPolicy: { kind: 'exact', slotId },
                models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
              },
            },
          },
        ],
      },
    })
  ).rule;
  rule = (
    await connection.call<PRRuleSaveResult>('prRules.setEnabled', {
      id: rule.id,
      revision: rule.revision,
      enabled: true,
      backfill: true,
    })
  ).rule;
  const state = await observer.call<PRRulesListResult>('prRules.list');
  const actions = state.actions?.filter((action) => action.ruleId === rule!.id) ?? [];
  assert.equal(actions.length, 2);
  const enrollment = actions.find((action) => action.kind === 'monitor');
  const notice = actions.find((action) => action.kind === 'notify');
  assert.equal(enrollment?.status, 'applied', enrollment?.error);
  assert.equal(enrollment?.monitorId, existing.id, 'Backfill must reuse the original subscription');
  assert(notice && state.notifications?.some((item) => item.id === notice.id && item.current));
  assert(
    updates.some((update) => update.notifications?.some((item) => item.id === notice.id)),
    'A second connected client receives persisted rule attention',
  );
  const subscribed = (await connection.call<PRWatchListResult>('prWatch.list')).monitors.filter(
    (monitor) => monitor.config.teamId === teamId,
  );
  assert.equal(subscribed.length, 1);
  assert.equal(
    subscribed[0].config.policy.mode,
    'notify-only',
    'A rule cannot upgrade an existing monitor',
  );
  assert.equal(
    subscribed[0].config.pollIntervalMs,
    120_000,
    'Duplicate enrollment preserves user configuration',
  );
  assert(
    !state.intents.some((intent) =>
      intent.contributions.some((source) => source.ruleId === rule!.id),
    ),
    'Notify/monitor-only rules cannot create reviews',
  );
  if (process.env.RULE_ACK_VIA_UI === '1') {
    console.log(
      JSON.stringify({
        awaitingUiAcknowledgement: true,
        notificationId: notice.id,
        ruleId: rule.id,
        teamId: team.id,
        teamName: team.config.name,
      }),
    );
    const deadline = Date.now() + 180_000;
    let acknowledged = false;
    while (Date.now() < deadline) {
      const current = await observer.call<PRRulesListResult>('prRules.list');
      if (current.notifications?.find((item) => item.id === notice.id)?.acknowledgedAt) {
        acknowledged = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(acknowledged, 'The browser must acknowledge the persisted notification before timeout');
  } else if (process.env.RULE_LEAVE_UNACKNOWLEDGED !== '1')
    await connection.call('prRules.acknowledgeAction', { id: notice.id });
  await connection.call('prRules.scan', { id: rule.id });
  const replay = await client.call<PRRulesListResult>('prRules.list');
  assert.equal(
    replay.actions?.filter((action) => action.ruleId === rule!.id).length,
    2,
    'Replaying a scan cannot duplicate actions',
  );
  assert(
    Boolean(replay.notifications?.find((item) => item.id === notice.id)?.acknowledgedAt) ===
      (process.env.RULE_LEAVE_UNACKNOWLEDGED !== '1'),
    'Acknowledgement survives a new connection and scan replay',
  );
  proof = {
    previewNoEffects: true,
    noImplicitBackfill: true,
    existingPolicyPreserved: true,
    notificationBroadcast: true,
    acknowledgement: process.env.RULE_LEAVE_UNACKNOWLEDGED !== '1',
    replay: true,
    notificationId: notice.id,
    teamId: team.id,
    teamName: team.config.name,
    noReviewIntent: true,
    ruleId: rule.id,
    monitorId: existing.id,
  };
} finally {
  try {
    if (rule) {
      const current = (await connection.call<PRRulesListResult>('prRules.list')).rules.find(
        (item) => item.id === rule!.id,
      );
      if (current?.enabled)
        await connection.call('prRules.setEnabled', {
          id: current.id,
          revision: current.revision,
          enabled: false,
          backfill: false,
        });
    }
    if (teamId) {
      for (const monitor of (
        await connection.call<PRWatchListResult>('prWatch.list')
      ).monitors.filter((item) => item.config.teamId === teamId)) {
        if (monitor.lifecycle === 'stopped' || monitor.lifecycle === 'finished') continue;
        let current = monitor;
        for (let attempt = 0; ; attempt++) {
          try {
            await connection.call('prWatch.lifecycle', {
              id: current.id,
              revision: current.revision,
              lifecycle: 'stopped',
            });
            break;
          } catch (error) {
            if (attempt >= 4 || !/changed|revision/i.test(String(error))) throw error;
            const next = (await connection.call<PRWatchListResult>('prWatch.list')).monitors.find(
              (item) => item.id === current.id,
            );
            assert(next);
            current = next;
          }
        }
      }
    }
  } finally {
    observer.close();
    connection.close();
  }
}
console.log(JSON.stringify({ passed: true, ...proof }));

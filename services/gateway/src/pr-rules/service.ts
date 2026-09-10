import {
  assertPRMonitorConfig,
  type MonitoredPRIdentity,
  monitoredPRKey,
  type PRMonitorConfig,
  type PRReviewRequest,
  type PRReviewSubmission,
  type PRRuleActionRecord,
  type PRRulePreview,
  type PRRulesListResult,
  type PRTeamConfig,
  type PRTeamProfile,
  type PRTriggerRule,
  type PRTriggerRuleConfig,
} from '@farmslot/protocol';

import { getQueueSnapshot } from '../backlog/dispatch-queue.js';
import { resolvePRExecution } from '../backlog/pr-execution.js';
import { GitHubPRUnavailableError } from '../integrations/github-errors.js';
import type { PRMonitoringService } from '../pr-monitoring/service.js';
import { getAllRuns } from '../runs/store.js';

import {
  collectPRRuleSources,
  collectPRRuleTarget,
  collectPRSubmissionSources,
} from './github-sources.js';
import { buildPRReviewPreviewItem, buildPRRulePreview, type PRSourceScan } from './preview.js';
import type { PRSourceCheckpoints } from './source-checkpoints.js';
import type { PRRuleStore } from './store.js';

export class PRRuleService {
  private timer?: ReturnType<typeof setInterval>;
  private sweep?: Promise<void>;
  private readonly scanning = new Map<string, Promise<PRRulePreview>>();
  private readonly submissionReads = new Map<string, Promise<PRReviewSubmission>>();
  private actionDelivery?: Promise<void>;
  private previousAudience = new Set<string>();
  schedulerError?: string;

  constructor(
    readonly store: PRRuleStore,
    private readonly authorized: (ownerId: string) => boolean,
    private readonly changed: (ownerId: string) => void,
    private readonly collect: (
      team: PRTeamProfile,
      rule: PRTriggerRule,
    ) => Promise<PRSourceScan> = collectPRRuleSources,
    private readonly collectSubmission: (
      team: PRTeamProfile,
      pr: MonitoredPRIdentity,
    ) => Promise<PRSourceScan> = collectPRSubmissionSources,
    private readonly monitors?: Pick<PRMonitoringService, 'store' | 'enrolled'>,
    private readonly collectTarget: (
      team: PRTeamProfile,
      rule: PRTriggerRule,
      pr: MonitoredPRIdentity,
    ) => Promise<PRSourceScan> = collectPRRuleTarget,
    private readonly checkpoints?: Pick<PRSourceCheckpoints, 'consume' | 'current' | 'prune'>,
  ) {
    this.previousAudience = new Set(
      store
        .snapshot()
        .teams.flatMap((team) => [team.ownerId, ...team.config.notificationPrincipalIds]),
    );
  }

  start(): void {
    if (this.timer) return;
    const poll = () => {
      void this.tick().then(
        () => {
          this.schedulerError = undefined;
        },
        (error: unknown) => {
          // System failures remain visible in API status while the next scheduled sweep retries.
          this.schedulerError = error instanceof Error ? error.message : String(error);
        },
      );
    };
    this.timer = setInterval(poll, 30_000);
    this.timer.unref();
    poll();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  tick(now = Date.now()): Promise<void> {
    if (this.sweep) return this.sweep;
    this.sweep = (async () => {
      const snapshot = this.store.snapshot();
      await this.checkpoints?.prune(
        snapshot.rules.flatMap((rule) => {
          const team = snapshot.teams.find((team) => team.id === rule.config.teamId);
          return team
            ? [
                {
                  ownerId: rule.ownerId,
                  teamId: team.id,
                  teamRevision: team.revision,
                  ruleId: rule.id,
                  ruleRevision: rule.revision,
                },
              ]
            : [];
        }),
      );
      for (const rule of snapshot.rules) {
        if (!this.authorized(rule.ownerId)) continue;
        if (!rule.enabled || (rule.scan.nextScanAt && Date.parse(rule.scan.nextScanAt) > now))
          continue;
        await this.scan(rule.ownerId, rule.id);
      }
      for (const submission of this.store.snapshot().submissions ?? []) {
        if (submission.cancelledAt || !this.authorized(submission.ownerId)) continue;
        const intent = submission.intentId ? this.store.intent(submission.intentId) : undefined;
        if (intent?.runId || ['running', 'completed', 'failed'].includes(intent?.status ?? ''))
          continue;
        await this.refreshSubmission(submission.ownerId, submission.id);
      }
      await this.deliverActions();
    })().finally(() => {
      this.sweep = undefined;
    });
    return this.sweep;
  }

  async saveTeam(
    ownerId: string,
    config: PRTeamConfig,
    id?: string,
    revision?: number,
  ): Promise<PRTeamProfile> {
    this.assertAuthorized(ownerId);
    const team = await this.store.saveTeam(ownerId, config, id, revision);
    this.notifyChanges();
    return team;
  }
  async saveRule(
    ownerId: string,
    config: PRTriggerRuleConfig,
    id?: string,
    revision?: number,
  ): Promise<PRTriggerRule> {
    this.assertAuthorized(ownerId);
    const rule = await this.store.saveRule(ownerId, config, id, revision);
    this.notifyChanges();
    return rule;
  }
  async preview(ownerId: string, id: string, target?: MonitoredPRIdentity): Promise<PRRulePreview> {
    this.assertAuthorized(ownerId);
    const rule = this.store.rule(id, ownerId);
    const team = this.store.team(rule.config.teamId, ownerId);
    const result = buildPRRulePreview(
      team,
      rule,
      target ? await this.collectTarget(team, rule, target) : await this.collect(team, rule),
    );
    const validations = new Map<string, string[]>();
    const reviewAction = rule.config.actions.find((action) => action.kind === 'review');
    const monitorAction = rule.config.actions.find((action) => action.kind === 'monitor');
    for (const item of result.items) {
      const profiles = [
        ...(reviewAction && item.execution
          ? [{ kind: 'review' as const, execution: item.execution }]
          : []),
        ...(monitorAction?.policy.mode === 'automatic-repair'
          ? [{ kind: 'monitor' as const, execution: monitorAction.policy.execution }]
          : []),
      ];
      if (!item.project) continue;
      for (const profile of profiles) {
        const key = JSON.stringify([item.project, item.subject.pr.repo, profile.execution]);
        let errors = validations.get(key);
        if (!errors) {
          errors = (
            await resolvePRExecution(item.project, item.subject.pr.repo, [profile.execution])
          ).errors;
          validations.set(key, errors);
        }
        if (profile.kind === 'review') item.configurationErrors.push(...errors);
        else if (errors.length) item.actionErrors = { ...item.actionErrors, monitor: errors };
      }
    }
    this.assertAuthorized(ownerId);
    return result;
  }

  /** Route a webhook hint through source ownership checks; payload facts never admit work. */
  async routeWebhook(pr: MonitoredPRIdentity): Promise<'rules' | 'legacy' | 'unknown'> {
    const snapshot = this.store.snapshot();
    const matched: string[] = [];
    const relevant: string[] = [];
    let uncertain = false;
    for (const rule of snapshot.rules) {
      if (!rule.enabled) continue;
      const team = snapshot.teams.find((item) => item.id === rule.config.teamId);
      if (!team) {
        uncertain = true;
        continue;
      }
      if (team.config.account.host.toLowerCase() !== pr.host.toLowerCase()) continue;
      const repositorySource = team.config.sources.some(
        (source) =>
          source.kind === 'repository' && source.repo.toLowerCase() === pr.repo.toLowerCase(),
      );
      if (
        !repositorySource &&
        !team.config.sources.some((source) => source.kind === 'github-project')
      )
        continue;
      relevant.push(rule.id);
      if (!this.authorized(rule.ownerId)) {
        uncertain = true;
        continue;
      }
      if (repositorySource) {
        matched.push(rule.id);
        continue;
      }
      try {
        // Source membership and view filters own webhook routing. Team/rule
        // predicates are evaluated by the subsequent normal scan, not here.
        const scan = await this.collectTarget(
          {
            ...team,
            config: { ...team.config, predicate: { kind: 'all', items: [] }, repositories: [] },
          },
          { ...rule, config: { ...rule.config, predicate: { kind: 'all', items: [] } } },
          pr,
        );
        if (!scan.complete) {
          uncertain = true;
          continue;
        }
        if (scan.subjects.some((subject) => monitoredPRKey(subject.pr) === monitoredPRKey(pr)))
          matched.push(rule.id);
      } catch (error) {
        if (error instanceof GitHubPRUnavailableError) continue;
        // Failed membership reads must block legacy fallback; the delivery can
        // be retried after access/quota recovers and the reason stays visible.
        this.schedulerError = `Webhook source lookup failed: ${error instanceof Error ? error.message : String(error)}`;
        uncertain = true;
      }
    }
    const scheduled = await this.store.scheduleWebhookRefresh(
      snapshot,
      matched,
      this.authorized,
      relevant,
    );
    if (matched.length) this.notifyChanges();
    if (!scheduled || uncertain) return 'unknown';
    return matched.length ? 'rules' : 'legacy';
  }

  async refreshTarget(
    ownerId: string,
    id: string,
    pr: MonitoredPRIdentity,
  ): Promise<PRRulePreview> {
    const preview = await this.preview(ownerId, id, pr);
    if (preview.complete) {
      const applied = await this.store.applyPreview(
        ownerId,
        preview,
        () => this.authorized(ownerId),
        monitoredPRKey(pr),
      );
      if (!applied)
        throw new Error('Review policy changed during targeted observation; retry admission');
      this.notifyChanges();
    }
    return preview;
  }
  async enable(
    ownerId: string,
    id: string,
    revision: number,
    enabled: boolean,
    backfill: boolean,
  ): Promise<PRTriggerRule> {
    this.assertAuthorized(ownerId);
    let teamRevision: number | undefined;
    let baseline: PRRulePreview | undefined;
    if (enabled) {
      const preview = await this.preview(ownerId, id);
      teamRevision = preview.teamRevision;
      baseline = preview;
      if (!preview.complete)
        throw new Error(
          `Cannot enable incomplete source configuration: ${preview.sourceErrors.join('; ')}`,
        );
    }
    const rule = await this.store.setEnabled(
      ownerId,
      id,
      revision,
      enabled,
      backfill,
      teamRevision,
      baseline,
      () =>
        this.authorized(ownerId) &&
        (!baseline?.sourceProgress ||
          !this.checkpoints ||
          this.checkpoints.current(baseline.sourceProgress.id)),
    );
    this.notifyChanges();
    if (enabled) await this.scan(ownerId, id);
    return this.store.rule(rule.id, ownerId);
  }
  scan(ownerId: string, id: string): Promise<PRRulePreview> {
    const rule = this.store.rule(id, ownerId);
    const team = this.store.team(rule.config.teamId, ownerId);
    const key = `${ownerId}:${id}:${rule.revision}:${team.revision}`;
    const existing = this.scanning.get(key);
    if (existing) return existing;
    const work = this.scanOnce(ownerId, id).finally(() => this.scanning.delete(key));
    this.scanning.set(key, work);
    return work;
  }
  private async scanOnce(ownerId: string, id: string): Promise<PRRulePreview> {
    const rule = this.store.rule(id, ownerId);
    const team = this.store.team(rule.config.teamId, ownerId);
    let result: PRRulePreview;
    try {
      result = await this.preview(ownerId, id);
    } catch (error) {
      result = buildPRRulePreview(team, rule, {
        subjects: [],
        complete: false,
        errors: [error instanceof Error ? error.message : String(error)],
        ignoredItems: 0,
      });
    }
    const currentSource = () =>
      !result.sourceProgress ||
      !this.checkpoints ||
      this.checkpoints.current(result.sourceProgress.id);
    const applied = await this.store.applyPreview(
      ownerId,
      result,
      () => this.authorized(ownerId) && currentSource(),
    );
    if (applied && result.sourceProgress) await this.checkpoints?.consume(result.sourceProgress.id);
    await this.deliverActions();
    this.notifyChanges();
    return result;
  }
  private canReadNotification(action: PRRuleActionRecord, principalId: string): boolean {
    if (
      action.kind !== 'notify' ||
      action.status !== 'applied' ||
      !this.authorized(principalId) ||
      !this.authorized(action.ownerId)
    )
      return false;
    if (principalId === action.ownerId) return true;
    const team = this.store.snapshot().teams.find((item) => item.id === action.teamId);
    return (
      !!team?.config.notificationPrincipalIds.includes(principalId) &&
      team.config.account.host.toLowerCase() === action.account.host.toLowerCase() &&
      team.config.account.login.toLowerCase() === action.account.login.toLowerCase()
    );
  }

  list(principalId: string): PRRulesListResult {
    if (!this.authorized(principalId))
      return { teams: [], rules: [], intents: [], actions: [], notifications: [] };
    const snapshot = this.store.snapshot();
    return {
      ...this.store.list(principalId),
      notifications: (snapshot.actions ?? [])
        .filter((action) => this.canReadNotification(action, principalId))
        .map((action) => {
          const rule = snapshot.rules.find((item) => item.id === action.ruleId);
          return {
            id: action.id,
            teamId: action.teamId,
            pr: action.subject.pr,
            headSha: action.subject.headSha,
            title: action.subject.title,
            ruleName: action.ruleName,
            teamName: action.teamName,
            reasons: action.reasons,
            current: action.current && !!rule?.enabled && !rule.scan.error,
            createdAt: action.createdAt,
            acknowledgedAt: action.acknowledgedBy[principalId],
          };
        }),
    };
  }

  async acknowledgeAction(principalId: string, id: string): Promise<void> {
    this.assertAuthorized(principalId);
    await this.store.acknowledgeAction(id, principalId, () => {
      const action = this.store.action(id);
      return !!action && this.canReadNotification(action, principalId);
    });
    this.notifyChanges();
  }

  notifyChanges(): void {
    const audience = new Set(
      this.store
        .snapshot()
        .teams.flatMap((team) => [team.ownerId, ...team.config.notificationPrincipalIds]),
    );
    for (const id of new Set([...audience, ...this.previousAudience])) this.changed(id);
    this.previousAudience = audience;
  }

  deliverActions(): Promise<void> {
    if (this.actionDelivery) return this.actionDelivery;
    this.actionDelivery = this.deliverActionsOnce().finally(() => {
      this.actionDelivery = undefined;
    });
    return this.actionDelivery;
  }

  private async deliverActionsOnce(): Promise<void> {
    let validations = 0;
    const actions = this.store.snapshot().actions ?? [];
    actions.sort(
      (a, b) =>
        (a.nextValidationAt ?? '').localeCompare(b.nextValidationAt ?? '') ||
        a.createdAt.localeCompare(b.createdAt),
    );
    const startedAt = Date.now();
    for (const action of actions) {
      if (
        !this.store.actionIsCurrent(action.id) ||
        (action.nextValidationAt && Date.parse(action.nextValidationAt) > startedAt)
      )
        continue;
      const isCurrent = () => {
        const current = this.store.action(action.id);
        return (
          !this.store.admissionPending &&
          this.authorized(action.ownerId) &&
          this.store.actionIsCurrent(action.id) &&
          current?.ruleRevision === action.ruleRevision &&
          current.teamRevision === action.teamRevision
        );
      };
      if (!isCurrent()) continue;
      try {
        if (action.requiresFreshValidation) {
          if (validations++ >= 25) break;
          const fresh = await this.preview(action.ownerId, action.ruleId, action.subject.pr);
          if (!fresh.complete)
            throw new Error(
              `Fresh source observations are incomplete: ${fresh.sourceErrors.join('; ')}`,
            );
          const item = fresh.items.find(
            (item) => monitoredPRKey(item.subject.pr) === monitoredPRKey(action.subject.pr),
          );
          const valid = await this.store.validatePendingAction(action, item, () =>
            this.authorized(action.ownerId),
          );
          if (!valid || action.kind === 'notify') {
            this.notifyChanges();
            continue;
          }
        }
        if (action.kind === 'notify') continue;
        if (!this.monitors) throw new Error('PR monitoring is unavailable');
        if (!action.monitorPolicy) throw new Error('Monitor action has no policy');
        const config: PRMonitorConfig = {
          pr: action.subject.pr,
          account: action.account,
          teamId: action.teamId,
          project: action.project,
          policy: action.monitorPolicy,
          pollIntervalMs: 300_000,
          watchedChecks: [],
          automaticAttemptLimit: 2,
          cooldownMs: 900_000,
        };
        assertPRMonitorConfig(config);
        const monitor = await this.monitors.store.enrollRule(action.ownerId, config, isCurrent);
        if (!monitor) continue;
        await this.store.completeAction(action.id, { monitorId: monitor.id });
        await this.monitors.enrolled(monitor.id, action.ownerId);
      } catch (error) {
        // Keep the durable receipt actionable. Pending enrollment retries; an applied monitor owns observation errors.
        await this.store.completeAction(action.id, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.notifyChanges();
    }
  }
  async decideReview(ownerId: string, id: string, action: 'accept' | 'defer'): Promise<void> {
    this.assertAuthorized(ownerId);
    await this.store.decideReview(id, ownerId, action, assertReviewNotStarting);
    this.notifyChanges();
  }

  async submit(ownerId: string, request: PRReviewRequest): Promise<PRReviewSubmission> {
    this.assertAuthorized(ownerId);
    const submission = await this.store.submit(ownerId, request);
    this.notifyChanges();
    void this.refreshSubmission(ownerId, submission.id).catch((error: unknown) => {
      // The receipt is durable. Expose persistence/policy races while the scheduled sweep retries.
      this.schedulerError = error instanceof Error ? error.message : String(error);
      this.notifyChanges();
    });
    return submission;
  }
  async cancelSubmission(
    ownerId: string,
    id: string,
    revision: number,
  ): Promise<PRReviewSubmission> {
    this.assertAuthorized(ownerId);
    const submission = await this.store.cancelSubmission(
      ownerId,
      id,
      revision,
      assertReviewNotStarting,
    );
    this.notifyChanges();
    return submission;
  }
  refreshSubmission(ownerId: string, id: string): Promise<PRReviewSubmission> {
    const key = `${ownerId}:${id}`;
    const existing = this.submissionReads.get(key);
    if (existing) return existing;
    const work = this.refreshSubmissionOnce(ownerId, id).finally(() =>
      this.submissionReads.delete(key),
    );
    this.submissionReads.set(key, work);
    return work;
  }
  private async refreshSubmissionOnce(ownerId: string, id: string): Promise<PRReviewSubmission> {
    const submission = this.store.submission(id, ownerId);
    if (submission.cancelledAt) return submission;
    const intent = submission.intentId ? this.store.intent(submission.intentId) : undefined;
    if (intent?.runId || ['running', 'completed', 'failed'].includes(intent?.status ?? ''))
      return submission;
    const team = this.store.team(submission.request.teamId, ownerId);
    let result: Parameters<PRRuleStore['applySubmission']>[4];
    try {
      this.assertAuthorized(ownerId);
      const scan = await this.collectSubmission(team, submission.request.pr);
      if (!scan.complete || scan.subjects.length !== 1)
        throw new Error(scan.errors.join('; ') || 'Requested PR observation is incomplete');
      const item = buildPRReviewPreviewItem(
        team,
        scan.subjects[0],
        {
          kind: 'all',
          items: [
            { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
            { kind: 'compare', field: 'draft', operator: 'equals', value: false },
          ],
        },
        {
          kind: 'review',
          autoStart: submission.request.autoStart,
          execution: submission.request.execution,
          review: submission.request.review,
        },
      );
      if (item.project && item.execution)
        item.configurationErrors.push(
          ...(await resolvePRExecution(item.project, item.subject.pr.repo, [item.execution]))
            .errors,
        );
      this.assertAuthorized(ownerId);
      result = { item };
    } catch (error) {
      // Keep the durable request actionable and withdraw stale admission while source access recovers.
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    const current = await this.store.applySubmission(
      ownerId,
      id,
      submission.revision,
      team.revision,
      result,
    );
    this.notifyChanges();
    return current;
  }
  private assertAuthorized(ownerId: string): void {
    if (!this.authorized(ownerId)) throw new Error('Rule owner no longer has automation authority');
  }
}

function assertReviewNotStarting(intentId: string): void {
  if (
    getAllRuns().some((run) => run.prWork?.kind === 'review' && run.prWork.sourceId === intentId) ||
    getQueueSnapshot().some(
      (item) =>
        item.prWork?.kind === 'review' &&
        item.prWork.sourceId === intentId &&
        item.status === 'dispatching',
    )
  )
    throw new Error('Review execution is already starting; use the linked run controls');
}

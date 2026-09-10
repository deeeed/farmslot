import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import {
  assertPRReviewRequest,
  assertPRTeamConfig,
  assertPRTriggerRuleConfig,
  monitoredPRKey,
  type PRReviewContribution,
  type PRReviewIntent,
  type PRReviewRequest,
  type PRReviewSubmission,
  type PRRuleActionRecord,
  type PRRulePreview,
  type PRRulePreviewItem,
  type PRTeamConfig,
  type PRTeamProfile,
  type PRTriggerRule,
  type PRTriggerRuleConfig,
} from '@farmslot/protocol';

import { writeAtomicJSON } from '../core/atomic-json.js';

import { admitRuleAction, withdrawRuleActions } from './actions.js';
import { reconcileReviewIntent, reviewIntentId, reviewSubjectRevision } from './intents.js';
import { decodePRRuleStore } from './store-schema.js';
import { applyReviewSubmission, createReviewSubmission } from './submissions.js';

export interface PRRuleStoreData {
  version: 1;
  teams: PRTeamProfile[];
  rules: PRTriggerRule[];
  intents: PRReviewIntent[];
  submissions?: PRReviewSubmission[];
  actions?: PRRuleActionRecord[];
}

export class PRRuleStore {
  async scheduleWebhookRefresh(
    expected: Pick<PRRuleStoreData, 'teams' | 'rules'>,
    matchedRuleIds: string[],
    authorized: (ownerId: string) => boolean,
    relevantRuleIds: string[],
  ): Promise<boolean> {
    const revisions = (data: Pick<PRRuleStoreData, 'teams' | 'rules'>) => [
      data.teams.map((team) => [team.id, team.revision]).sort(),
      data.rules.map((rule) => [rule.id, rule.revision, rule.enabled]).sort(),
    ];
    return this.change((data) => {
      if (!isDeepStrictEqual(revisions(data), revisions(expected))) return false;
      if (data.rules.some((rule) => relevantRuleIds.includes(rule.id) && !authorized(rule.ownerId)))
        return false;
      const now = new Date().toISOString();
      for (const rule of data.rules)
        if (matchedRuleIds.includes(rule.id)) rule.scan.nextScanAt = now;
      return true;
    });
  }
  private pending: Promise<unknown> = Promise.resolve();
  private writesPending = 0;
  get admissionPending(): boolean {
    return this.writesPending > 0;
  }
  private constructor(
    private readonly file: string,
    private data: PRRuleStoreData,
  ) {}

  static async load(file: string): Promise<PRRuleStore> {
    let contents: string;
    try {
      contents = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // No rule store exists before the first profile is saved; other load failures are fatal.
      return new PRRuleStore(file, { version: 1, teams: [], rules: [], intents: [] });
    }
    return new PRRuleStore(file, decodePRRuleStore(JSON.parse(contents)));
  }

  snapshot(): PRRuleStoreData {
    return structuredClone(this.data);
  }
  list(ownerId: string): PRRuleStoreData {
    return structuredClone({
      version: 1,
      teams: this.data.teams.filter((item) => item.ownerId === ownerId),
      rules: this.data.rules.filter((item) => item.ownerId === ownerId),
      submissions: this.data.submissions?.filter((item) => item.ownerId === ownerId),
      actions: this.data.actions?.filter((item) => item.ownerId === ownerId),
      intents: this.data.intents
        .filter((item) => item.contributions.some((source) => source.ownerId === ownerId))
        .map((item) => ({
          ...item,
          contributions: item.contributions.filter((source) => source.ownerId === ownerId),
        })),
    });
  }
  team(id: string, ownerId: string): PRTeamProfile {
    const team = this.data.teams.find((item) => item.id === id && item.ownerId === ownerId);
    if (!team) throw new Error('Team profile not found');
    return structuredClone(team);
  }
  rule(id: string, ownerId: string): PRTriggerRule {
    const rule = this.data.rules.find((item) => item.id === id && item.ownerId === ownerId);
    if (!rule) throw new Error('Rule not found');
    return structuredClone(rule);
  }

  intent(id: string): PRReviewIntent | undefined {
    return structuredClone(this.data.intents.find((item) => item.id === id));
  }

  action(id: string): PRRuleActionRecord | undefined {
    return structuredClone(this.data.actions?.find((item) => item.id === id));
  }

  actionIsCurrent(id: string): boolean {
    const action = this.data.actions?.find((item) => item.id === id);
    if (!action?.current || action.status !== 'pending') return false;
    const rule = this.data.rules.find((item) => item.id === action.ruleId);
    const team = this.data.teams.find((item) => item.id === action.teamId);
    const subject = rule?.scan.subjects[monitoredPRKey(action.subject.pr)];
    return (
      !!rule?.enabled &&
      !rule.scan.error &&
      rule.revision === action.ruleRevision &&
      team?.revision === action.teamRevision &&
      subject?.matched === true &&
      subject.revision === action.sourceRevision &&
      !!subject.admittedActions?.includes(action.kind)
    );
  }

  validatePendingAction(
    expected: PRRuleActionRecord,
    item: PRRulePreviewItem | undefined,
    authorized: () => boolean,
  ): Promise<boolean> {
    return this.change((data) => {
      const action = data.actions?.find((action) => action.id === expected.id);
      if (
        !authorized() ||
        !action ||
        !this.actionIsCurrent(action.id) ||
        action.ruleRevision !== expected.ruleRevision ||
        action.teamRevision !== expected.teamRevision ||
        action.sourceRevision !== expected.sourceRevision
      )
        return false;
      if (
        !item ||
        item.match.state !== 'match' ||
        reviewSubjectRevision(item) !== action.sourceRevision
      ) {
        action.status = 'withdrawn';
        action.current = false;
        action.error = 'PR facts changed before delivery; a fresh scan will reconsider the match';
        const rule = data.rules.find((rule) => rule.id === action.ruleId);
        if (rule) rule.scan.nextScanAt = new Date().toISOString();
      } else {
        action.subject = structuredClone(item.subject);
        action.reasons = [...item.match.reasons];
        if (action.kind === 'notify') action.status = 'applied';
        delete action.error;
        delete action.nextValidationAt;
      }
      action.updatedAt = new Date().toISOString();
      return action.current;
    });
  }

  completeAction(id: string, result: { monitorId: string } | { error: string }): Promise<void> {
    return this.change((data) => {
      const action = data.actions?.find((item) => item.id === id);
      if (!action) throw new Error('Rule action not found');
      if ('monitorId' in result) {
        action.monitorId = result.monitorId;
        action.status = 'applied';
        delete action.error;
        delete action.nextValidationAt;
      } else if (action.status !== 'withdrawn') {
        action.error = result.error;
        action.nextValidationAt = new Date(Date.now() + 60_000).toISOString();
      }
      action.updatedAt = new Date().toISOString();
    });
  }

  acknowledgeAction(id: string, principalId: string, canRead: () => boolean): Promise<void> {
    return this.change((data) => {
      const action = data.actions?.find((item) => item.id === id && item.kind === 'notify');
      if (!action || !canRead()) throw new Error('Notification is unavailable');
      action.acknowledgedBy[principalId] ??= new Date().toISOString();
    });
  }

  submission(id: string, ownerId: string): PRReviewSubmission {
    const found = this.data.submissions?.find((item) => item.id === id && item.ownerId === ownerId);
    if (!found) throw new Error('Review request not found');
    return structuredClone(found);
  }
  submit(ownerId: string, request: PRReviewRequest): Promise<PRReviewSubmission> {
    assertPRReviewRequest(request);
    const copy = structuredClone(request);
    return this.change((data) => createReviewSubmission(data, ownerId, copy));
  }
  cancelSubmission(
    ownerId: string,
    id: string,
    revision: number,
    assertMutable?: (intentId: string) => void,
  ): Promise<PRReviewSubmission> {
    return this.change((data) => {
      const submission = data.submissions?.find(
        (item) => item.id === id && item.ownerId === ownerId,
      );
      if (!submission || submission.revision !== revision)
        throw new Error('Review request changed or is unavailable; refresh before cancelling');
      const linked = data.intents.find((item) => item.id === submission.intentId);
      if (linked) assertMutable?.(linked.id);
      if (linked?.runId || linked?.status === 'running')
        throw new Error('Use the linked run controls after review execution starts');
      if (submission.cancelledAt) return submission;
      submission.cancelledAt = new Date().toISOString();
      submission.updatedAt = submission.cancelledAt;
      submission.revision += 1;
      for (const intent of data.intents) {
        for (const source of intent.contributions)
          if (source.submissionId === id) source.eligible = false;
        reconcileReviewIntent(intent);
      }
      return submission;
    });
  }
  applySubmission(
    ownerId: string,
    id: string,
    revision: number,
    teamRevision: number,
    result: { item: PRRulePreviewItem } | { error: string },
  ): Promise<PRReviewSubmission> {
    const copy = structuredClone(result);
    return this.change((data) =>
      applyReviewSubmission(data, ownerId, id, revision, teamRevision, copy),
    );
  }

  decideReview(
    id: string,
    ownerId: string,
    action: 'accept' | 'defer',
    assertMutable?: (intentId: string) => void,
  ): Promise<PRReviewIntent> {
    return this.change((data) => {
      const intent = data.intents.find(
        (item) => item.id === id && item.contributions.some((source) => source.ownerId === ownerId),
      );
      if (!intent) throw new Error('Review intent not found');
      assertMutable?.(intent.id);
      if (['running', 'completed', 'failed'].includes(intent.status))
        throw new Error('Use the linked run controls for a review that has already started');
      const owned = intent.contributions.filter(
        (source) => source.ownerId === ownerId && source.eligible,
      );
      if (!owned.length) throw new Error('No current matching rule authorizes this review');
      if (action === 'accept') delete intent.dispatchHold;
      for (const source of owned) {
        const rule = data.rules.find((item) => item.id === source.ruleId);
        const submission = data.submissions?.find((item) => item.id === source.submissionId);
        const team = data.teams.find((item) => item.id === source.teamId);
        if (
          (source.ruleId !== undefined
            ? !rule?.enabled || rule.scan.error || rule.revision !== source.ruleRevision
            : !submission ||
              submission.error ||
              submission.revision !== source.submissionRevision) ||
          team?.revision !== source.teamRevision
        )
          throw new Error('Rule observations changed or are stale; scan before accepting');
        if (action === 'accept') {
          source.acceptedAt = new Date().toISOString();
          delete source.deferredAt;
        } else {
          source.deferredAt = new Date().toISOString();
          delete source.acceptedAt;
        }
      }
      intent.updatedAt = new Date().toISOString();
      reconcileReviewIntent(intent);
      return intent;
    });
  }

  updateDispatch(
    id: string,
    patch: Pick<
      Partial<PRReviewIntent>,
      'queueItemId' | 'runId' | 'status' | 'waitingReason' | 'reviewedSha' | 'dispatchHold'
    >,
  ): Promise<PRReviewIntent> {
    const update = structuredClone(patch);
    return this.change((data) => {
      const intent = data.intents.find((item) => item.id === id);
      if (!intent) throw new Error('Review intent not found');
      Object.assign(intent, update);
      intent.updatedAt = new Date().toISOString();
      return intent;
    });
  }

  saveTeam(
    ownerId: string,
    config: PRTeamConfig,
    id?: string,
    revision?: number,
  ): Promise<PRTeamProfile> {
    assertPRTeamConfig(config);
    const requested = structuredClone(config);
    return this.change((data) => {
      const existing = id
        ? data.teams.find((item) => item.id === id && item.ownerId === ownerId)
        : undefined;
      if (id && (!existing || existing.revision !== revision))
        throw new Error('Team profile changed or is unavailable; refresh before editing');
      const now = new Date().toISOString();
      const team: PRTeamProfile = {
        id: existing?.id ?? randomUUID(),
        ownerId,
        revision: (existing?.revision ?? 0) + 1,
        config: requested,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      data.teams = data.teams.filter((item) => item.id !== team.id).concat(team);
      for (const rule of data.rules.filter((item) => item.config.teamId === team.id)) {
        rule.scan.nextScanAt = now;
        if (
          existing &&
          !isDeepStrictEqual(
            [
              existing.config.account,
              existing.config.sources,
              existing.config.predicate,
              existing.config.githubTeams,
            ],
            [
              team.config.account,
              team.config.sources,
              team.config.predicate,
              team.config.githubTeams,
            ],
          )
        )
          rule.scan.rebasePending = true;
        withdrawRuleActions(data, rule.id);
      }
      // A saved profile cannot leave old constraints eligible while reconciliation is pending.
      for (const intent of data.intents) {
        for (const contribution of intent.contributions)
          if (contribution.teamId === team.id) contribution.eligible = false;
        reconcileReviewIntent(intent);
      }
      return team;
    });
  }

  saveRule(
    ownerId: string,
    config: PRTriggerRuleConfig,
    id?: string,
    revision?: number,
  ): Promise<PRTriggerRule> {
    assertPRTriggerRuleConfig(config);
    const requested = structuredClone(config);
    return this.change((data) => {
      if (!data.teams.some((item) => item.id === config.teamId && item.ownerId === ownerId))
        throw new Error('Team profile not found');
      const existing = id
        ? data.rules.find((item) => item.id === id && item.ownerId === ownerId)
        : undefined;
      if (id && (!existing || existing.revision !== revision))
        throw new Error('Rule changed or is unavailable; refresh before editing');
      if (existing && existing.config.teamId !== config.teamId)
        throw new Error('Create a new rule to change its team');
      const now = new Date().toISOString();
      const rule: PRTriggerRule = {
        id: existing?.id ?? randomUUID(),
        ownerId,
        revision: (existing?.revision ?? 0) + 1,
        config: requested,
        enabled: existing?.enabled ?? false,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        scan: existing
          ? {
              ...existing.scan,
              nextScanAt: now,
              rebasePending:
                existing.scan.rebasePending ||
                !isDeepStrictEqual(existing.config.predicate, config.predicate),
            }
          : { baselinePending: true, backfillRequested: false, subjects: {} },
      };
      data.rules = data.rules.filter((item) => item.id !== rule.id).concat(rule);
      withdrawRuleActions(data, rule.id);
      for (const intent of data.intents) {
        for (const contribution of intent.contributions)
          if (contribution.ruleId === rule.id) contribution.eligible = false;
        reconcileReviewIntent(intent);
      }
      return rule;
    });
  }

  setEnabled(
    ownerId: string,
    id: string,
    revision: number,
    enabled: boolean,
    backfill: boolean,
    expectedTeamRevision?: number,
    activationPreview?: PRRulePreview,
    authorized: () => boolean = () => true,
  ): Promise<PRTriggerRule> {
    const baseline = activationPreview && structuredClone(activationPreview);
    return this.change((data) => {
      if (!authorized())
        throw new Error('Activation authority or source generation changed; preview again');
      const rule = data.rules.find((item) => item.id === id && item.ownerId === ownerId);
      if (!rule || rule.revision !== revision)
        throw new Error('Rule changed or is unavailable; refresh before editing');
      if (
        expectedTeamRevision !== undefined &&
        data.teams.find((team) => team.id === rule.config.teamId)?.revision !== expectedTeamRevision
      )
        throw new Error('Team profile changed during activation; preview again');
      if (
        baseline &&
        (!baseline.complete ||
          baseline.ruleId !== rule.id ||
          baseline.ruleRevision !== rule.revision ||
          baseline.teamId !== rule.config.teamId ||
          baseline.teamRevision !==
            data.teams.find((team) => team.id === rule.config.teamId)?.revision)
      )
        throw new Error('Activation preview changed; preview again');
      const wasEnabled = rule.enabled;
      if (enabled && !wasEnabled && baseline && !backfill) {
        rule.scan.subjects = Object.fromEntries(
          baseline.items.map((item) => [
            monitoredPRKey(item.subject.pr),
            {
              revision: reviewSubjectRevision(item),
              matched: item.match.state === 'match',
              admitted: false,
              admittedActions: [],
              actionIds: {},
              deferredActions: [],
            },
          ]),
        );
        rule.scan.rebasePending = false;
      }
      rule.enabled = enabled;
      rule.revision += 1;
      rule.updatedAt = new Date().toISOString();
      if (enabled) {
        rule.scan.nextScanAt = rule.updatedAt;
        rule.scan.baselinePending = !wasEnabled && (!baseline || backfill);
        rule.scan.backfillRequested = backfill;
      } else {
        withdrawRuleActions(data, rule.id);
        rule.scan.backfillRequested = false;
        for (const intent of data.intents) {
          for (const contribution of intent.contributions)
            if (contribution.ruleId === id) contribution.eligible = false;
          reconcileReviewIntent(intent);
        }
      }
      return rule;
    });
  }

  applyPreview(
    ownerId: string,
    input: PRRulePreview,
    authorized: () => boolean = () => true,
    targetPRKey?: string,
  ): Promise<boolean> {
    const preview = structuredClone(input);
    return this.change((data) => {
      const rule = data.rules.find(
        (item) => item.id === preview.ruleId && item.ownerId === ownerId,
      );
      const team = data.teams.find(
        (item) => item.id === preview.teamId && item.ownerId === ownerId,
      );
      if (
        !authorized() ||
        !rule?.enabled ||
        rule.revision !== preview.ruleRevision ||
        team?.revision !== preview.teamRevision
      )
        return false;
      if (targetPRKey) {
        if (preview.items.some((item) => monitoredPRKey(item.subject.pr) !== targetPRKey))
          throw new Error('Targeted observation contains another PR');
        if (
          !data.intents.some(
            (intent) =>
              monitoredPRKey(intent.pr) === targetPRKey &&
              intent.contributions.some((source) => source.ruleId === rule.id && source.eligible),
          )
        )
          return false;
      } else {
        rule.scan.sourceProgress = preview.sourceProgress;
        rule.scan.checkedAt = preview.checkedAt;
        rule.scan.nextScanAt = new Date(
          preview.sourceProgress?.nextAttemptAt
            ? Date.parse(preview.sourceProgress.nextAttemptAt)
            : Date.parse(preview.checkedAt) + rule.config.pollIntervalMs,
        ).toISOString();
      }
      if (!preview.complete) {
        if (!targetPRKey)
          rule.scan.error = preview.sourceErrors.join('; ') || 'Source coverage is incomplete';
        return false;
      }
      if (!targetPRKey) {
        delete rule.scan.error;
        delete rule.scan.admissionWarning;
      }
      const reviewAction = rule.config.actions.find((action) => action.kind === 'review');
      const eligible = new Set<string>(
        targetPRKey
          ? data.intents
              .filter(
                (intent) =>
                  monitoredPRKey(intent.pr) !== targetPRKey &&
                  intent.contributions.some(
                    (source) => source.ruleId === rule.id && source.eligible,
                  ),
              )
              .map((intent) => intent.id)
          : [],
      );
      const currentActions = new Set<string>();
      const subjects: PRTriggerRule['scan']['subjects'] = {};
      let admissions = 0;
      for (const item of preview.items) {
        const key = monitoredPRKey(item.subject.pr);
        const revision = reviewSubjectRevision(item);
        const previous = rule.scan.subjects[key];
        const matched = item.match.state === 'match';
        subjects[key] = {
          revision,
          matched,
          admitted: false,
          admittedActions: [],
          actionIds: {},
          deferredActions: matched
            ? (previous?.deferredActions ?? []).filter((kind) =>
                rule.config.actions.some((action) => action.kind === kind),
              )
            : [],
        };
        if (!matched) continue;
        let subjectCharged = false;
        const clearDeferred = (kind: 'notify' | 'monitor' | 'review') => {
          subjects[key].deferredActions = subjects[key].deferredActions!.filter(
            (entry) => entry !== kind,
          );
        };
        const reserveAdmission = (kind: 'notify' | 'monitor' | 'review') => {
          if (subjectCharged) return true;
          if (admissions >= rule.config.maxAdmissionsPerScan) {
            if (!subjects[key].deferredActions!.includes(kind))
              subjects[key].deferredActions!.push(kind);
            return false;
          }
          subjectCharged = true;
          admissions += 1;
          return true;
        };
        const changed =
          !rule.scan.baselinePending &&
          !rule.scan.rebasePending &&
          (!previous || previous.revision !== revision);
        for (const action of rule.config.actions) {
          if (targetPRKey || action.kind === 'review') continue;
          if (
            !rule.scan.backfillRequested &&
            (rule.scan.baselinePending ||
              (!changed && !previous?.admittedActions?.includes(action.kind)))
          )
            continue;
          const actionId = admitRuleAction(
            data,
            team,
            rule,
            item,
            revision,
            action,
            preview.checkedAt,
            () => reserveAdmission(action.kind),
            !changed &&
              !rule.scan.backfillRequested &&
              !rule.scan.baselinePending &&
              !!previous?.admittedActions?.includes(action.kind),
            previous?.actionIds?.[action.kind],
            preview.sourceProgress?.resumed === true ||
              !!(
                preview.sourceProgress?.oldestObservationAt &&
                Date.now() - Date.parse(preview.sourceProgress.oldestObservationAt) >
                  rule.config.pollIntervalMs
              ),
          );
          if (actionId) {
            currentActions.add(actionId);
            subjects[key].admittedActions!.push(action.kind);
            subjects[key].actionIds![action.kind] = actionId;
            clearDeferred(action.kind);
          }
        }
        if (!reviewAction) continue;
        const state = item.subject.facts.state;
        const draft = item.subject.facts.draft;
        // Notification/monitoring predicates can include draft or closed PRs. Review execution cannot.
        if (
          state?.state !== 'known' ||
          state.value !== 'open' ||
          draft?.state !== 'known' ||
          draft.value !== false
        ) {
          clearDeferred('review');
          continue;
        }
        const id = reviewIntentId(item);
        let intent = data.intents.find((entry) => entry.id === id);
        const existing = intent?.contributions.find((source) => source.ruleId === rule.id);
        const hasPreviousReview = data.intents.some(
          (entry) =>
            (entry.status === 'completed' || entry.status === 'running') &&
            entry.reviewProfile === item.reviewProfile &&
            monitoredPRKey(entry.pr) === key &&
            entry.headSha !== item.subject.headSha &&
            entry.contributions.some((source) => source.ruleId === rule.id),
        );
        if (
          !rule.scan.backfillRequested &&
          (rule.scan.baselinePending || (!previous?.admitted && !changed))
        )
          continue;
        if (
          !existing &&
          hasPreviousReview &&
          !rule.config.rereviewOnHeadChange &&
          !rule.scan.backfillRequested
        )
          continue;
        const needsAdmission =
          !existing || (!existing.eligible && (rule.scan.backfillRequested || !previous?.admitted));
        if (needsAdmission && !reserveAdmission('review')) continue;
        if (!intent) {
          intent = {
            id,
            pr: item.subject.pr,
            headSha: item.subject.headSha,
            reviewProfile: item.reviewProfile,
            status: 'held',
            contributions: [],
            createdAt: preview.checkedAt,
            updatedAt: preview.checkedAt,
          };
          data.intents.push(intent);
        }
        const contribution: PRReviewContribution = {
          ruleId: rule.id,
          ruleRevision: rule.revision,
          teamId: team.id,
          teamRevision: team.revision,
          ownerId,
          reasons: item.match.reasons,
          project: item.project,
          execution: item.execution,
          review: item.review,
          autoStart: reviewAction.autoStart,
          eligible: true,
          configurationErrors: item.configurationErrors,
          acceptedAt:
            existing?.ruleRevision === rule.revision && existing.teamRevision === team.revision
              ? existing.acceptedAt
              : undefined,
          deferredAt:
            existing?.ruleRevision === rule.revision && existing.teamRevision === team.revision
              ? existing.deferredAt
              : undefined,
        };
        intent.contributions = intent.contributions
          .filter((source) => source.ruleId !== rule.id)
          .concat(contribution);
        intent.updatedAt = preview.checkedAt;
        eligible.add(id);
        subjects[key].admitted = true;
        subjects[key].admittedActions!.push('review');
        clearDeferred('review');
      }
      for (const intent of data.intents) {
        if (!eligible.has(intent.id))
          for (const source of intent.contributions)
            if (source.ruleId === rule.id) source.eligible = false;
        reconcileReviewIntent(intent);
      }
      if (targetPRKey) return true;
      rule.scan.subjects = subjects;
      if (Object.values(subjects).some((subject) => subject.deferredActions?.length))
        rule.scan.admissionWarning =
          'Admission limit reached; preview and request backfill for remaining matches';
      withdrawRuleActions(data, rule.id, currentActions);
      rule.scan.baselinePending = false;
      rule.scan.rebasePending = false;
      rule.scan.backfillRequested = false;
      return true;
    });
  }

  private change<T>(mutate: (data: PRRuleStoreData) => T): Promise<T> {
    this.writesPending += 1;
    const operation = async () => {
      const draft = structuredClone(this.data);
      const result = mutate(draft);
      decodePRRuleStore(draft);
      await writeAtomicJSON(this.file, draft);
      this.data = draft;
      return structuredClone(result);
    };
    // Each failure reaches its caller without publishing a partial transaction; later calls can retry.
    const result = this.pending.then(operation, operation).finally(() => {
      this.writesPending -= 1;
    });
    this.pending = result;
    return result;
  }
}

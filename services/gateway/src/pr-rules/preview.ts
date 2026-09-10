import {
  DEFAULT_PR_REVIEW_OPTIONS,
  evaluatePRRulePredicate,
  type PRRuleAction,
  type PRRulePredicate,
  type PRRulePreview,
  type PRRulePreviewItem,
  type PRRuleSourceProgress,
  type PRRuleSubject,
  type PRTeamProfile,
  type PRTriggerRule,
} from '@farmslot/protocol';

export interface PRSourceScan {
  progress?: PRRuleSourceProgress;
  subjects: PRRuleSubject[];
  complete: boolean;
  errors: string[];
  ignoredItems: number;
}

export function buildPRRulePreview(
  team: PRTeamProfile,
  rule: PRTriggerRule,
  scan: PRSourceScan,
): PRRulePreview {
  const review = rule.config.actions.find((action) => action.kind === 'review');
  const monitor = rule.config.actions.find((action) => action.kind === 'monitor');
  return {
    sourceProgress: scan.progress,
    teamId: team.id,
    teamRevision: team.revision,
    ruleId: rule.id,
    ruleRevision: rule.revision,
    checkedAt: new Date().toISOString(),
    complete: scan.complete,
    sourceErrors: scan.errors,
    ignoredItems: scan.ignoredItems,
    items: scan.subjects.map((subject) => {
      const item = buildPRReviewPreviewItem(team, subject, rule.config.predicate, review);
      if (monitor?.policy.mode === 'automatic-repair' && !item.project)
        item.actionErrors = { monitor: ['Automatic repair needs a Farmslot project mapping'] };
      return item;
    }),
  };
}

export function buildPRReviewPreviewItem(
  team: PRTeamProfile,
  subject: PRRuleSubject,
  predicate: PRRulePredicate,
  review?: Extract<PRRuleAction, { kind: 'review' }>,
): PRRulePreviewItem {
  const policy = team.config.repositories.find(
    (item) => item.repo.toLowerCase() === subject.pr.repo.toLowerCase(),
  );
  const effectivePredicate = policy?.excludedLabels.length
    ? {
        kind: 'all' as const,
        items: [
          team.config.predicate,
          predicate,
          {
            kind: 'not' as const,
            item: {
              kind: 'compare' as const,
              field: 'labels' as const,
              operator: 'contains-any' as const,
              value: policy.excludedLabels,
            },
          },
        ],
      }
    : { kind: 'all' as const, items: [team.config.predicate, predicate] };
  const execution = review?.execution ?? policy?.execution ?? team.config.execution;
  const errors = review
    ? [
        !policy?.project ? 'No Farmslot project mapping' : undefined,
        !execution ? 'No slot/model execution profile' : undefined,
      ].filter((item): item is string => item !== undefined)
    : [];
  const match = evaluatePRRulePredicate(effectivePredicate, subject);
  return {
    subject,
    match: { ...match, reasons: [...(subject.sourceReasons ?? []), ...match.reasons] },
    project: policy?.project,
    reviewProfile: policy?.reviewProfile ?? 'standard',
    execution,
    review: review?.review ?? policy?.review ?? team.config.review ?? DEFAULT_PR_REVIEW_OPTIONS,
    configurationErrors: errors,
    policySummary: repositoryPolicySummary(policy, subject),
  };
}

function repositoryPolicySummary(
  policy: PRTeamProfile['config']['repositories'][number] | undefined,
  subject: PRRuleSubject,
): string[] {
  const summary: string[] = [];
  if (policy?.approvalTarget !== undefined) {
    const count = subject.reviewPolicyFacts?.approvalCount;
    summary.push(
      typeof count === 'number'
        ? `Supplemental approvals: ${count}/${policy.approvalTarget} (${count >= policy.approvalTarget ? 'target met' : 'below target'})`
        : 'Supplemental approvals: unknown',
    );
    const decision = subject.reviewPolicyFacts?.providerReviewDecision;
    summary.push(`GitHub review requirement: ${decision ?? 'unknown'}`);
  }
  if (policy?.staleAfterDays !== undefined) {
    const lastUpdate = subject.reviewPolicyFacts?.lastActivityAt;
    const time = lastUpdate ? Date.parse(lastUpdate) : NaN;
    const observed = Date.parse(subject.observedAt);
    summary.push(
      Number.isFinite(time) && Number.isFinite(observed) && time <= observed
        ? `Activity: ${observed - time >= policy.staleAfterDays * 86_400_000 ? 'inactive' : 'recent'} (threshold ${policy.staleAfterDays} days; last update ${lastUpdate})`
        : 'Activity: unknown',
    );
  }
  return summary;
}

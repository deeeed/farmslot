import type {
  MonitoredPRIdentity,
  PRExecutionProfile,
  PRMonitorPolicy,
  PRSourceAccount,
} from './pr-monitoring.js';
import type { ReviewScope, ReviewSessionIntent, ReviewValidationDepth } from './runs.js';

/** Uses the same Continue/Fresh and review-depth choices as manual review rounds. */
export interface PRReviewOptions {
  sessionIntent: ReviewSessionIntent;
  scope: ReviewScope;
  validationDepth: ReviewValidationDepth;
  /** Wait for the compatible saved reviewer's slot, or allow a fresh session elsewhere. */
  busySession?: 'wait' | 'fresh';
}

export const DEFAULT_PR_REVIEW_OPTIONS: Readonly<PRReviewOptions> = {
  sessionIntent: 'resume',
  scope: 'incremental',
  validationDepth: 'static-code',
};

export type PRRuleField =
  | 'repository'
  | 'author'
  | 'state'
  | 'draft'
  | 'base-branch'
  | 'head-branch'
  | 'labels'
  | 'changed-paths'
  | 'author-teams'
  | 'project-memberships'
  | { projectId: string; fieldId: string; valueType: 'text' | 'number' | 'date' | 'single-select' };

export type PRRuleValue = string | number | boolean | string[] | null;

export type PRRulePredicate =
  | { kind: 'all' | 'any'; items: PRRulePredicate[] }
  | { kind: 'not'; item: PRRulePredicate }
  | {
      kind: 'compare';
      field: PRRuleField;
      operator:
        | 'equals'
        | 'one-of'
        | 'contains-any'
        | 'contains-all'
        | 'glob'
        | 'greater-than'
        | 'less-than'
        | 'is-set';
      value: PRRuleValue;
    };

export type PRRuleFact =
  | { state: 'known'; value: PRRuleValue }
  | { state: 'unknown'; reason: string };

export interface PRRuleSubject {
  pr: MonitoredPRIdentity;
  headSha: string;
  title: string;
  observedAt: string;
  /** Keyed with prRuleFieldKey; Project option IDs remain distinct from their display names. */
  facts: Record<string, PRRuleFact>;
  sourceReasons?: string[];
  /** Supplemental display observations; not changes that authorize rule admission. */
  reviewPolicyFacts?: {
    approvalCount?: number;
    providerReviewDecision?: string;
    lastActivityAt?: string;
  };
}

export interface PRRuleMatch {
  state: 'match' | 'no-match' | 'unknown';
  reasons: string[];
}

export type PRRuleSource =
  | { kind: 'repository'; repo: string }
  | {
      kind: 'github-project';
      projectId: string;
      label: string;
      url?: string;
      importedView?: PRImportedProjectView;
    };

export type PRProjectFilterTerm = { text: string } & (
  | { kind: 'predicate'; predicate: PRRulePredicate; manuallyMapped?: boolean }
  | { kind: 'constant'; value: boolean }
  | { kind: 'unmapped'; reason: string }
);

/** A reviewed snapshot of view filters. Later edits to the GitHub view require another import. */
export interface PRImportedProjectView {
  number: number;
  name: string;
  filter: string;
  terms: PRProjectFilterTerm[];
}

export interface PRProjectField {
  id: string;
  name: string;
  dataType: string;
  options?: Array<{ id: string; name: string }>;
}

export interface PRProjectCatalog {
  id: string;
  title: string;
  url: string;
  fields: PRProjectField[];
}

export interface PRRepositoryReviewPolicy {
  repo: string;
  project?: string;
  reviewProfile: string;
  review?: PRReviewOptions;
  execution?: PRExecutionProfile;
  excludedLabels: string[];
  approvalTarget?: number;
  staleAfterDays?: number;
}

export interface PRTeamConfig {
  name: string;
  account: PRSourceAccount;
  sources: PRRuleSource[];
  predicate: PRRulePredicate;
  repositories: PRRepositoryReviewPolicy[];
  execution?: PRExecutionProfile;
  review?: PRReviewOptions;
  /** GitHub membership checks are limited to these explicit org/team slugs. */
  githubTeams: string[];
  /** Audience selection never grants gateway or repository access. */
  notificationPrincipalIds: string[];
}

export interface PRTeamProfile {
  id: string;
  ownerId: string;
  revision: number;
  config: PRTeamConfig;
  createdAt: string;
  updatedAt: string;
}

export type PRRuleAction =
  | { kind: 'notify' }
  | { kind: 'monitor'; policy: PRMonitorPolicy }
  | {
      kind: 'review';
      autoStart: boolean;
      execution?: PRExecutionProfile;
      review?: PRReviewOptions;
    };

export interface PRTriggerRuleConfig {
  name: string;
  teamId: string;
  predicate: PRRulePredicate;
  actions: PRRuleAction[];
  pollIntervalMs: number;
  maxAdmissionsPerScan: number;
  rereviewOnHeadChange: boolean;
}

export interface PRRuleSourceProgress {
  id: string;
  startedAt: string;
  oldestObservationAt?: string;
  completedAt?: string;
  pages: number;
  items: number;
  pendingConnections: number;
  requestsThisAttempt: number;
  resumed: boolean;
  nextAttemptAt?: string;
}

export interface PRRuleScanState {
  sourceProgress?: PRRuleSourceProgress;
  baselinePending: boolean;
  /** Changed source/fact configuration needs a new baseline, while already-admitted work is revalidated. */
  rebasePending?: boolean;
  backfillRequested: boolean;
  checkedAt?: string;
  nextScanAt?: string;
  error?: string;
  admissionWarning?: string;
  /** Baseline revisions prevent enabling/editing a rule from silently backfilling old matches. */
  subjects: Record<
    string,
    {
      revision: string;
      matched: boolean;
      admitted: boolean;
      admittedActions?: Array<PRRuleAction['kind']>;
      actionIds?: Partial<Record<'notify' | 'monitor', string>>;
      deferredActions?: Array<PRRuleAction['kind']>;
    }
  >;
}

/** Durable non-worker actions. Completed monitor enrollment never changes an existing policy. */
export interface PRRuleActionRecord {
  id: string;
  kind: 'notify' | 'monitor';
  requiresFreshValidation?: boolean;
  nextValidationAt?: string;
  ownerId: string;
  ruleId: string;
  ruleRevision: number;
  ruleName: string;
  teamId: string;
  teamRevision: number;
  teamName: string;
  account: PRSourceAccount;
  subject: PRRuleSubject;
  sourceRevision: string;
  reasons: string[];
  project?: string;
  monitorPolicy?: PRMonitorPolicy;
  current: boolean;
  status: 'pending' | 'applied' | 'withdrawn';
  monitorId?: string;
  error?: string;
  acknowledgedBy: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** Audience-filtered attention, independent of optional push delivery. */
export interface PRRuleNotification {
  id: string;
  teamId: string;
  pr: MonitoredPRIdentity;
  headSha: string;
  title: string;
  teamName: string;
  ruleName: string;
  reasons: string[];
  current: boolean;
  createdAt: string;
  acknowledgedAt?: string;
}

export interface PRTriggerRule {
  id: string;
  ownerId: string;
  revision: number;
  config: PRTriggerRuleConfig;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  scan: PRRuleScanState;
}

export interface PRReviewRequest {
  teamId: string;
  pr: MonitoredPRIdentity;
  idempotencyKey: string;
  autoStart: boolean;
  execution?: PRExecutionProfile;
  review?: PRReviewOptions;
  /** Display/audit references only; these never confer execution authority. */
  source: { client: string; reference?: string; requester?: string };
}

export interface PRReviewSubmission {
  id: string;
  ownerId: string;
  revision: number;
  request: PRReviewRequest;
  intentId?: string;
  /** Gateway-frozen execution boundary at submission, before provider reads. */
  priorExecutionIds?: string[];
  checkedAt?: string;
  error?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type PRReviewContribution = {
  teamId: string;
  teamRevision: number;
  ownerId: string;
  reasons: string[];
  project?: string;
  execution?: PRExecutionProfile;
  review?: PRReviewOptions;
  autoStart: boolean;
  eligible: boolean;
  configurationErrors: string[];
  acceptedAt?: string;
  deferredAt?: string;
} & (
  | { ruleId: string; ruleRevision: number; submissionId?: never; submissionRevision?: never }
  | { submissionId: string; submissionRevision: number; ruleId?: never; ruleRevision?: never }
);

export interface PRReviewIntent {
  id: string;
  /** Explicit resubmission after execution starts creates another round for this head/profile. */
  round?: number;
  pr: MonitoredPRIdentity;
  headSha: string;
  reviewProfile: string;
  status:
    | 'held'
    | 'needs-configuration'
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'withdrawn';
  contributions: PRReviewContribution[];
  createdAt: string;
  updatedAt: string;
  waitingReason?: string;
  queueItemId?: string;
  runId?: string;
  reviewedSha?: string;
  dispatchHold?: string;
}

export interface PRRulePreviewItem {
  subject: PRRuleSubject;
  match: PRRuleMatch;
  project?: string;
  reviewProfile: string;
  execution?: PRExecutionProfile;
  review?: PRReviewOptions;
  configurationErrors: string[];
  actionErrors?: Partial<Record<PRRuleAction['kind'], string[]>>;
  /** Supplemental team policy observations; never merge authority. */
  policySummary?: string[];
}

export interface PRRulePreview {
  sourceProgress?: PRRuleSourceProgress;
  teamId: string;
  teamRevision: number;
  ruleId: string;
  ruleRevision: number;
  checkedAt: string;
  complete: boolean;
  sourceErrors: string[];
  ignoredItems: number;
  items: PRRulePreviewItem[];
}

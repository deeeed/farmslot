import type { MonitoredPRIdentity, PRSourceAccount } from '../contracts/pr-monitoring.js';
import type {
  PRProjectCatalog,
  PRReviewIntent,
  PRReviewRequest,
  PRReviewSubmission,
  PRRuleActionRecord,
  PRRuleNotification,
  PRRulePreview,
  PRRuleSource,
  PRTeamConfig,
  PRTeamProfile,
  PRTriggerRule,
  PRTriggerRuleConfig,
} from '../contracts/pr-rules.js';

export interface PRProjectImportParams {
  account: PRSourceAccount;
  url: string;
}
export interface PRProjectImportResult {
  project: PRProjectCatalog;
  source: Extract<PRRuleSource, { kind: 'github-project' }>;
}

export interface PRRulesListResult {
  teams: PRTeamProfile[];
  rules: PRTriggerRule[];
  intents: PRReviewIntent[];
  submissions?: PRReviewSubmission[];
  actions?: PRRuleActionRecord[];
  notifications?: PRRuleNotification[];
  schedulerError?: string;
}

export interface PRReviewRequestParams {
  request: PRReviewRequest;
}
export interface PRReviewRequestResult {
  submission: PRReviewSubmission;
  intent?: PRReviewIntent;
  schedulerError?: string;
}
export interface PRReviewRequestGetParams {
  id: string;
}
export interface PRReviewRequestCancelParams extends PRReviewRequestGetParams {
  revision: number;
}
export interface PRTeamSaveParams {
  config: PRTeamConfig;
  id?: string;
  revision?: number;
}
export interface PRTeamSaveResult {
  team: PRTeamProfile;
}
export interface PRRuleSaveParams {
  config: PRTriggerRuleConfig;
  id?: string;
  revision?: number;
}
export interface PRRuleSaveResult {
  rule: PRTriggerRule;
}
export interface PRRulePreviewParams {
  id: string;
  /** Fresh eligibility check for one PR, independent of discovery traversal checkpoints. */
  pr?: MonitoredPRIdentity;
}
export interface PRReviewDecisionParams {
  id: string;
}
export interface PRReviewDecisionResult {
  intent: PRReviewIntent;
}
export interface PRRulePreviewResult {
  preview: PRRulePreview;
}
export interface PRRuleSetEnabledParams {
  id: string;
  revision: number;
  enabled: boolean;
  backfill: boolean;
}

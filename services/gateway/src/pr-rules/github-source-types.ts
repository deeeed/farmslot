import type { GitHubPage } from '../integrations/github-graphql.js';

export interface GitHubRulePR {
  id: string;
  number: number;
  title: string;
  updatedAt?: string;
  reviewDecision?: string | null;
  viewerLatestReview?: {
    state: string;
    submittedAt: string | null;
    commit: { oid: string } | null;
  } | null;
  viewerLatestReviewRequest?: { id: string } | null;
  state: string;
  isDraft: boolean;
  headRefOid: string;
  baseRefOid?: string;
  baseRefName: string;
  headRefName: string;
  author: { login: string } | null;
  repository: { nameWithOwner: string };
  labels: GitHubPage<{ name: string }>;
}

export interface GitHubProjectField {
  id: string;
  name: string;
  dataType: string;
  options?: Array<{ id: string; name: string }>;
}

export interface GitHubProjectValue {
  field: GitHubProjectField;
  text?: string;
  number?: number;
  date?: string;
  optionId?: string;
}

export interface GitHubProjectItem {
  id: string;
  isArchived: boolean;
  content: (GitHubRulePR & { __typename: string }) | null;
  fieldValues: GitHubPage<GitHubProjectValue>;
}

export const GITHUB_RULE_PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
export const GITHUB_RULE_PR_FIELDS = `id number title state updatedAt reviewDecision viewerLatestReview { state submittedAt commit { oid } } viewerLatestReviewRequest { id } isDraft headRefOid baseRefOid baseRefName headRefName author { login } repository { nameWithOwner } labels(first:20) { ${GITHUB_RULE_PAGE_INFO} nodes { name } }`;
const GITHUB_PROJECT_FIELD_COMMON = '... on ProjectV2FieldCommon { id name dataType }';
export const GITHUB_PROJECT_FIELD = `${GITHUB_PROJECT_FIELD_COMMON} ... on ProjectV2SingleSelectField { options { id name } }`;
export const GITHUB_PROJECT_VALUE_FIELDS = `
  ... on ProjectV2ItemFieldTextValue { text field { ${GITHUB_PROJECT_FIELD_COMMON} } }
  ... on ProjectV2ItemFieldNumberValue { number field { ${GITHUB_PROJECT_FIELD_COMMON} } }
  ... on ProjectV2ItemFieldDateValue { date field { ${GITHUB_PROJECT_FIELD_COMMON} } }
  ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ${GITHUB_PROJECT_FIELD_COMMON} } }
`;

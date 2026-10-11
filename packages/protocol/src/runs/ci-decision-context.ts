import type { PRCheckDetail, PRCheckSnapshot, PRStatus } from '../contracts/reviews.js';
import type { RunDecision } from '../contracts/runs.js';

export const CI_DECISION_TYPES = [
  'ci_inline_fix_blocked',
  'ci_merge_conflict',
  'ci_ci_timeout',
  'ci_review_comments',
  'ci_ci_failed',
  'ci_review_comments_early',
] as const;
export const CI_SNAPSHOT_TRIM_KEY = 'context.checkSnapshot';

export interface CICheckStateSource {
  name: string;
  state?: string;
  startedAt?: string;
  completedAt?: string;
  detailsUrl?: string;
}

const PROGRESS_STATES = new Set([
  'PENDING',
  'EXPECTED',
  'QUEUED',
  'IN_PROGRESS',
  'WAITING',
  'REQUESTED',
  'COMPLETED',
]);

/** gh's state is a conclusion when terminal, and progress otherwise. */
export function normalizeCICheckDetail(source: CICheckStateSource): PRCheckDetail {
  const state = source.state?.trim() || '';
  const concluded = Boolean(state && !PROGRESS_STATES.has(state));
  const date = (value?: string) => (value && Date.parse(value) > 0 ? value : null);
  return {
    name: source.name,
    status: concluded ? 'COMPLETED' : state || 'Not recorded',
    conclusion: concluded ? state : null,
    timestamp: date(source.completedAt) ?? date(source.startedAt),
    detailsUrl: /^https?:\/\//u.test(source.detailsUrl ?? '') ? source.detailsUrl! : null,
  };
}

/** Called only when a new gate is raised; refresh never rewrites this object. */
export function ciDecisionSnapshotContext(pr: PRStatus): Record<string, unknown> {
  return {
    prNumber: pr.pr,
    repo: pr.repo,
    ...(pr.checkSnapshot ? { checkSnapshot: structuredClone(pr.checkSnapshot) } : {}),
  };
}

export interface CICheckRowView extends Omit<PRCheckDetail, 'timestamp' | 'conclusion'> {
  conclusion: string;
  age: string;
}
export interface CICheckGroupView {
  label: string;
  state: 'loading' | 'missing' | 'unavailable' | 'available';
  age: string;
  note: string;
  rows: CICheckRowView[];
}
export interface CIDecisionCheckView {
  snapshot: CICheckGroupView;
  current: CICheckGroupView | null;
}
export interface CIDecisionCheckInput {
  decision: Pick<RunDecision, 'type' | 'context' | 'payloadTrimmed'>;
  current?: PRStatus | null;
  currentState: 'not-requested' | 'loading' | 'ready' | 'error';
  pr?: number | null;
  repo?: string | null;
  now?: number;
}

function ageLabel(timestamp: string | null, now: number): string {
  const at = timestamp ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(at) || at <= 0) return 'Not recorded';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function recordedSnapshot(value: unknown): PRCheckSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as PRCheckSnapshot;
  return typeof snapshot.pr === 'number' &&
    typeof snapshot.repo === 'string' &&
    typeof snapshot.fetchedAt === 'string' &&
    Array.isArray(snapshot.checks)
    ? snapshot
    : null;
}

export function ciDecisionCheckView(input: CIDecisionCheckInput): CIDecisionCheckView | null {
  if (!CI_DECISION_TYPES.some((type) => type === input.decision.type)) return null;
  const now = input.now ?? Date.now();
  const group = (label: string, snapshot: PRCheckSnapshot): CICheckGroupView => ({
    label,
    state: 'available',
    age: ageLabel(snapshot.fetchedAt, now),
    note: '',
    rows: snapshot.checks.map((check) => ({
      ...check,
      conclusion: check.conclusion ?? 'Not recorded',
      age: ageLabel(check.timestamp, now),
    })),
  });
  const stored = recordedSnapshot(input.decision.context?.checkSnapshot);
  const trimmed = input.decision.payloadTrimmed?.includes(CI_SNAPSHOT_TRIM_KEY);
  const legacy = input.decision.context?.checks;
  const snapshot: CICheckGroupView = stored
    ? group('Gate snapshot', stored)
    : {
        label: 'Gate snapshot',
        state: trimmed ? 'loading' : Array.isArray(legacy) ? 'available' : 'missing',
        age: 'Not recorded',
        note: trimmed ? 'Loading recorded checks…' : 'Check metadata was not recorded.',
        rows: Array.isArray(legacy)
          ? legacy
              .filter((check): check is { name: string; status: string } =>
                Boolean(
                  check && typeof check.name === 'string' && typeof check.status === 'string',
                ),
              )
              .map((check) => ({
                name: check.name,
                status: check.status,
                conclusion: 'Not recorded',
                age: 'Not recorded',
                detailsUrl: null,
              }))
          : [],
      };
  if (input.currentState === 'not-requested') return { snapshot, current: null };
  const current = input.current;
  const expectedPr = stored?.pr ?? input.decision.context?.prNumber ?? input.pr;
  const expectedRepo = stored?.repo ?? input.decision.context?.repo ?? input.repo;
  const matching =
    current &&
    (!expectedPr || current.pr === expectedPr) &&
    (typeof expectedRepo !== 'string' || current.repo.toLowerCase() === expectedRepo.toLowerCase());
  const details =
    matching &&
    current.checkSnapshot?.pr === current.pr &&
    current.checkSnapshot.repo.toLowerCase() === current.repo.toLowerCase()
      ? current.checkSnapshot
      : undefined;
  const live: CICheckGroupView = details
    ? group('Current PR checks', details)
    : {
        label: 'Current PR checks',
        state: input.currentState === 'loading' ? 'loading' : 'unavailable',
        age: 'Not recorded',
        rows: [],
        note:
          input.currentState === 'loading'
            ? 'Loading current checks…'
            : 'Current check details are unavailable.',
      };
  if (input.currentState === 'error') live.note = 'Refresh failed; retry to read current checks.';
  return { snapshot, current: live };
}

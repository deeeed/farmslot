import {
  assertPRExecutionProfile,
  assertPRMonitorConfig,
  assertPRReviewRequest,
  DEFAULT_CODEX_EFFORT,
  DEFAULT_CODEX_MODEL,
  DEFAULT_PR_REVIEW_OPTIONS,
  monitoredPRUrl,
  parseGitHubPullUrl,
  type PRExecutionProfile,
  type PRMonitor,
  type PRMonitorConfig,
  type PRProjectMonitorPolicy,
  type PRReviewOptions,
  type PRReviewRequest,
  type PRTeamProfile,
} from '@farmslot/protocol';

export function newPRExecution(): PRExecutionProfile {
  return {
    slotPolicy: { kind: 'pool', allowedSlots: [] },
    models: [{ runner: 'codex', model: DEFAULT_CODEX_MODEL, effort: DEFAULT_CODEX_EFFORT }],
  };
}
export function normalizePRExecution(profile: PRExecutionProfile): PRExecutionProfile {
  return {
    ...profile,
    models: profile.models.map((model) => ({
      ...model,
      runner: model.runner.trim(),
      model: model.model.trim(),
      effort: model.effort?.trim() || undefined,
      ...(model.allowedSlots
        ? { allowedSlots: model.allowedSlots.map((slot) => slot.trim()).filter(Boolean) }
        : {}),
    })),
  };
}
export interface PRRequestDraft {
  url: string;
  teamId: string;
  autoStart: boolean;
  overrideReview: boolean;
  overrideExecution: boolean;
  review: PRReviewOptions;
  execution: PRExecutionProfile;
}
export function newPRRequestDraft(): PRRequestDraft {
  return {
    url: '',
    teamId: '',
    autoStart: false,
    overrideReview: false,
    overrideExecution: false,
    review: { ...DEFAULT_PR_REVIEW_OPTIONS },
    execution: newPRExecution(),
  };
}
export function effectivePRRequest(draft: PRRequestDraft, teams: PRTeamProfile[]) {
  const team = teams.find((item) => item.id === draft.teamId);
  const repo = parseGitHubPullUrl(draft.url)?.repo;
  const policy = team?.config.repositories.find(
    (item) => item.repo.toLowerCase() === repo?.toLowerCase(),
  );
  return {
    project: policy?.project ?? '',
    reviewProfile: policy?.reviewProfile ?? 'standard',
    review: draft.overrideReview
      ? draft.review
      : (policy?.review ?? team?.config.review ?? DEFAULT_PR_REVIEW_OPTIONS),
    execution: draft.overrideExecution
      ? draft.execution
      : (policy?.execution ?? team?.config.execution),
  };
}
export function buildPRRequest(draft: PRRequestDraft, idempotencyKey: string): PRReviewRequest {
  const pr = parseGitHubPullUrl(draft.url);
  if (!pr) throw new Error('Enter a GitHub pull request URL');
  const request: PRReviewRequest = {
    teamId: draft.teamId,
    pr: { host: 'github.com', repo: pr.repo, number: pr.number },
    idempotencyKey,
    autoStart: draft.autoStart,
    ...(draft.overrideReview ? { review: draft.review } : {}),
    ...(draft.overrideExecution ? { execution: normalizePRExecution(draft.execution) } : {}),
    source: { client: 'companion' },
  };
  assertPRReviewRequest(request);
  return request;
}

export interface PRMonitorDraft {
  url: string;
  host: string;
  login: string;
  project: string;
  automatic: boolean;
  execution: PRExecutionProfile;
  checks: string;
  intervalSeconds: string;
  attemptLimit: string;
  cooldownMinutes: string;
  enabled: boolean;
}
export function newPRMonitorDraft(
  monitor?: PRMonitor,
  policy?: PRProjectMonitorPolicy,
): PRMonitorDraft {
  const config = monitor?.config ?? policy?.config;
  return {
    url: monitor ? monitoredPRUrl(monitor.config.pr) : '',
    host: config?.account.host ?? 'github.com',
    login: config?.account.login ?? '',
    project: monitor?.config.project ?? policy?.project ?? '',
    automatic: config?.policy.mode === 'automatic-repair',
    execution:
      config?.policy.mode === 'automatic-repair'
        ? structuredClone(config.policy.execution)
        : newPRExecution(),
    checks: config?.watchedChecks.join('\n') ?? '',
    intervalSeconds: String((config?.pollIntervalMs ?? 300_000) / 1000),
    attemptLimit: String(config?.automaticAttemptLimit ?? 3),
    cooldownMinutes: String((config?.cooldownMs ?? 900_000) / 60_000),
    enabled: policy?.enabled ?? false,
  };
}
export function buildPRMonitorConfig(
  draft: PRMonitorDraft,
  original?: PRMonitor,
  publication = false,
): PRMonitorConfig {
  const parsed = parseGitHubPullUrl(draft.url);
  if (!publication && !original && !parsed) throw new Error('Enter a GitHub pull request URL');
  if (publication && !draft.project.trim()) throw new Error('Choose a project');
  const config: PRMonitorConfig = {
    pr:
      original?.config.pr ??
      (parsed
        ? { host: 'github.com', repo: parsed.repo, number: parsed.number }
        : { host: draft.host.trim(), repo: 'validation/validation', number: 1 }),
    account: original?.config.account ?? { host: draft.host.trim(), login: draft.login.trim() },
    ...(original?.config.teamId ? { teamId: original.config.teamId } : {}),
    ...(draft.project.trim() ? { project: draft.project.trim() } : {}),
    policy: draft.automatic
      ? { mode: 'automatic-repair', execution: normalizePRExecution(draft.execution) }
      : { mode: 'notify-only' },
    pollIntervalMs: Number(draft.intervalSeconds) * 1000,
    watchedChecks: draft.checks
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean),
    automaticAttemptLimit: Number(draft.attemptLimit),
    cooldownMs: Number(draft.cooldownMinutes) * 60_000,
  };
  assertPRMonitorConfig(config);
  return config;
}
export function validatePRRepair(project: string, execution: PRExecutionProfile) {
  if (!project.trim()) throw new Error('Choose a project for repair');
  const selected = normalizePRExecution(execution);
  assertPRExecutionProfile(selected);
  return { project: project.trim(), execution: selected };
}
export function togglePRSlot(execution: PRExecutionProfile, slotId: string): PRExecutionProfile {
  const previous =
    execution.slotPolicy.kind === 'exact'
      ? [execution.slotPolicy.slotId]
      : execution.slotPolicy.allowedSlots;
  const slots = previous.includes(slotId)
    ? previous.filter((id) => id !== slotId)
    : [...previous, slotId];
  return {
    ...execution,
    slotPolicy:
      slots.length === 1
        ? { kind: 'exact', slotId: slots[0] }
        : { kind: 'pool', allowedSlots: slots },
  };
}
export function prExecutionText(profile?: PRExecutionProfile): string {
  if (!profile) return 'No execution profile configured';
  return `${profile.slotPolicy.kind === 'exact' ? profile.slotPolicy.slotId : profile.slotPolicy.allowedSlots.join(', ')} · ${profile.models.map((model) => `${model.runner}/${model.model}${model.effort ? `/${model.effort}` : ''}${model.allowedSlots?.length ? ` on ${model.allowedSlots.join(', ')}` : ''}`).join(' or ')}`;
}
export function prReviewText(options: PRReviewOptions = DEFAULT_PR_REVIEW_OPTIONS): string {
  return `${options.sessionIntent === 'resume' ? 'Continue' : 'Fresh'} · ${options.scope === 'full' ? 'Full review' : 'Changes since last review'} · ${options.validationDepth === 'full-live' ? 'Live QA' : 'Static code'} · ${options.busySession === 'fresh' ? 'Allow fresh slot when busy' : 'Wait for saved reviewer'}`;
}
export function prMonitorFreshness(monitor: PRMonitor, now = Date.now()): string {
  if (!monitor.observation) return 'Awaiting observation';
  const stale =
    now - Date.parse(monitor.observation.checkedAt) > monitor.config.pollIntervalMs + 60_000;
  return `${stale ? 'Stale observation' : 'Observed'} ${new Date(monitor.observation.checkedAt).toLocaleString()}`;
}

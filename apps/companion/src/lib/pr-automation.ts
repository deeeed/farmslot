import {
  assertPRMonitorConfig,
  assertPRReviewRequest,
  assertPRSlotExecutionProfile,
  DEFAULT_CODEX_EFFORT,
  DEFAULT_CODEX_MODEL,
  DEFAULT_PR_REVIEW_OPTIONS,
  isPRWorkspaceExecutionProfile,
  monitoredPRKey,
  monitoredPRUrl,
  parseGitHubPullUrl,
  parseGitHubRef,
  type PRExecutionProfile,
  type PRMonitor,
  type PRMonitorConfig,
  type ProjectConfig,
  type PRProjectMonitorPolicy,
  type PRReviewIntent,
  type PRReviewOptions,
  type PRReviewRequest,
  prReviewWorkflow,
  type PRSlotExecutionProfile,
  type PRTeamProfile,
  resolvePRWorkflowDefaults,
  reviewResultForRun,
  type Run,
} from '@farmslot/protocol';

export function newPRExecution(): PRSlotExecutionProfile {
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
  qaInputsText?: string;
  sourceReview?: { runId: string; url: string };
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
export function effectivePRRequest(
  draft: PRRequestDraft,
  teams: PRTeamProfile[],
  farms: Pick<ProjectConfig, 'name' | 'qa' | 'workflowDefaults'>[] = [],
) {
  const team = teams.find((item) => item.id === draft.teamId);
  const repo = parseGitHubPullUrl(draft.url)?.repo;
  const policy = team?.config.repositories.find(
    (item) => item.repo.toLowerCase() === repo?.toLowerCase(),
  );
  const farm = farms.find((item) => item.name === policy?.project);
  const resolved = resolvePRWorkflowDefaults({
    request: { review: draft.overrideReview ? draft.review : undefined },
    repository: policy,
    team: team?.config,
    farm: farm?.workflowDefaults,
  });
  const profile = farm?.qa?.profiles.find(
    (item) => item.id === (resolved.review.qaProfileId ?? farm.qa?.default_profile),
  );
  return {
    project: policy?.project ?? '',
    reviewProfile: policy?.reviewProfile ?? 'standard',
    review: resolved.review,
    execution: draft.overrideExecution ? draft.execution : resolved.execution,
    sources: resolved.sources,
    qa: farm?.qa,
    qaInputs: { ...profile?.inputs, ...resolved.review.qaInputs },
  };
}

export function updatePRReviewOptions(
  value: PRReviewOptions,
  patch: Partial<PRReviewOptions>,
): PRReviewOptions {
  const { validationDepth: _legacy, ...current } = value;
  const next = { ...current, workflow: prReviewWorkflow(value), ...patch };
  if (next.workflow === 'qa') {
    delete next.publishReview;
    next.sessionIntent = 'reset';
    next.scope = 'full';
    delete next.busySession;
  } else {
    delete next.qaProfileId;
    delete next.qaInputs;
  }
  return next;
}

export function buildPRRequest(draft: PRRequestDraft, idempotencyKey: string): PRReviewRequest {
  const pr = parseGitHubPullUrl(draft.url);
  if (!pr) throw new Error('Enter a GitHub pull request URL');
  let review = draft.overrideReview ? draft.review : undefined;
  if (review && prReviewWorkflow(review) === 'qa' && draft.qaInputsText !== undefined) {
    const inputs: unknown = JSON.parse(draft.qaInputsText);
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs))
      throw new Error('QA inputs must be a JSON object');
    review = { ...review, qaInputs: inputs as PRReviewOptions['qaInputs'] };
  }
  const request: PRReviewRequest = {
    teamId: draft.teamId,
    pr: { host: 'github.com', repo: pr.repo, number: pr.number },
    idempotencyKey,
    autoStart: draft.autoStart,
    ...(review ? { review } : {}),
    ...(draft.overrideExecution ? { execution: normalizePRExecution(draft.execution) } : {}),
    ...(review && prReviewWorkflow(review) === 'qa' && draft.sourceReview?.url === draft.url
      ? { sourceReviewRunId: draft.sourceReview.runId }
      : {}),
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
  const repairExecution = normalizePRExecution(draft.execution);
  let policy: PRMonitorConfig['policy'] = { mode: 'notify-only' };
  if (draft.automatic) {
    assertPRSlotExecutionProfile(repairExecution);
    policy = { mode: 'automatic-repair', execution: repairExecution };
  }
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
    policy,
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
  assertPRSlotExecutionProfile(selected);
  return { project: project.trim(), execution: selected };
}
export function togglePRSlot(execution: PRExecutionProfile, slotId: string): PRExecutionProfile {
  if (isPRWorkspaceExecutionProfile(execution))
    throw new Error('Workspace review cannot select a device slot');
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
  if (isPRWorkspaceExecutionProfile(profile)) {
    const machines =
      profile.workspacePolicy.kind === 'exact'
        ? profile.workspacePolicy.machine
        : profile.workspacePolicy.allowedMachines.join(', ');
    return `Review machines: ${machines} · ${profile.models.map((model) => `${model.runner}/${model.model}`).join(' or ')}`;
  }
  return `${profile.slotPolicy.kind === 'exact' ? profile.slotPolicy.slotId : profile.slotPolicy.allowedSlots.join(', ')} · ${profile.models.map((model) => `${model.runner}/${model.model}${model.effort ? `/${model.effort}` : ''}${model.allowedSlots?.length ? ` on ${model.allowedSlots.join(', ')}` : ''}`).join(' or ')}`;
}
export function prReviewText(options: PRReviewOptions = DEFAULT_PR_REVIEW_OPTIONS): string {
  if (prReviewWorkflow(options) === 'qa') return `QA · ${options.qaProfileId ?? 'farm default'}`;
  return `${options.sessionIntent === 'resume' ? 'Continue' : 'Fresh'} · ${options.scope === 'full' ? 'Full review' : 'Changes since last review'} · Static review · ${options.publishReview === undefined ? 'Publication inherited' : options.publishReview ? 'Publish to PR' : 'Farmslot results only'}`;
}
export function prMonitorFreshness(monitor: PRMonitor, now = Date.now()): string {
  if (!monitor.observation) return 'Awaiting observation';
  const stale =
    now - Date.parse(monitor.observation.checkedAt) > monitor.config.pollIntervalMs + 60_000;
  return `${stale ? 'Stale observation' : 'Observed'} ${new Date(monitor.observation.checkedAt).toLocaleString()}`;
}

export function qaRequestFromReview(
  intent: PRReviewIntent,
  run: Run | undefined,
  principalId: string | null,
): PRRequestDraft {
  const draft = newPRRequestDraft();
  draft.url = monitoredPRUrl(intent.pr);
  const contribution = intent.contributions.find((source) => source.ownerId === principalId);
  draft.teamId = contribution?.teamId ?? '';
  draft.overrideReview = true;
  draft.review = updatePRReviewOptions(draft.review, { workflow: 'qa' });
  const owners = run
    ? [run.createdByPrincipalId, run.nativeOwnerPrincipalId, run.prWork?.review?.ownerId].filter(
        Boolean,
      )
    : [];
  const result = run && reviewResultForRun(run);
  const ref = run && parseGitHubRef(run.ticketOrPr);
  const pr =
    run?.prWork?.pr ??
    (ref ? { host: 'github.com', repo: ref.repo, number: ref.number } : undefined);
  if (
    run &&
    principalId &&
    owners.length &&
    owners.every((owner) => owner === principalId) &&
    intent.runId === run.id &&
    intent.status === 'completed' &&
    run.flowType === 'review-pr' &&
    run.status === 'done' &&
    !!contribution?.project &&
    run.project === contribution.project &&
    !!pr &&
    monitoredPRKey(pr) === monitoredPRKey(intent.pr) &&
    /^[a-f0-9]{40}$/.test(intent.headSha) &&
    ['github-pr', 'local-git'].includes(result?.reviewSnapshot?.source ?? '') &&
    run.reviewValidationDepth !== 'full-live' &&
    run.reviewQaContract?.legacy?.validationDepth !== 'full-live' &&
    intent.contributions.every((source) => prReviewWorkflow(source.review) === 'review') &&
    result?.reviewSnapshot?.headSha === intent.headSha &&
    result.reviewMd?.trim() &&
    !('stale' in result && result.stale)
  ) {
    draft.sourceReview = { runId: run.id, url: draft.url };
  }
  return draft;
}

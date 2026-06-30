import {
  type DiffStat,
  type EvalExperimentSource,
  type EvalPackageSource,
  type EvalTaskProfile,
  isTerminalRunStatus,
  type PRStatus,
  type Run,
} from '@farmslot/protocol';

export type EvalCaseSourceKind = EvalExperimentSource['kind'];
export type EvalCaseFilterKind = EvalCaseSourceKind | 'all';
export type EvalCaseFilterTaskProfile = EvalTaskProfile | 'all';
export interface EvalCaseCatalogItem {
  id: string;
  sourceKey: string;
  kind: EvalCaseSourceKind;
  carrierType?: string;
  carrierLabel?: string;
  source: EvalExperimentSource;
  project: string;
  label: string;
  taskProfile: EvalTaskProfile;
  objective: string;
  statusLabel: string;
  sourceStatusLabel: string;
  runStatusLabel?: string;
  suitabilityLabel: string;
  primaryDate?: string;
  primaryDateLabel?: 'merged' | 'completed' | 'updated' | 'created' | 'manual';
  sortDateMs?: number;
  primary: string;
  secondary: string;
  searchText: string;
  selectable: boolean;
  warnings: string[];
  runId?: string;
  familyId?: string;
  prNumber?: number;
  prRef?: string;
  packagePath?: string;
  prUrl?: string;
  runHref?: string;
  familyHref?: string;
  diffStat?: DiffStat;
  artifactCount?: number;
  artifactBytes?: number;
  visualEvidenceCount?: number;
  validationEvidenceCount?: number;
  reviewEvidenceCount?: number;
}

export interface EvalSelectedCase {
  selectionId: string;
  datasetItemId: string;
  sourceKey: string;
  kind: EvalCaseSourceKind;
  source: EvalExperimentSource;
  project: string;
  label: string;
  taskProfile: EvalTaskProfile;
  objective: string;
  objectiveHash: string;
  statusLabel: string;
  sourceStatusLabel: string;
  runStatusLabel?: string;
  suitabilityLabel: string;
  warnings: string[];
  runId?: string;
  familyId?: string;
  packagePath?: string;
}

export interface EvalCaseFilters {
  query: string;
  kind: EvalCaseFilterKind;
  project: string;
  taskProfile: EvalCaseFilterTaskProfile;
  status: string;
}

export type EvalCaseSortKey = 'date' | 'title' | 'kind' | 'project' | 'profile' | 'status';
export type EvalCaseSortDirection = 'asc' | 'desc';

const EVAL_RUN_FLOW_TYPES = new Set(['fix-bug', 'dev']);
const RUN_FLOW_LABELS: Record<string, string> = {
  'fix-bug': 'BUG',
  dev: 'DEV',
  'review-pr': 'REV',
  'pr-complete': 'PRC',
  'merge-main': 'MERGE',
};

function normalizedText(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

export function stableIdHash(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export function slugFor(value: string, fallback = 'item'): string {
  return (
    normalizedText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || fallback
  );
}

export function objectiveHashFor(objective: string): string {
  const normalized = normalizedText(objective);
  return normalized ? stableIdHash(normalized) : 'default';
}

export function canonicalSourceIdentity(source: EvalExperimentSource | EvalPackageSource): string {
  if (source.kind === 'merged-pr') {
    const ref = 'ref' in source ? normalizedText(source.ref) : '';
    const splitAt = ref.lastIndexOf('#');
    const repo = 'ref' in source ? (splitAt > 0 ? ref.slice(0, splitAt) : ref) : source.repo;
    const pr =
      'ref' in source ? (splitAt > 0 ? ref.slice(splitAt + 1) : '') : String(source.prNumber);
    return `merged-pr:${normalizedText(repo).toLowerCase()}#${normalizedText(pr)}`;
  }
  if (source.kind === 'prior-run') return `prior-run:${normalizedText(source.runId)}`;
  if (source.kind === 'package') {
    if ('packagePath' in source && source.packagePath)
      return `package:path:${normalizedText(source.packagePath)}`;
    const packageId = 'packageId' in source ? source.packageId : '';
    const packageHash = 'packageHash' in source ? (source.packageHash ?? '') : '';
    return `package:id:${normalizedText(packageId)}:${normalizedText(packageHash)}`;
  }
  return [
    'git-ref',
    normalizedText(source.repository).toLowerCase(),
    normalizedText(source.ref),
    normalizedText(source.baseSha),
    normalizedText(source.headSha),
  ].join(':');
}

export function datasetItemIdFor(input: {
  project?: string;
  source: EvalExperimentSource;
  taskProfile: EvalTaskProfile;
  objective: string;
}): string {
  const projectKey = normalizedText(input.project).toLowerCase() || 'project';
  const sourceKey = canonicalSourceIdentity(input.source);
  const objectiveHash = objectiveHashFor(input.objective);
  return `item-${slugFor(input.taskProfile)}-${stableIdHash(`${projectKey}|${sourceKey}|${input.taskProfile}|${objectiveHash}`)}`;
}

export function datasetIdFor(input: {
  project: string;
  datasetItemIds: readonly string[];
}): string {
  const ids = [...new Set(input.datasetItemIds)].sort();
  return `dataset-${slugFor(input.project, 'project')}-${stableIdHash(ids.join('|'))}`;
}

function taskProfileFromRun(run: Run): EvalTaskProfile {
  return run.flowType === 'dev' ? 'dev' : 'fix-bug';
}

function unsupportedRunFlowWarning(run: Run): string | null {
  return EVAL_RUN_FLOW_TYPES.has(run.flowType)
    ? null
    : `Only fix-bug and dev runs can seed eval cases; ${run.flowType} is unsupported.`;
}

function flowLabel(flowType: string): string {
  return RUN_FLOW_LABELS[flowType] ?? flowType.toUpperCase();
}

function dateMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function dateFields(
  value: string | null | undefined,
  label: EvalCaseCatalogItem['primaryDateLabel'],
) {
  const sortDateMs = dateMs(value);
  return {
    ...(value ? { primaryDate: value } : {}),
    ...(value ? { primaryDateLabel: label } : {}),
    ...(sortDateMs != null ? { sortDateMs } : {}),
  };
}

function runSearchText(run: Run): string {
  return [
    run.id,
    run.familyId,
    run.familyRootTicketOrPr,
    run.ticketOrPr,
    run.prNumber,
    run.summary,
    run.project,
    run.status,
    run.flowType,
    run.lane,
    run.variant,
    run.metrics.runner,
    run.metrics.model,
    run.metrics.actualModel,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function prSearchText(pr: PRStatus): string {
  return [
    pr.repo,
    pr.pr,
    githubPrUrl(pr.repo, pr.pr),
    pr.title,
    pr.summary,
    pr.project,
    pr.prState,
    pr.headRef,
    pr.familyRootTicketOrPr,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function githubPrUrl(repo: string, prNumber: number): string {
  return `https://github.com/${repo}/pull/${prNumber}`;
}

export function normalizeGithubPrRef(value: string | null | undefined): string {
  const trimmed = normalizedText(value);
  if (!trimmed) return '';
  const urlMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i,
  );
  if (urlMatch) return `${urlMatch[1]}#${urlMatch[2]}`;
  const shorthandMatch = trimmed.match(/^([^/\s#]+\/[^/\s#]+)#(\d+)$/);
  if (shorthandMatch) return `${shorthandMatch[1]}#${shorthandMatch[2]}`;
  return trimmed;
}

function githubPrUrlFromRef(ref: string | null | undefined): string {
  const normalized = normalizeGithubPrRef(ref);
  const match = normalized.match(/^([^/\s#]+\/[^/\s#]+)#(\d+)$/);
  return match ? githubPrUrl(match[1], Number(match[2])) : '';
}

function prNumberFromRef(ref: string | null | undefined): string {
  const normalized = normalizeGithubPrRef(ref);
  const match = normalized.match(/#(\d+)$/);
  return match?.[1] ?? '';
}

function caseSearchHaystack(item: EvalCaseCatalogItem): string {
  return [
    item.searchText,
    item.primary,
    item.secondary,
    item.label,
    item.prNumber,
    item.prRef,
    item.prUrl,
    githubPrUrlFromRef(item.prRef),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function caseSearchNeedles(query: string): string[] {
  const normalized = normalizedText(query).toLowerCase();
  if (!normalized) return [];
  const prRef = normalizeGithubPrRef(normalized).toLowerCase();
  const prUrl = githubPrUrlFromRef(prRef).toLowerCase();
  const prNumber = prNumberFromRef(prRef);
  return [...new Set([normalized, prRef, prUrl, prNumber].filter(Boolean))];
}

function githubPrUrlFromRun(run: Run): string | undefined {
  const linked = run.links?.find(
    (link) => /^pr$/i.test(link.label) && /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(link.url),
  );
  if (linked) return linked.url;
  const match = run.ticketOrPr.match(/^([^/\s#]+\/[^/\s#]+)#(\d+)$/);
  return match ? githubPrUrl(match[1], Number(match[2])) : undefined;
}

function runHref(run: Pick<Run, 'id'>): string {
  return `#run/${run.id}`;
}

function familyHref(run: Pick<Run, 'id' | 'familyId'>): string {
  return `#family/${run.familyId}?run=${encodeURIComponent(run.id)}`;
}

function diffStatFromRun(run: Run): DiffStat | undefined {
  for (const step of [...run.steps].reverse()) {
    const raw = step.outputs?.diffStat;
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Partial<DiffStat>;
    if (
      typeof row.files !== 'number' ||
      typeof row.additions !== 'number' ||
      typeof row.deletions !== 'number'
    )
      continue;
    return { files: row.files, additions: row.additions, deletions: row.deletions };
  }
  return undefined;
}

function evidenceSummaryFromRun(
  run: Run,
): Pick<
  EvalCaseCatalogItem,
  | 'artifactCount'
  | 'artifactBytes'
  | 'visualEvidenceCount'
  | 'validationEvidenceCount'
  | 'reviewEvidenceCount'
> {
  const seen = new Set<string>();
  let artifactCount = 0;
  let artifactBytes = 0;
  let visualEvidenceCount = 0;
  let validationEvidenceCount = 0;
  let reviewEvidenceCount = 0;
  for (const step of run.steps) {
    const rawArtifacts = step.outputs?.artifacts;
    if (!Array.isArray(rawArtifacts)) continue;
    for (const raw of rawArtifacts) {
      if (!raw || typeof raw !== 'object') continue;
      const artifact = raw as { path?: unknown; purpose?: unknown; sizeBytes?: unknown };
      if (typeof artifact.path !== 'string' || !artifact.path.trim()) continue;
      const key = `${step.name}:${artifact.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      artifactCount += 1;
      if (typeof artifact.sizeBytes === 'number') artifactBytes += artifact.sizeBytes;
      const purpose = typeof artifact.purpose === 'string' ? artifact.purpose.toLowerCase() : '';
      const pathLower = artifact.path.toLowerCase();
      if (
        /screenshot|video|visual/.test(purpose) ||
        /\.(png|jpe?g|gif|mp4|mov|webm)$/.test(pathLower)
      )
        visualEvidenceCount += 1;
      if (
        /recipe|validation|report|summary|trace|coverage|manifest/.test(purpose) ||
        /recipe|validation|report|summary|trace|coverage|manifest/.test(pathLower)
      )
        validationEvidenceCount += 1;
      if (/review|comment/.test(purpose) || /review|comment/.test(pathLower))
        reviewEvidenceCount += 1;
    }
  }
  return {
    artifactCount,
    artifactBytes,
    visualEvidenceCount,
    validationEvidenceCount,
    reviewEvidenceCount,
  };
}

function previewFieldsFromRun(
  run: Run,
): Pick<
  EvalCaseCatalogItem,
  | 'prUrl'
  | 'runHref'
  | 'familyHref'
  | 'diffStat'
  | 'artifactCount'
  | 'artifactBytes'
  | 'visualEvidenceCount'
  | 'validationEvidenceCount'
  | 'reviewEvidenceCount'
> {
  return {
    prUrl: githubPrUrlFromRun(run),
    runHref: runHref(run),
    familyHref: familyHref(run),
    diffStat: diffStatFromRun(run),
    ...evidenceSummaryFromRun(run),
  };
}

export function catalogItemFromPr(pr: PRStatus, latestRun?: Run): EvalCaseCatalogItem {
  const prRef = `${pr.repo}#${pr.pr}`;
  const merged = pr.merged || pr.prState === 'MERGED' || pr.recommendation === 'MERGED';
  const runFlowWarning = latestRun ? unsupportedRunFlowWarning(latestRun) : null;
  const runBacked = Boolean(
    merged && latestRun && isTerminalRunStatus(latestRun.status) && !runFlowWarning,
  );
  const source: EvalExperimentSource =
    runBacked && latestRun
      ? { kind: 'prior-run', runId: latestRun.id }
      : { kind: 'merged-pr', ref: prRef };
  const warnings = merged
    ? [
        ...(latestRun && !runBacked
          ? [
              `Matching Farmslot run ${latestRun.id.slice(0, 8)} exists but cannot seed this eval yet: ${!isTerminalRunStatus(latestRun.status) ? `run is ${latestRun.status}` : (runFlowWarning ?? 'unsupported run')}. Falling back to GitHub PR diff.`,
            ]
          : []),
      ]
    : ['Only merged PRs can seed eval experiments.'];
  const sourceKey = canonicalSourceIdentity(source);
  return {
    id: `catalog-${stableIdHash(sourceKey)}`,
    sourceKey,
    kind: source.kind,
    carrierType: runBacked && latestRun ? latestRun.flowType : undefined,
    carrierLabel: runBacked && latestRun ? flowLabel(latestRun.flowType) : undefined,
    source,
    project: pr.project,
    label: `${pr.repo}#${pr.pr}`,
    taskProfile: runBacked && latestRun ? taskProfileFromRun(latestRun) : 'fix-bug',
    objective: '',
    statusLabel: pr.prState.toLowerCase(),
    sourceStatusLabel: merged
      ? runBacked
        ? 'PR merged · Farmslot run found'
        : 'PR merged · GitHub diff only'
      : `PR ${pr.prState.toLowerCase()}`,
    runStatusLabel: latestRun ? `run ${latestRun.status}` : undefined,
    suitabilityLabel: merged
      ? runBacked
        ? 'run-backed reference'
        : 'GitHub PR diff only'
      : 'not selectable',
    ...dateFields(
      pr.mergedAt ?? pr.closedAt ?? pr.updatedAt ?? pr.createdAt ?? null,
      pr.mergedAt ? 'merged' : pr.closedAt ? 'completed' : pr.updatedAt ? 'updated' : 'created',
    ),
    primary: pr.title || `${pr.repo}#${pr.pr}`,
    secondary: `${pr.repo}#${pr.pr} · ${pr.project}${runBacked && latestRun ? ` · run ${latestRun.id.slice(0, 8)}` : ''}`,
    searchText: `${prSearchText(pr)} ${latestRun ? runSearchText(latestRun) : ''}`,
    selectable: merged,
    warnings,
    prNumber: pr.pr,
    prRef,
    familyId: latestRun?.familyId ?? pr.familyId ?? undefined,
    runId: latestRun?.id ?? pr.latestRunId ?? undefined,
    prUrl: githubPrUrl(pr.repo, pr.pr),
    ...(latestRun ? previewFieldsFromRun(latestRun) : {}),
  };
}

export function catalogItemFromRun(run: Run): EvalCaseCatalogItem {
  const source: EvalExperimentSource = { kind: 'prior-run', runId: run.id };
  const terminal = isTerminalRunStatus(run.status);
  const flowWarning = unsupportedRunFlowWarning(run);
  const sourceKey = canonicalSourceIdentity(source);
  return {
    id: `catalog-${stableIdHash(sourceKey)}`,
    sourceKey,
    kind: 'prior-run',
    carrierType: run.flowType,
    carrierLabel: flowLabel(run.flowType),
    source,
    project: run.project,
    label: run.ticketOrPr || `run ${run.id.slice(0, 8)}`,
    taskProfile: taskProfileFromRun(run),
    objective: '',
    statusLabel: run.status,
    sourceStatusLabel: `run ${run.status}`,
    suitabilityLabel: terminal && !flowWarning ? 'selectable' : 'not selectable',
    ...dateFields(
      run.completedAt ?? run.updatedAt ?? run.createdAt,
      run.completedAt ? 'completed' : run.updatedAt ? 'updated' : 'created',
    ),
    primary: run.summary || run.ticketOrPr || `run ${run.id.slice(0, 8)}`,
    secondary: `${run.id.slice(0, 8)} · ${run.project} · ${run.flowType} · ${run.status}`,
    searchText: runSearchText(run),
    selectable: terminal && !flowWarning,
    warnings: [
      ...(terminal
        ? []
        : ['Run is not terminal yet; wait for completion before using it as a reference.']),
      ...(flowWarning ? [flowWarning] : []),
    ],
    runId: run.id,
    familyId: run.familyId,
    prNumber: run.prNumber ?? undefined,
    ...previewFieldsFromRun(run),
  };
}

export function catalogItemFromManual(input: {
  kind: EvalCaseSourceKind;
  project: string;
  label?: string;
  taskProfile: EvalTaskProfile;
  objective?: string;
  prRef?: string;
  runId?: string;
  packagePath?: string;
  gitRef?: string;
  gitRepository?: string;
}): EvalCaseCatalogItem | null {
  let source: EvalExperimentSource | null = null;
  if (input.kind === 'merged-pr') {
    const ref = normalizeGithubPrRef(input.prRef);
    if (!ref) return null;
    source = { kind: 'merged-pr', ref };
  } else if (input.kind === 'prior-run') {
    const runId = normalizedText(input.runId);
    if (!runId) return null;
    source = { kind: 'prior-run', runId };
  } else if (input.kind === 'package') {
    const packagePath = normalizedText(input.packagePath);
    if (!packagePath) return null;
    source = { kind: 'package', packagePath };
  } else {
    const ref = normalizedText(input.gitRef);
    if (!ref) return null;
    source = { kind: 'git-ref', ref, repository: normalizedText(input.gitRepository) || undefined };
  }
  const sourceKey = canonicalSourceIdentity(source);
  const label = normalizedText(input.label) || sourceKey.replace(/^[^:]+:/, '');
  return {
    id: `manual-${stableIdHash(sourceKey)}`,
    sourceKey,
    kind: input.kind,
    source,
    project: normalizedText(input.project),
    label,
    taskProfile: input.taskProfile,
    objective: normalizedText(input.objective),
    statusLabel: 'manual',
    sourceStatusLabel: 'manual',
    suitabilityLabel: 'gateway will verify',
    primaryDateLabel: 'manual',
    primary: label,
    secondary: `${input.kind} · manual entry`,
    searchText: `${sourceKey} ${label} ${input.project}`.toLowerCase(),
    selectable: true,
    warnings:
      input.kind === 'merged-pr'
        ? ['Gateway will verify that the PR is merged before launch.']
        : [],
    packagePath: input.kind === 'package' ? normalizedText(input.packagePath) : undefined,
    runId: input.kind === 'prior-run' ? normalizedText(input.runId) : undefined,
  };
}

export function findCatalogItemForPrRef(
  items: readonly EvalCaseCatalogItem[],
  ref: string | null | undefined,
): EvalCaseCatalogItem | null {
  const normalized = normalizeGithubPrRef(ref).toLowerCase();
  if (!normalized) return null;
  const direct = items.find((item) => item.prRef?.toLowerCase() === normalized);
  if (direct) return direct;
  const sourceKey = canonicalSourceIdentity({ kind: 'merged-pr', ref: normalized });
  const bySource = items.find((item) => item.sourceKey.toLowerCase() === sourceKey);
  if (bySource) return bySource;
  const prNumber = Number(prNumberFromRef(normalized));
  if (Number.isFinite(prNumber)) {
    const byPrNumber = items.find((item) => item.prNumber === prNumber);
    if (byPrNumber) return byPrNumber;
  }
  const needles = caseSearchNeedles(normalized);
  return (
    items.find((item) => {
      const haystack = caseSearchHaystack(item);
      return needles.some((needle) => haystack.includes(needle));
    }) ?? null
  );
}

export function buildCaseCatalog(input: {
  prs: readonly PRStatus[];
  runs: readonly Run[];
  project?: string;
}): EvalCaseCatalogItem[] {
  const project = normalizedText(input.project);
  const runsById = new Map(input.runs.map((run) => [run.id, run]));
  const runItems = input.runs
    .filter((run) => EVAL_RUN_FLOW_TYPES.has(run.flowType))
    .map(catalogItemFromRun);
  const items = [
    ...input.prs.map((pr) =>
      catalogItemFromPr(pr, pr.latestRunId ? runsById.get(pr.latestRunId) : undefined),
    ),
    ...runItems,
  ];
  const bySourceKey = new Map<string, EvalCaseCatalogItem>();
  for (const item of items) {
    if (!bySourceKey.has(item.sourceKey)) bySourceKey.set(item.sourceKey, item);
  }
  return items
    .filter((item) => bySourceKey.get(item.sourceKey) === item)
    .filter((item) => item.selectable)
    .filter((item) => !project || item.project === project)
    .sort((a, b) => compareCaseCatalogItems(a, b, 'date', 'desc'));
}

export function filterCaseCatalog(
  items: readonly EvalCaseCatalogItem[],
  filters: EvalCaseFilters,
): EvalCaseCatalogItem[] {
  const needles = caseSearchNeedles(filters.query);
  return items.filter((item) => {
    if (filters.kind !== 'all' && item.kind !== filters.kind) return false;
    if (filters.project !== 'all' && item.project !== filters.project) return false;
    if (filters.taskProfile !== 'all' && item.taskProfile !== filters.taskProfile) return false;
    if (filters.status !== 'all' && item.statusLabel !== filters.status) return false;
    if (needles.length > 0) {
      const haystack = caseSearchHaystack(item);
      if (!needles.some((needle) => haystack.includes(needle))) return false;
    }
    return true;
  });
}

function compareMaybeDate(a: EvalCaseCatalogItem, b: EvalCaseCatalogItem): number {
  const aMs = a.sortDateMs ?? Number.NEGATIVE_INFINITY;
  const bMs = b.sortDateMs ?? Number.NEGATIVE_INFINITY;
  return aMs - bMs;
}

export function compareCaseCatalogItems(
  a: EvalCaseCatalogItem,
  b: EvalCaseCatalogItem,
  sortKey: EvalCaseSortKey,
  direction: EvalCaseSortDirection,
): number {
  const multiplier = direction === 'asc' ? 1 : -1;
  const text = (left: string | undefined, right: string | undefined) =>
    (left ?? '').localeCompare(right ?? '');
  let result = 0;
  if (sortKey === 'date') result = compareMaybeDate(a, b);
  else if (sortKey === 'title') result = text(a.primary, b.primary);
  else if (sortKey === 'kind') result = text(a.kind, b.kind);
  else if (sortKey === 'project') result = text(a.project, b.project);
  else if (sortKey === 'profile') result = text(a.taskProfile, b.taskProfile);
  else if (sortKey === 'status') result = text(a.statusLabel, b.statusLabel);
  return (result || text(a.label, b.label) || text(a.id, b.id)) * multiplier;
}

export function sortCaseCatalog(
  items: readonly EvalCaseCatalogItem[],
  sortKey: EvalCaseSortKey,
  direction: EvalCaseSortDirection,
): EvalCaseCatalogItem[] {
  return [...items].sort((a, b) => compareCaseCatalogItems(a, b, sortKey, direction));
}

export function formatCaseDate(
  item: Pick<EvalCaseCatalogItem, 'primaryDate' | 'primaryDateLabel'>,
): string {
  if (!item.primaryDate) return '—';
  const date = new Date(item.primaryDate);
  const display = Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { month: 'short', day: '2-digit' })
    : item.primaryDate;
  return item.primaryDateLabel ? `${item.primaryDateLabel} ${display}` : display;
}

export function generatedCandidateVariant(input: {
  taskProfile?: EvalTaskProfile;
  templateName?: string;
  templateHash?: string;
  runner?: string;
  model?: string;
  repeat?: boolean;
}): string {
  const taskSlug = slugFor(input.taskProfile ?? 'eval', 'eval');
  const templateSlug = input.templateName ? slugFor(input.templateName, '') : '';
  const templateIsDefaultForTask = [
    taskSlug,
    `${taskSlug}-md`,
    `${taskSlug}-template`,
    `${taskSlug}-template-md`,
  ].includes(templateSlug);
  const parts = [
    taskSlug,
    templateIsDefaultForTask ? '' : templateSlug || 'template',
    input.runner || 'runner',
    input.model || 'model',
    input.templateHash ? input.templateHash.slice(0, 8) : '',
    input.repeat ? 'repeat' : '',
  ].filter(Boolean);
  return slugFor(parts.join('-'), 'candidate').slice(0, 48);
}

export function selectedCaseFromCatalog(
  item: EvalCaseCatalogItem,
  overrides: Partial<Pick<EvalSelectedCase, 'label' | 'objective' | 'taskProfile'>> = {},
): EvalSelectedCase {
  const label = normalizedText(overrides.label) || item.label;
  const objective = normalizedText(overrides.objective ?? item.objective);
  const taskProfile = overrides.taskProfile ?? item.taskProfile;
  const datasetItemId = datasetItemIdFor({
    project: item.project,
    source: item.source,
    taskProfile,
    objective,
  });
  return {
    selectionId: datasetItemId,
    datasetItemId,
    sourceKey: item.sourceKey,
    kind: item.kind,
    source: item.source,
    project: item.project,
    label,
    taskProfile,
    objective,
    objectiveHash: objectiveHashFor(objective),
    statusLabel: item.statusLabel,
    sourceStatusLabel: item.sourceStatusLabel,
    runStatusLabel: item.runStatusLabel,
    suitabilityLabel: item.suitabilityLabel,
    warnings: item.warnings,
    runId: item.runId,
    familyId: item.familyId,
    packagePath: item.packagePath,
  };
}

export function updateSelectedCase(
  item: EvalSelectedCase,
  patch: Partial<Pick<EvalSelectedCase, 'label' | 'objective' | 'taskProfile'>>,
): EvalSelectedCase {
  const objective = normalizedText(patch.objective ?? item.objective);
  const taskProfile = patch.taskProfile ?? item.taskProfile;
  const label = normalizedText(patch.label) || item.label;
  const datasetItemId = datasetItemIdFor({
    project: item.project,
    source: item.source,
    taskProfile,
    objective,
  });
  return {
    ...item,
    selectionId: datasetItemId,
    datasetItemId,
    label,
    objective,
    objectiveHash: objectiveHashFor(objective),
    taskProfile,
  };
}

export function addCasesToBasket(
  existing: readonly EvalSelectedCase[],
  additions: readonly EvalCaseCatalogItem[],
): EvalSelectedCase[] {
  const byId = new Map(existing.map((item) => [item.datasetItemId, item]));
  for (const addition of additions) {
    if (!addition.selectable) continue;
    const selected = selectedCaseFromCatalog(addition);
    if (!byId.has(selected.datasetItemId)) byId.set(selected.datasetItemId, selected);
  }
  return [...byId.values()];
}

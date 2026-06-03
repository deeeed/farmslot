import type { PendingDecision } from '@farmslot/protocol';

import {
  type ArtifactManifestEntry,
  artifactPathsToManifest,
  countVisualArtifactPairs,
  dedupeArtifacts,
  isVisualMediaArtifact,
} from './artifact-url';

export interface DiffStatLike {
  files: number;
  additions: number;
  deletions: number;
}

export interface DecisionActionLike {
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'danger';
  description?: string;
}

type PayloadRecord = Record<string, unknown> & { kind?: string };

export type PendingDecisionLike = Omit<PendingDecision, 'actions' | 'type'> & {
  type: string;
  actions: DecisionActionLike[];
  payload?: unknown;
};

export interface DecisionPresentation {
  id: string;
  title: string;
  description: string;
  kind: string;
  kindLabel: string;
  tone: 'ok' | 'warn' | 'fail' | 'info';
  runId: string | null;
  familyId: string | null;
  project: string | null;
  slotId: string | null;
  terminalSlotId: string | null;
  ticketOrPr: string | null;
  prNumber: number | null;
  repo: string | null;
  branch: string | null;
  runner: string | null;
  model: string | null;
  summary: string;
  highlights: Array<{ label: string; value: string; tone?: DecisionPresentation['tone'] }>;
  criteria: string[];
  diffStat: DiffStatLike | null;
  artifactManifest: ArtifactManifestEntry[];
  textSections: Array<{ title: string; body: string }>;
  actions: DecisionActionLike[];
}

export function presentDecision(decision: PendingDecisionLike): DecisionPresentation {
  const payload = recordPayload(decision.payload);
  const kind = payloadKind(payload) ?? String(decision.type);
  const diffStat = diffStatForPayload(payload);
  const artifactManifest = artifactsForPayload(payload, decision.context);
  const textSections = textSectionsForPayload(payload);
  const criteria = criteriaForPayload(payload);
  const slotId = decision.slotId ?? readySlotId(payload) ?? stringFromContext(decision, 'slotId');
  const runId = decision.runMeta?.runId ?? stringFromContext(decision, 'runId');
  const branch = decision.runMeta?.branch ?? branchForPayload(payload);
  const tone = toneForPayload(payload, decision.type);

  return {
    id: decision.id,
    title: decision.title,
    description: decision.description,
    kind,
    kindLabel: labelForKind(kind),
    tone,
    runId,
    familyId: decision.runMeta?.familyId ?? stringFromContext(decision, 'familyId'),
    project: stringFromContext(decision, 'project'),
    slotId,
    terminalSlotId: slotId,
    ticketOrPr: decision.runMeta?.ticketOrPr ?? stringFromContext(decision, 'ticketOrPr'),
    prNumber:
      decision.runMeta?.prNumber ??
      numberFromContext(decision, 'prNumber') ??
      numberField(payload, 'prNumber') ??
      null,
    repo: stringOrUndefined(payload, 'repo') ?? stringFromContext(decision, 'repo'),
    branch,
    runner: decision.runMeta?.runner ?? null,
    model: decision.runMeta?.model ?? null,
    summary: summaryForPayload(payload, decision.description),
    highlights: highlightsForPayload(payload, diffStat, artifactManifest),
    criteria,
    diffStat,
    artifactManifest,
    textSections,
    actions: decision.actions,
  };
}

export function formatDiffStat(diff: DiffStatLike | null): string | null {
  if (!diff) return null;
  return `${diff.files} files, +${diff.additions}/-${diff.deletions}`;
}

export function documentTitle(path: string): string {
  return path.split('/').pop() ?? path;
}

function payloadKind(payload: PayloadRecord | undefined): string | null {
  return typeof payload?.kind === 'string' ? payload.kind : null;
}

function recordPayload(payload: unknown): PayloadRecord | undefined {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as PayloadRecord)
    : undefined;
}

function labelForKind(kind: string): string {
  const labels: Record<string, string> = {
    ready: 'Ready gate',
    review: 'Review gate',
    'no-change': 'No-change gate',
    retrospective: 'Retrospective',
    collision: 'Task collision',
    slot_picker: 'Slot picker',
    branch_affinity_nudge: 'Branch nudge',
    improvement: 'Improvement',
  };
  return labels[kind] ?? kind.replace(/[_-]/g, ' ');
}

function toneForPayload(
  payload: PayloadRecord | undefined,
  type: string,
): DecisionPresentation['tone'] {
  const kind = payloadKind(payload);
  if (kind === 'review') {
    const rec = stringField(payload, 'recommendation');
    const tokens = recommendationTokens(rec);
    const phrase = rec
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (
      tokens.some((token) =>
        [
          'reject',
          'rejected',
          'fail',
          'failed',
          'failing',
          'block',
          'blocked',
          'blocker',
          'blockers',
          'disapprove',
          'disapproved',
        ].includes(token),
      ) ||
      /\brequest\s+changes\b/.test(phrase) ||
      /\bnot\s+approved?\b/.test(phrase) ||
      /\bdo\s+not\s+approved?\b/.test(phrase)
    ) {
      return 'fail';
    }
    if (
      tokens.some((token) => ['approve', 'approved', 'pass', 'passed', 'passing'].includes(token))
    )
      return 'ok';
    return 'warn';
  }
  if (kind === 'ready') {
    if (stringField(payload, 'publicationStatus') === 'publish_failed') return 'fail';
    if (isFailingVerdict(stringField(payload, 'selfReviewVerdict'))) return 'fail';
    return 'ok';
  }
  if (kind === 'no-change')
    return stringField(payload, 'disposition') === 'not_reproducible' ? 'warn' : 'ok';
  if (kind === 'collision' || kind === 'slot_picker') return 'warn';
  return isFailingType(type) ? 'fail' : 'info';
}

function summaryForPayload(payload: PayloadRecord | undefined, fallback: string): string {
  const kind = payloadKind(payload);
  if (!payload || !kind) return fallback;
  if (kind === 'review')
    return compact(firstString(payload, ['evidenceMarkdown', 'reviewMd']) || fallback);
  if (kind === 'ready') {
    return compact(
      firstString(payload, ['validationSummary', 'selfReviewSummary', 'workerReport']) || fallback,
    );
  }
  if (kind === 'no-change')
    return compact(firstString(payload, ['reason', 'workerReport']) || fallback);
  if (kind === 'retrospective') {
    return compact(
      firstString(payload, ['whatThisIs', 'reportExcerpt', 'workerLearnings']) || fallback,
    );
  }
  if (kind === 'collision') {
    return `${arrayField(payload, 'existingDirs').length} existing task dir(s) match ${stringField(payload, 'ticketSlug')}`;
  }
  if (kind === 'slot_picker')
    return `${arrayField(payload, 'candidates').length} candidate slot(s): ${stringField(payload, 'reason')}`;
  if (kind === 'branch_affinity_nudge') {
    const candidate = recordField(payload, 'candidate');
    return `Reuse ${stringField(candidate, 'slotId')} on ${stringField(candidate, 'branch')} or dispatch fresh.`;
  }
  if (kind === 'improvement') return compact(stringField(payload, 'rationale') || fallback);
  return fallback;
}

function compact(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 360 ? `${normalized.slice(0, 357)}…` : normalized;
}

function diffStatForPayload(payload: PayloadRecord | undefined): DiffStatLike | null {
  const kind = payloadKind(payload);
  if (!payload) return null;
  if (kind === 'ready') {
    return (
      diffStatField(recordField(payload, 'prPackage'), 'diffStat') ??
      diffStatField(payload, 'diffStat')
    );
  }
  if (kind === 'review') {
    return diffStatField(recordField(payload, 'reviewSnapshot'), 'diffStat');
  }
  return null;
}

function artifactsForPayload(
  payload: PayloadRecord | undefined,
  context?: Record<string, unknown>,
): ArtifactManifestEntry[] {
  const kind = payloadKind(payload);
  const contextArtifacts = evidenceManifestField(context, 'artifactManifest') ?? [];
  if (!payload) return contextArtifacts;
  if (kind === 'ready') {
    return dedupeArtifacts([
      ...(evidenceManifestField(payload, 'artifactManifest') ?? []),
      ...(evidenceManifestField(recordField(payload, 'prPackage'), 'evidenceManifest') ?? []),
      ...contextArtifacts,
    ]);
  }
  if (kind === 'review' || kind === 'no-change') {
    return dedupeArtifacts([
      ...(evidenceManifestField(payload, 'artifactManifest') ?? []),
      ...artifactPathsToManifest(stringArrayField(payload, 'reviewInputArtifactPaths')),
      ...contextArtifacts,
    ]);
  }
  if (kind === 'retrospective') return dedupeArtifacts(contextArtifacts);
  return dedupeArtifacts(contextArtifacts);
}

function criteriaForPayload(payload: PayloadRecord | undefined): string[] {
  if (payloadKind(payload) !== 'ready') return [];
  return arrayField(payload, 'acceptanceCriteria').filter(
    (value): value is string => typeof value === 'string',
  );
}

function textSectionsForPayload(
  payload: PayloadRecord | undefined,
): Array<{ title: string; body: string }> {
  const kind = payloadKind(payload);
  if (!payload || !kind) return [];
  const sections: Array<{ title: string; body: string | undefined }> = [];
  if (kind === 'ready') {
    sections.push(
      { title: 'Worker report', body: stringOrUndefined(payload, 'workerReport') },
      { title: 'Self review', body: stringOrUndefined(payload, 'selfReviewSummary') },
      { title: 'Validation summary', body: stringOrUndefined(payload, 'validationSummary') },
      { title: 'Worker learnings', body: stringOrUndefined(payload, 'workerLearnings') },
    );
  } else if (kind === 'review') {
    sections.push(
      { title: 'Review', body: stringOrUndefined(payload, 'reviewMd') },
      { title: 'Evidence', body: stringOrUndefined(payload, 'evidenceMarkdown') },
      { title: 'Worker learnings', body: stringOrUndefined(payload, 'workerLearnings') },
    );
  } else if (kind === 'no-change') {
    sections.push(
      { title: 'Reason', body: stringOrUndefined(payload, 'reason') },
      { title: 'Worker report', body: stringOrUndefined(payload, 'workerReport') },
    );
  } else if (kind === 'retrospective') {
    sections.push(
      { title: 'What this is', body: stringOrUndefined(payload, 'whatThisIs') },
      { title: 'Self review', body: stringOrUndefined(payload, 'selfReviewSummary') },
      { title: 'Report excerpt', body: stringOrUndefined(payload, 'reportExcerpt') },
      { title: 'Worker learnings', body: stringOrUndefined(payload, 'workerLearnings') },
      { title: 'Root learnings', body: stringOrUndefined(payload, 'rootLearnings') },
      { title: 'Delta learnings', body: stringOrUndefined(payload, 'deltaLearnings') },
      { title: 'Action effects', body: actionEffectsMarkdown(payload) },
      { title: 'Comments triage', body: commentsTriageMarkdown(payload) },
    );
  } else if (kind === 'improvement') {
    sections.push(
      { title: 'Rationale', body: stringOrUndefined(payload, 'rationale') },
      { title: 'Original learning', body: stringOrUndefined(payload, 'learningContent') },
    );
  } else if (kind === 'collision') {
    sections.push({
      title: 'Colliding directories',
      body: arrayField(payload, 'existingDirs')
        .filter((value): value is string => typeof value === 'string')
        .map((dir) => `- ${dir}`)
        .join('\n'),
    });
  }
  return sections
    .filter((section): section is { title: string; body: string } => Boolean(section.body?.trim()))
    .map((section) => ({ ...section, body: section.body.trim() }));
}

function highlightsForPayload(
  payload: PayloadRecord | undefined,
  diffStat: DiffStatLike | null,
  artifacts: ArtifactManifestEntry[],
): DecisionPresentation['highlights'] {
  const highlights: DecisionPresentation['highlights'] = [];
  const diff = formatDiffStat(diffStat);
  const artifactCount = artifacts.length;
  const beforeAfterPairs = countBeforeAfterPairs(artifacts);
  if (diff) highlights.push({ label: 'Diff', value: diff, tone: 'info' });
  if (artifactCount > 0)
    highlights.push({ label: 'Evidence', value: `${artifactCount} artifact(s)` });
  if (beforeAfterPairs > 0)
    highlights.push({
      label: 'Before→After',
      value: `${beforeAfterPairs} pair${beforeAfterPairs === 1 ? '' : 's'}`,
      tone: 'ok',
    });

  const kind = payloadKind(payload);
  if (!payload || !kind) return highlights;
  if (kind === 'review') {
    highlights.unshift({
      label: 'Verdict',
      value: stringField(payload, 'recommendation'),
      tone: toneForPayload(payload, 'review'),
    });
    const commentCount = arrayField(payload, 'lineComments').length;
    if (commentCount > 0)
      highlights.push({ label: 'Comments', value: String(commentCount), tone: 'warn' });
    if (payload.stale === true)
      highlights.push({ label: 'Snapshot', value: 'Stale', tone: 'warn' });
  } else if (kind === 'ready') {
    const selfReview = stringOrUndefined(payload, 'selfReviewVerdict');
    if (selfReview)
      highlights.unshift({
        label: 'Self review',
        value: selfReview,
        tone: toneForPayload(payload, 'ready'),
      });
    const publicationStatus = stringOrUndefined(payload, 'publicationStatus');
    if (publicationStatus) highlights.push({ label: 'Publication', value: publicationStatus });
    const ciChecks = arrayField(payload, 'ciChecks').length;
    if (ciChecks) highlights.push({ label: 'CI checks', value: String(ciChecks) });
  } else if (kind === 'retrospective') {
    const outcome = stringField(payload, 'outcome');
    highlights.unshift({
      label: 'Outcome',
      value: outcome,
      tone: outcome === 'success' ? 'ok' : 'warn',
    });
    const ciWatch = recordField(payload, 'ciWatch');
    const ciTotal = numberField(ciWatch, 'total');
    if (ciWatch && ciTotal != null) {
      const passed = numberField(ciWatch, 'passed') ?? 0;
      const failed = numberField(ciWatch, 'failed') ?? 0;
      highlights.push({
        label: 'CI',
        value: `${passed}/${ciTotal}${failed > 0 ? ` · ${failed} failed` : ''}`,
        tone: failed > 0 ? 'fail' : 'ok',
      });
    }
    const comments = recordField(payload, 'commentsTriageSummary');
    const realComments = numberField(comments, 'real');
    const fixedComments = numberField(comments, 'fixed');
    if (realComments != null || fixedComments != null) {
      highlights.push({
        label: 'Comments',
        value: `${fixedComments ?? 0}/${realComments ?? 0} fixed`,
        tone: (realComments ?? 0) > (fixedComments ?? 0) ? 'warn' : 'ok',
      });
    }
    const actionEffects = arrayField(payload, 'actionEffects').length;
    if (actionEffects) highlights.push({ label: 'Actions', value: String(actionEffects) });
  } else if (kind === 'collision') {
    highlights.unshift({
      label: 'Dirs',
      value: String(arrayField(payload, 'existingDirs').length),
      tone: 'warn',
    });
    const priorRunCount = arrayField(payload, 'priorRunIds').length;
    if (priorRunCount) highlights.push({ label: 'Prior runs', value: String(priorRunCount) });
  }
  return highlights;
}

function countBeforeAfterPairs(artifacts: ArtifactManifestEntry[]): number {
  return countVisualArtifactPairs(artifacts.filter(isVisualMediaArtifact));
}

function recommendationTokens(recommendation: string): string[] {
  return recommendation
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isFailingVerdict(verdict: string): boolean {
  return ['fail', 'failed', 'failing', 'blocked', 'reject', 'rejected', 'issues'].includes(
    verdict.trim().toLowerCase(),
  );
}

function isFailingType(type: string): boolean {
  return ['fail', 'failed', 'failure', 'error', 'blocked'].includes(type.trim().toLowerCase());
}

function readySlotId(payload: PayloadRecord | undefined): string | null {
  return payloadKind(payload) === 'ready' ? (stringOrUndefined(payload, 'slotId') ?? null) : null;
}

function branchForPayload(payload: PayloadRecord | undefined): string | null {
  if (payloadKind(payload) === 'ready') return stringOrUndefined(payload, 'branch') ?? null;
  if (payloadKind(payload) === 'branch_affinity_nudge') {
    return stringOrUndefined(recordField(payload, 'candidate'), 'branch') ?? null;
  }
  return null;
}

function stringFromContext(
  decision: { context: Record<string, unknown> },
  key: string,
): string | null {
  const value = decision.context?.[key];
  return typeof value === 'string' ? value : null;
}

function numberFromContext(
  decision: { context: Record<string, unknown> },
  key: string,
): number | null {
  const value = decision.context?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string {
  return stringOrUndefined(record, key) ?? '';
}

function stringOrUndefined(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringOrUndefined(record, key);
    if (value) return value;
  }
  return undefined;
}

function arrayField(record: Record<string, unknown> | undefined, key: string): unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function stringArrayField(record: Record<string, unknown> | undefined, key: string): string[] {
  return arrayField(record, key).filter((value): value is string => typeof value === 'string');
}

function recordField(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function actionEffectsMarkdown(payload: PayloadRecord): string | undefined {
  const rows = arrayField(payload, 'actionEffects')
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      const actionId = stringOrUndefined(record, 'actionId');
      const summary = stringOrUndefined(record, 'summary');
      if (!actionId && !summary) return null;
      return `- ${actionId ? `\`${actionId}\`: ` : ''}${summary ?? ''}`;
    })
    .filter((line): line is string => Boolean(line));
  return rows.length ? rows.join('\n') : undefined;
}

function commentsTriageMarkdown(payload: PayloadRecord): string | undefined {
  const summary = recordField(payload, 'commentsTriageSummary');
  if (!summary) return undefined;
  const rows = [
    ['Total', numberField(summary, 'total')],
    ['Real', numberField(summary, 'real')],
    ['False positive', numberField(summary, 'falsePositive')],
    ['Out of scope', numberField(summary, 'outOfScope')],
    ['Fixed', numberField(summary, 'fixed')],
    ['Bot addressed', numberField(summary, 'botAddressed')],
    ['Human reviewers requesting changes', numberField(summary, 'humanReviewersRequestingChanges')],
    ['Human comments addressed', numberField(summary, 'humanCommentsAddressed')],
  ]
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([label, value]) => `- ${label}: ${value}`);
  const paths = arrayField(summary, 'actionablePaths').filter(
    (value): value is string => typeof value === 'string',
  );
  if (paths.length) rows.push(`- Actionable paths: ${paths.join(', ')}`);
  return rows.length ? rows.join('\n') : undefined;
}

function diffStatField(
  record: Record<string, unknown> | undefined,
  key: string,
): DiffStatLike | null {
  const value = recordField(record, key);
  if (!value) return null;
  const { files, additions, deletions } = value;
  return typeof files === 'number' && typeof additions === 'number' && typeof deletions === 'number'
    ? { files, additions, deletions }
    : null;
}

function evidenceManifestField(
  record: Record<string, unknown> | undefined,
  key: string,
): ArtifactManifestEntry[] | null {
  const value = arrayField(record, key);
  const entries = value.filter((entry): entry is ArtifactManifestEntry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const candidate = entry as Record<string, unknown>;
    return typeof candidate.path === 'string' && typeof candidate.purpose === 'string';
  });
  return entries.length ? entries : null;
}

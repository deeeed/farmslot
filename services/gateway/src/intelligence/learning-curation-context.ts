import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  isRecord,
  type KnowledgeDestination,
  type LearningRuleResult,
  learningSectionAnchor,
  type Run,
} from '@farmslot/protocol';
import { reviewHistoryArtifactPaths, reviewHistoryView } from '@farmslot/review-dispatch';
import {
  currentProjectSources,
  loadProjectVars,
  resolveSourceBinding,
} from '@farmslot/slot-config';

import { resolveConfiguredExecutionTemplateSources } from '../host-services/execution-template-sources.js';
import { readOptionalRetainedRunText } from '../run-completion/retained-artifacts.js';
import { getAllRunsWithArchived } from '../runs/store.js';

import type { LearningCurationContext, LearningDocument } from './learning-curation.js';

const MAX_PACKET_CHARS = 220_000;
const MAX_DOCUMENT_CHARS = 16_000;
// Immutable bundle data is reused across human requests; never cache mutable staging.
const retainedDocuments = new Map<string, Promise<LearningDocument[]>>();

/** A run artifact from its retained bundle, or from its task directory before capture. */
async function runArtifactText(run: Run, file: string): Promise<string | undefined> {
  if (run.artifactBundle || run.output?.artifactBundle)
    return readOptionalRetainedRunText(run, file);
  if (!run.taskFile) return undefined;
  try {
    return await readFile(path.join(path.dirname(run.taskFile), file), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

/**
 * The review rows of a run (`artifacts/review-coverage.json`): each rule family's
 * PASS or FINDING. A row names its family by the pack's id, or by its heading's
 * anchor when the review ran without a pack.
 */
export async function reviewRowsForRun(run: Run): Promise<LearningRuleResult[]> {
  if (run.reviewWorkspace?.reviewTask) {
    // A review skill's round (ADR-058 Amendment 4): its ledger has one `## <n>. <title>`
    // section per row with its `Outcome:`. The skill's finish refused gaps already.
    const ledger = await runArtifactText(run, 'artifacts/review-ledger.md');
    return (ledger ?? '').split(/^## (?=\d+\. )/m).flatMap((section): LearningRuleResult[] => {
      const title = /^\d+\. (.+)/.exec(section)?.[1]?.trim();
      const outcome = /^Outcome: *(PASS|FINDING)\b/m.exec(section)?.[1];
      const family = title ? learningSectionAnchor(title) : '';
      return family && (outcome === 'PASS' || outcome === 'FINDING')
        ? [{ runId: run.id, family, outcome }]
        : [];
    });
  }
  const text = await runArtifactText(run, 'artifacts/review-coverage.json');
  if (!text?.trim()) return [];
  const index: unknown = JSON.parse(text);
  if (!isRecord(index) || !Array.isArray(index.rows)) return [];
  return index.rows.flatMap((row): LearningRuleResult[] => {
    if (!isRecord(row) || !isRecord(row.definition) || !isRecord(row.value)) return [];
    const { definition, value } = row;
    if (definition.kind !== 'criterion') return [];
    if (value.outcome !== 'PASS' && value.outcome !== 'FINDING') return [];
    const family =
      typeof definition.family === 'string' && definition.family
        ? definition.family
        : typeof definition.label === 'string'
          ? learningSectionAnchor(definition.label)
          : '';
    return family ? [{ runId: run.id, family, outcome: value.outcome }] : [];
  });
}

async function evidenceForRun(run: Run): Promise<LearningDocument[]> {
  const reviewerPaths = new Set(reviewHistoryArtifactPaths(run));
  const paths = [
    ...new Set([
      'artifacts/comments-triage.json',
      'artifacts/report.md',
      'artifacts/review-result.json',
      ...(run.output?.artifactManifest ?? [])
        .filter((a) => a.path.includes('review') && a.path.endsWith('.json'))
        .map((a) => a.path),
    ]),
  ];
  const read = async (): Promise<LearningDocument[]> => {
    const documents: LearningDocument[] = [];
    for (const file of paths) {
      const text = await runArtifactText(run, file);
      if (text?.trim()) {
        let confirms: LearningDocument['confirms'];
        if (file.endsWith('.json')) {
          const parsed: unknown = JSON.parse(text);
          if (file === 'artifacts/comments-triage.json') {
            const rows = Array.isArray(parsed)
              ? parsed
              : isRecord(parsed)
                ? parsed.comments
                : undefined;
            if (
              Array.isArray(rows) &&
              rows.some(
                (row) =>
                  isRecord(row) &&
                  row.triage === 'REAL' &&
                  typeof row.fixed_in_commit === 'string' &&
                  row.fixed_in_commit.trim(),
              )
            )
              confirms = 'accepted-fix';
          } else if (
            reviewerPaths.has(file) &&
            isRecord(parsed) &&
            parsed.verdict === 'issues' &&
            Array.isArray(parsed.issues) &&
            parsed.issues.length
          )
            confirms = 'independent-review';
        }
        documents.push({
          runId: run.id,
          path: file,
          text: text.slice(0, MAX_DOCUMENT_CHARS),
          familyId: `${run.project}:${run.familyRootTicketOrPr || run.ticketOrPr}`,
          actor: confirms === 'independent-review' ? 'reviewer' : 'worker',
          ...(confirms ? { confirms } : {}),
        });
      }
    }
    return documents;
  };
  const ref = run.artifactBundle ?? run.output?.artifactBundle;
  if (!ref) return read();
  const key = `${run.id}:${ref.bundleDigest}:${[...reviewerPaths].sort().join(',')}`;
  let pending = retainedDocuments.get(key);
  if (!pending) {
    pending = read();
    retainedDocuments.set(key, pending);
    if (retainedDocuments.size > 128)
      retainedDocuments.delete(retainedDocuments.keys().next().value!);
    // A later request may retry an IO failure; its caller still receives the rejection.
    void pending.catch(() => retainedDocuments.delete(key));
  }
  return pending;
}

export async function loadLearningCurationContext(
  project: string,
  destination: KnowledgeDestination | null,
  runId?: string,
): Promise<LearningCurationContext> {
  const context: LearningCurationContext = { runId: runId ?? '', evidence: [], library: [] };
  if (!runId || !destination)
    return { ...context, unavailable: 'No source run or configured knowledge destination' };
  try {
    const projectVars = await loadProjectVars(project);
    const config = projectVars.projectJson;
    const definitions = config.static_review?.support?.libraries ?? [];
    const selected = definitions.find(
      (d) => config.reference_repos?.[`${d.name}_library`]?.repo_url === destination.repo,
    );
    if (!selected)
      throw new Error('Knowledge destination has no configured readable library source');
    const sources = currentProjectSources();
    const resolved = await resolveConfiguredExecutionTemplateSources(
      {
        sources: [
          {
            id: selected.name,
            kind: 'workspace',
            root: selected.root,
            ...(selected.subpath ? { subpath: selected.subpath } : {}),
          },
        ],
      },
      {
        projectPackRoot: path.dirname(projectVars.projectConfig),
        env: process.env,
        resolveSourceBinding: sources
          ? (selection) => resolveSourceBinding(selection, sources.materialization)
          : undefined,
      },
    );
    const source = resolved.sources[0];
    if (!source || resolved.unavailable.length)
      throw new Error('Configured knowledge source unavailable');
    const root = await realpath(source.root);
    const directory = await realpath(path.resolve(root, path.dirname(destination.path)));
    const relative = path.relative(root, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Knowledge path escapes its library');
    const names = (await readdir(directory)).filter((name) => name.endsWith('.md')).sort();
    for (const name of names) {
      const file = await realpath(path.join(directory, name));
      if (!file.startsWith(root + path.sep)) throw new Error('Knowledge file escapes its library');
      const text = await readFile(file, 'utf8');
      context.library.push({ runId: '', path: path.relative(root, file), text });
    }
    if (!context.library.some((d) => d.path === destination.path))
      throw new Error('Knowledge target file unavailable');
    let size = context.library.reduce((sum, d) => sum + d.text.length, 0);
    if (size > MAX_PACKET_CHARS)
      throw new Error('Knowledge library exceeds curation packet budget');
    const all = await getAllRunsWithArchived();
    const allowedProjects = new Set([project]);
    for (const other of new Set(all.map((run) => run.project))) {
      if (other === project) continue;
      let vars;
      try {
        vars = await loadProjectVars(other);
      } catch (error) {
        console.warn(
          `[learning-curation] Peer project ${other} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (
        Object.values(vars.projectJson.reference_repos ?? {}).some(
          (ref) => ref.repo_url === destination.repo,
        )
      )
        allowedProjects.add(other);
    }
    const candidates = all
      .filter((run) => allowedProjects.has(run.project))
      .sort(
        (a, b) =>
          Number(b.id === runId) - Number(a.id === runId) || b.createdAt.localeCompare(a.createdAt),
      );
    for (const run of candidates) {
      if (size > MAX_PACKET_CHARS - MAX_DOCUMENT_CHARS) break;
      let documents: LearningDocument[];
      try {
        documents = [...(await evidenceForRun(run))];
      } catch (error) {
        // An older run whose bundle retention pruned is missing evidence, not a reason to
        // curate nothing; the source run's own evidence stays required.
        if (run.id === runId) throw error;
        console.warn(
          `[learning-curation] Evidence of run ${run.id} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const history = reviewHistoryView(
        run,
        Object.fromEntries(documents.map((d) => [d.path, { content: d.text }])),
      );
      if (history.roundCount)
        documents.unshift({
          runId: run.id,
          path: 'run/review-history.json',
          familyId: `${run.project}:${run.familyRootTicketOrPr || run.ticketOrPr}`,
          actor: 'reviewer',
          text: JSON.stringify(
            history.checks.map((check) => ({
              check: check.id,
              verdict: check.verdict,
              rounds: check.rounds.map((round) => ({
                round: round.roundNumber,
                findings: round.findings,
              })),
            })),
            null,
            2,
          ).slice(0, MAX_DOCUMENT_CHARS),
        });
      for (const document of documents) {
        if (size + document.text.length > MAX_PACKET_CHARS) continue;
        context.evidence.push(document);
        size += document.text.length;
      }
    }
    // The review rows of the lesson's run and its family decide a v1 lesson's kind.
    const sourceRun = all.find((run) => run.id === runId);
    const results: LearningRuleResult[] = [];
    for (const run of sourceRun
      ? all.filter((run) => (run.familyId ?? run.id) === (sourceRun.familyId ?? sourceRun.id))
      : []) {
      try {
        results.push(...(await reviewRowsForRun(run)));
      } catch (error) {
        // As with evidence: the source run's rows are required, since without them every
        // kind claim would stand unchecked; a family run whose bundle retention pruned is
        // skipped.
        if (run.id === runId) throw error;
        console.warn(
          `[learning-curation] Review rows of run ${run.id} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (results.length) context.results = results;
    return context;
  } catch (error) {
    return {
      ...context,
      unavailable: `Curation evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

let contextLoader = loadLearningCurationContext;
/** @internal Test source seam; the policy and citation validator still run. */
export function setLearningContextLoaderForTest(loader?: typeof loadLearningCurationContext): void {
  contextLoader = loader ?? loadLearningCurationContext;
}
export function learningCurationContext(...args: Parameters<typeof loadLearningCurationContext>) {
  return contextLoader(...args);
}

import {
  type EvidenceManifest,
  type RecipeArtifactManifestEntry,
  type RecipeClaimLedger,
  type RecipeResolutionDocument,
  type RecordedEvidencePackageInput,
  resolvedRecipeArtifactPath,
} from '@farmslot/protocol';

import {
  assertRecipeArtifactDestinationAvailable,
  occupiedRecipeArtifactsError,
} from '../core/artifact-destination.js';
import type { RecipeInvocationDocument } from '../core/invocation.js';
import { writeFileWithinRoot } from '../core/path.js';
import type {
  ArtifactWriter,
  RecipeRunnerProvenance,
  RecipeRunStatus,
  SummaryDocument,
  SummaryWriter,
  TraceEntry,
  TraceWriter,
} from '../core/types.js';
import { groupRecipeCaptureComparisons } from '../evidence/capture-comparisons.js';

export class JsonArtifactWriter implements ArtifactWriter {
  readonly #artifactsDir: string;
  readonly #entries: RecipeArtifactManifestEntry[] = [];

  constructor(artifactsDir: string) {
    this.#artifactsDir = artifactsDir;
  }

  async copyRecipe(recipe: unknown): Promise<string> {
    await assertRecipeArtifactDestinationAvailable(this.#artifactsDir);
    let recipePath: string;
    try {
      // Atomic admission: two runners cannot both own this artifact package.
      recipePath = await writeJsonWithinRoot(this.#artifactsDir, 'recipe.json', recipe, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw occupiedRecipeArtifactsError(this.#artifactsDir);
      }
      throw error;
    }
    this.register({
      path: 'recipe.json',
      type: 'recipe',
      label: 'Executed recipe',
      category: 'system',
    });
    return recipePath;
  }

  async copyResolvedRecipe(digest: string, recipe: unknown): Promise<string> {
    const relativePath = resolvedRecipeArtifactPath(digest);
    if (!relativePath) throw new Error(`Invalid resolved recipe digest ${digest}.`);
    const resolvedPath = await writeJsonWithinRoot(this.#artifactsDir, relativePath, recipe);
    this.register({
      path: relativePath,
      type: 'recipe',
      label: 'Resolved recipe dependency',
      category: 'system',
    });
    return resolvedPath;
  }

  async writeRecipeResolution(resolution: RecipeResolutionDocument): Promise<string> {
    const relativePath = 'recipe-resolution.json';
    const resolutionPath = await writeJsonWithinRoot(this.#artifactsDir, relativePath, resolution);
    this.register({
      path: relativePath,
      type: 'json',
      label: 'Resolved recipe dependency graph',
      category: 'system',
    });
    return resolutionPath;
  }

  async writeInvocation(invocation: RecipeInvocationDocument): Promise<void> {
    await writeJsonWithinRoot(this.#artifactsDir, 'recipe-invocation.json', invocation);
    this.register({
      path: 'recipe-invocation.json',
      type: 'json',
      label: 'Executed recipe parameters',
      category: 'system',
    });
  }

  register(entry: RecipeArtifactManifestEntry): void {
    if (!this.#entries.some((existing) => existing.path === entry.path)) {
      this.#entries.push(entry);
    }
  }

  list(): RecipeArtifactManifestEntry[] {
    return [...this.#entries];
  }

  /** Every engine consumer gets the same attempt-local publication candidate. */
  async writeEvidenceManifest(
    claims: RecipeClaimLedger,
    comparisons: RecordedEvidencePackageInput['comparisonDependencies'] = [],
    snapshot?: Pick<import('@farmslot/protocol').ReviewDiffSnapshot, 'baseSha' | 'headSha'>,
  ): Promise<string> {
    if (this.#entries.some((artifact) => artifact.path === 'evidence-manifest.json'))
      throw new Error('evidence-manifest.json is owned by the recipe engine.');
    const projection = groupRecipeCaptureComparisons(
      {
        summary: undefined,
        manifest: { artifacts: this.list() },
        claims,
        comparisonDependencies: comparisons,
        timelines: {},
        artifactDigests: {},
      },
      claims.criteria,
      snapshot,
    );
    const used = new Set<string>();
    const pairs = projection.rows.flatMap((row) => {
      const before = row.before.filter((media) => media.eligible && media.type === 'screenshot');
      const after = row.after.filter((media) => media.eligible && media.type === 'screenshot');
      if (before.length !== 1 || after.length !== 1) return [];
      used.add(before[0]!.path);
      used.add(after[0]!.path);
      return [
        {
          label: claims.criteria.find((claim) => claim.id === row.id)!.text,
          covers: [row.id],
          before: before[0]!.path,
          after: after[0]!.path,
        },
      ];
    });
    const sourceMismatch = projection.media.find(
      (media) => media.reasonCode === 'comparison-source-mismatch',
    );
    if (sourceMismatch)
      throw new Error(
        `comparison-source-mismatch: ${sourceMismatch.path}: ${sourceMismatch.reason}`,
      );
    const manifest: EvidenceManifest = {
      version: 1,
      preferred_mode: 'screenshots',
      summary: claims.criteria.map((claim) => `${claim.id}: ${claim.verdict}`).join('; '),
      ...(pairs.length ? { before_after_pairs: pairs } : {}),
      standalone: projection.media
        .filter((media) => !used.has(media.path))
        .map((media) => ({
          label: media.label,
          file: media.path,
          ...(media.capture?.ac && claims.criteria.some((claim) => claim.id === media.capture?.ac)
            ? { covers: [media.capture.ac] }
            : {}),
          note: media.capture?.role
            ? `${media.capture.role}; execution ${media.capture.recipeRunId}; source ${media.capture.sourceCommit ?? 'unknown'}. ${media.reason ?? ''}`
            : 'Unassigned capture.',
        })),
    };
    const manifestPath = await writeJsonWithinRoot(
      this.#artifactsDir,
      'evidence-manifest.json',
      manifest,
    );
    this.register({
      path: 'evidence-manifest.json',
      type: 'json',
      category: 'system',
      label: 'Engine-derived publication selection',
    });
    return manifestPath;
  }

  async write(
    status: RecipeRunStatus,
    runner?: RecipeRunnerProvenance,
    metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<string> {
    return writeJsonWithinRoot(this.#artifactsDir, 'artifact-manifest.json', {
      ...metadata,
      version: 1,
      runStatus: status,
      ...(runner ? { provenance: { runner } } : {}),
      artifacts: this.list(),
    });
  }
}

export class JsonTraceWriter implements TraceWriter {
  readonly #artifactsDir: string;
  readonly #entries: TraceEntry[] = [];
  readonly #runner: RecipeRunnerProvenance | undefined;

  constructor(artifactsDir: string, runner?: RecipeRunnerProvenance) {
    this.#artifactsDir = artifactsDir;
    this.#runner = runner;
  }

  record(entry: TraceEntry): void {
    this.#entries.push(entry);
  }

  list(): TraceEntry[] {
    return [...this.#entries];
  }

  async write(): Promise<string> {
    return writeJsonWithinRoot(
      this.#artifactsDir,
      'trace.json',
      this.#runner ? { metadata: { runner: this.#runner }, entries: this.list() } : this.list(),
    );
  }
}

/** Summary counts derived from the trace; the artifact package validator requires exactly these. */
export function summarizeTraceCounts(
  trace: readonly Pick<TraceEntry, 'ok' | 'cause_class'>[],
): Pick<SummaryDocument, 'total' | 'passed' | 'failed' | 'cause_counts'> {
  const failedWith = (cause: string) =>
    trace.filter((entry) => !entry.ok && entry.cause_class === cause).length;
  return {
    total: trace.length,
    passed: trace.filter((entry) => entry.ok).length,
    failed: trace.filter((entry) => !entry.ok).length,
    cause_counts: {
      subject: failedWith('subject'),
      harness: failedWith('harness'),
      environment: failedWith('environment'),
      unknown: failedWith('unknown'),
    },
  };
}

export class JsonSummaryWriter implements SummaryWriter {
  readonly #artifactsDir: string;

  constructor(artifactsDir: string) {
    this.#artifactsDir = artifactsDir;
  }

  async write(summary: SummaryDocument): Promise<string> {
    return writeJsonWithinRoot(this.#artifactsDir, 'summary.json', summary);
  }
}

function writeJsonWithinRoot(
  root: string,
  relativePath: string,
  value: unknown,
  exclusive = false,
): Promise<string> {
  return writeFileWithinRoot(root, relativePath, `${JSON.stringify(value, null, 2)}\n`, exclusive);
}

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { RecipeArtifactManifestEntry } from '@farmslot/protocol';

import { writeJsonFile } from '../core/json.js';
import type {
  ArtifactWriter,
  RecipeRunnerProvenance,
  RecipeRunStatus,
  SummaryDocument,
  SummaryWriter,
  TraceEntry,
  TraceWriter,
} from '../core/types.js';

export class JsonArtifactWriter implements ArtifactWriter {
  readonly #artifactsDir: string;
  readonly #entries: RecipeArtifactManifestEntry[] = [];

  constructor(artifactsDir: string) {
    this.#artifactsDir = artifactsDir;
  }

  async copyRecipe(recipe: unknown): Promise<string> {
    const recipePath = path.join(this.#artifactsDir, 'recipe.json');
    await writeJsonFile(recipePath, recipe);
    this.register({
      path: 'recipe.json',
      type: 'recipe',
      label: 'Executed recipe',
      category: 'system',
    });
    return recipePath;
  }

  /**
   * Writes the fully-composed recipe: the authored recipe with every reachable
   * flow (inline + `uses` catalogs + resolved library flows, transitively)
   * inlined under `flows`. This artifact is self-contained, so its `call.ref`s
   * resolve without the recipe library and it validates as a complete recipe.
   */
  async writeResolvedRecipe(recipe: unknown): Promise<string> {
    const resolvedPath = path.join(this.#artifactsDir, 'resolved-recipe.json');
    await writeJsonFile(resolvedPath, recipe);
    this.register({
      path: 'resolved-recipe.json',
      type: 'recipe',
      label: 'Resolved recipe (full composition)',
      category: 'system',
    });
    return resolvedPath;
  }

  register(entry: RecipeArtifactManifestEntry): void {
    if (!this.#entries.some((existing) => existing.path === entry.path)) {
      this.#entries.push(entry);
    }
  }

  list(): RecipeArtifactManifestEntry[] {
    return [...this.#entries];
  }

  async write(status: RecipeRunStatus, runner?: RecipeRunnerProvenance): Promise<string> {
    await mkdir(this.#artifactsDir, { recursive: true });
    const manifestPath = path.join(this.#artifactsDir, 'artifact-manifest.json');
    await writeJsonFile(manifestPath, {
      version: 1,
      runStatus: status,
      ...(runner ? { provenance: { runner } } : {}),
      artifacts: this.list(),
    });
    return manifestPath;
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
    const tracePath = path.join(this.#artifactsDir, 'trace.json');
    await writeJsonFile(
      tracePath,
      this.#runner ? { metadata: { runner: this.#runner }, entries: this.list() } : this.list(),
    );
    return tracePath;
  }
}

export class JsonSummaryWriter implements SummaryWriter {
  readonly #artifactsDir: string;

  constructor(artifactsDir: string) {
    this.#artifactsDir = artifactsDir;
  }

  async write(summary: SummaryDocument): Promise<string> {
    const summaryPath = path.join(this.#artifactsDir, 'summary.json');
    await writeJsonFile(summaryPath, summary);
    return summaryPath;
  }
}

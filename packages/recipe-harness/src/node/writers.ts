import {
  type RecipeArtifactManifestEntry,
  type RecipeResolutionDocument,
  resolvedRecipeArtifactPath,
} from '@farmslot/protocol';

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

export class JsonArtifactWriter implements ArtifactWriter {
  readonly #artifactsDir: string;
  readonly #entries: RecipeArtifactManifestEntry[] = [];

  constructor(artifactsDir: string) {
    this.#artifactsDir = artifactsDir;
  }

  async copyRecipe(recipe: unknown): Promise<string> {
    const recipePath = await writeJsonWithinRoot(this.#artifactsDir, 'recipe.json', recipe);
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

  register(entry: RecipeArtifactManifestEntry): void {
    if (!this.#entries.some((existing) => existing.path === entry.path)) {
      this.#entries.push(entry);
    }
  }

  list(): RecipeArtifactManifestEntry[] {
    return [...this.#entries];
  }

  async write(status: RecipeRunStatus, runner?: RecipeRunnerProvenance): Promise<string> {
    return writeJsonWithinRoot(this.#artifactsDir, 'artifact-manifest.json', {
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

export class JsonSummaryWriter implements SummaryWriter {
  readonly #artifactsDir: string;

  constructor(artifactsDir: string) {
    this.#artifactsDir = artifactsDir;
  }

  async write(summary: SummaryDocument): Promise<string> {
    return writeJsonWithinRoot(this.#artifactsDir, 'summary.json', summary);
  }
}

function writeJsonWithinRoot(root: string, relativePath: string, value: unknown): Promise<string> {
  return writeFileWithinRoot(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

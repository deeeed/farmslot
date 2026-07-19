import type { RecipeArtifactManifestEntry } from '@farmslot/protocol';

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

  /**
   * Writes the fully-composed recipe: the authored recipe with every reachable
   * flow (inline + `uses` catalogs + resolved library flows, transitively)
   * inlined under `flows`. This artifact is self-contained, so its `call.ref`s
   * resolve without the recipe library and it validates as a complete recipe.
   */
  async writeResolvedRecipe(recipe: unknown): Promise<string> {
    const resolvedPath = await writeJsonWithinRoot(
      this.#artifactsDir,
      'resolved-recipe.json',
      recipe,
    );
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

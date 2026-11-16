export interface RecipeArtifactOwner {
  schemaVersion: 1;
  runId: string;
  taskFile: string;
  recipeRunId: string;
}
export interface RecipeArtifactSnapshot {
  relative: string;
  owner: RecipeArtifactOwner;
  digest: string;
  bytes: number;
  files: string[];
}
export type RecipeArtifactOperation =
  | {
      kind: 'inventory';
      repo: string;
      runId: string;
      taskFiles: string[];
      fileList: string;
      maxBytes: number;
    }
  | {
      kind: 'remove';
      repo: string;
      runId: string;
      snapshots: RecipeArtifactSnapshot[];
      maxBytes: number;
    };
export const RECIPE_ARTIFACT_OWNERSHIP_DIR: 'artifacts/recipe-ownership';
export function recordRecipeArtifactOwner(
  directory: string,
  recipeRunId: string | undefined,
  taskFile?: string,
): Promise<RecipeArtifactOwner | null>;
export function parseRecipeArtifactOwner(value: unknown): RecipeArtifactOwner | null;
export function parseRecipeArtifactSnapshots(value: unknown): RecipeArtifactSnapshot[];
export function buildRecipeArtifactCommand(input: RecipeArtifactOperation): string;
export function recipeArtifactOperation(
  input: RecipeArtifactOperation,
): Promise<RecipeArtifactSnapshot[] | { removed: string[] }>;

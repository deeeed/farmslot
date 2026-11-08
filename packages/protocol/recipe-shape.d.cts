export interface RecipeShapeCriterion {
  id: string;
  text?: string;
  proofMode?: string;
}
export interface RecipeShapeBlock {
  id: string;
  ref?: string;
  tokens?: string[];
  sig?: string[];
}
export interface RecipeShapeSource {
  name: string;
  revision: string | null;
  fingerprint: string | null;
}
export interface RecipeShapeCatalog {
  available: boolean;
  blocks: RecipeShapeBlock[];
  sources: RecipeShapeSource[];
}
export interface RecipeShapeInput {
  recipe: unknown;
  nonLocalCriteria?: string[];
  criteria?: RecipeShapeCriterion[] | null;
  catalog?: RecipeShapeCatalog | null;
}
export interface RecipeShapeHint {
  kind: 'parameterize' | 'compose' | 'shorten' | 'acceptance' | 'catalog';
  message: string;
  field?: string;
  nodes?: string[];
  flow?: string;
  ref?: string;
  criterionId?: string;
}
export interface RecipeShapeFeedback {
  policyVersion: number;
  inputIdentity: { recipe: string; criteria: string; catalog: string };
  nodes: number;
  calls: number;
  templatedValues: number;
  literalValues: number;
  short: number;
  composed: number | null;
  parameterized: number;
  inlineDuplicates: { flow: string; ref?: string; nodes: string[] }[];
  goodShape: boolean;
  acCoverage: {
    nonLocal: string[];
    available: boolean;
    expected: string[];
    covered: string[];
    missing: string[];
    reviewOnly: string[];
    unexpected: string[];
    complete: boolean;
  };
  eligibleForImitation: boolean;
  catalogTrust: 'worker-supplied-self-consistent';
  status: 'ok' | 'warn' | 'unavailable';
  hints: RecipeShapeHint[];
}
export const POLICY_VERSION: number;
export const RECIPE_SHAPE_POLICY: Readonly<{
  short: Readonly<{ good: number; max: number }>;
  positive: Readonly<{ short: number; composed: number; parameterized: number }>;
  skipValueKeys: string;
  selectorKeys: string;
}>;
export function stableDigest(value: unknown): string;
export function inspectRecipeShape(recipe: {
  workflow?: { entry?: string; teardown?: string; nodes?: Record<string, unknown> };
}): { order: string[]; reachable: string[]; tokens: string[]; signature: string[] };
export function recipeShapeNodeToken(node: Record<string, unknown>): string;
export function recipeShapeSignature(tokens: string[]): string[];
export function isRecipeShapeObservation(action?: string): boolean;
export function scoreRecipeShape(input: RecipeShapeInput): RecipeShapeFeedback;
export function isRecipeShapeFeedback(value: unknown): value is RecipeShapeFeedback;

export function recipeShapeLibraryRef(
  name: string | null,
  relativePath: string,
  platforms?: string[],
): string;
export function recipeShapeBlock(ref: string, recipe: unknown): RecipeShapeBlock | null;
export function processShapeRequest(request: Record<string, unknown>): unknown;

export function recipeShapeSelector(node: Record<string, unknown>): string | null;

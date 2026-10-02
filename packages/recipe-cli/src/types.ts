import type { RecipeExecutionCapability, RecipeResolutionDocument } from '@farmslot/protocol';
import type {
  RecipeLibraryAdapterDeclaration,
  RecipeLibraryOrigin,
} from '@farmslot/recipe-harness';

/** Version of every `--json` envelope printed by the discovery commands. */
export const DISCOVERY_SCHEMA_VERSION = 1 as const;

export type DiscoveryCommand =
  | 'actions'
  | 'describe'
  | 'list'
  | 'explain'
  | 'search'
  | 'template'
  | 'completions';

export interface DiscoveryEnvelope {
  schemaVersion: typeof DISCOVERY_SCHEMA_VERSION;
  command: DiscoveryCommand;
  status: 'ok' | 'fail';
}

export interface DiscoveryErrorEnvelope extends DiscoveryEnvelope {
  status: 'fail';
  error: { code: string; message: string; userAction: string };
}

export interface DiscoveryRequirement {
  package: string;
  range: string;
  /** Installed version, or null when this CLI cannot check the package. */
  installed: string | null;
  /** Null when unchecked. An unsatisfied checked requirement fails resolution. */
  satisfied: boolean | null;
}

export interface DiscoveryActionManifestFile {
  /** Platform id, or `shared` for every platform. */
  scope: string;
  /** Path relative to the library root. */
  file: string;
}

export interface DiscoveryLibrary {
  /** 1 is the highest precedence; the first library declaring a recipe or action wins. */
  rank: number;
  name: string;
  root: string;
  origin: RecipeLibraryOrigin;
  /** Root of the RECIPE_LIBRARY_PATH entry this --library entry replaced. */
  overrides?: string;
  /** Content digest of recipe-library.json, recipes/, manifests/, actions/ and declared files. */
  digest: string;
  /** Platforms the library uses: declared ones, plus built-in ones with recipes or actions. */
  platforms: string[];
  /** Declared platform adapters. Discovery reports them; it does not load their code. */
  adapters: Record<string, RecipeLibraryAdapterDeclaration>;
  actionManifests: DiscoveryActionManifestFile[];
  requires: DiscoveryRequirement[];
}

export interface DiscoveryParameter {
  name: string;
  type?: string;
  required: boolean;
  default?: unknown;
  enum?: unknown[];
  description?: string;
}

/**
 * Who executes an action: `runner` (call/end), `builtin` (a handler registered by this CLI),
 * or `adapter` (declared by a library, implemented by a platform adapter this CLI does not load).
 */
export type DiscoveryActionHandler = 'runner' | 'builtin' | 'adapter';

export interface DiscoveryAction {
  name: string;
  kind: 'official' | 'custom';
  description: string;
  parameters: DiscoveryParameter[];
  capabilities: RecipeExecutionCapability[];
  handler: DiscoveryActionHandler;
  /**
   * Whether recipes can use the action in this view: a resolved manifest declares it, or the
   * runner provides it (call, end). A handler no manifest declares is listed with false.
   */
  declared: boolean;
  /** Winning library, or null when no library declares the action. */
  source: string | null;
  /** Winning manifest path relative to its library root. */
  manifest: string | null;
  /** Lower-precedence libraries that also declare the action. */
  shadows: string[];
  /** Scopes (platforms or `shared`) where any library declares the action. */
  platforms: string[];
  resultCases: string[];
}

export interface DiscoveryActionDetail extends DiscoveryAction {
  schema: unknown;
  examples: unknown[];
  /** Recipes in this view whose workflow uses the action directly. */
  callers: string[];
}

export interface DiscoveryRecipeVariant {
  /** Null for the generic recipe that applies to every platform. */
  platform: string | null;
  source: string;
  file: string;
}

export interface DiscoveryProblem {
  code: string;
  message: string;
  path?: string;
}

export interface DiscoveryRecipe {
  /** Reference used by `run` and by `call` nodes; resolved by library precedence. */
  ref: string;
  /** Namespaced id `<library>.<ref>`; selects that library's recipe even when shadowed. */
  id: string;
  title?: string;
  description?: string;
  source: string;
  file: string;
  /** Platform of the selected file, or null for a generic recipe. */
  variant: string | null;
  shadows: string[];
  parameters: DiscoveryParameter[];
  variants: DiscoveryRecipeVariant[];
  /**
   * Whether the recipe and every recipe it calls validate against the actions declared in this
   * view. Null in the all-platform view for a recipe that only exists as platform variants.
   */
  runnable: boolean | null;
  problems: DiscoveryProblem[];
}

export interface DiscoveryRecipeDetail extends DiscoveryRecipe {
  path: string;
  /** How the name was resolved: by ref precedence or by an explicit `<library>.<ref>` id. */
  resolvedBy: 'ref' | 'id';
  proofTargets: unknown;
  /** Actions used by the recipe and every recipe it calls. */
  actions: string[];
  /** Recipes called directly or transitively. */
  nestedRecipes: string[];
  unresolvedRecipes: string[];
  /** Recipes in this view that call this recipe directly. */
  callers: string[];
  runCommand: string;
}

export interface ListEnvelope extends DiscoveryEnvelope {
  command: 'list';
  platform: string | null;
  platforms: string[];
  libraries: DiscoveryLibrary[];
  recipes: DiscoveryRecipe[];
}

export interface ActionsEnvelope extends DiscoveryEnvelope {
  command: 'actions';
  platform: string | null;
  libraries: DiscoveryLibrary[];
  actions: DiscoveryAction[];
}

export interface DescribeEnvelope extends DiscoveryEnvelope {
  command: 'describe';
  platform: string | null;
  libraries: DiscoveryLibrary[];
  kind: 'recipe' | 'action';
  recipe?: DiscoveryRecipeDetail;
  action?: DiscoveryActionDetail;
}

export interface ExplainParameter {
  name: string;
  value?: unknown;
  /**
   * `input` (given on the command line or by the caller node), `default` (paramsSchema),
   * or `missing` (required, no value).
   */
  from: 'input' | 'default' | 'missing';
  /** Raw caller value when it was a template, e.g. `{{params.symbol}}`. */
  template?: string;
}

export interface ExplainActionNode {
  nodeId: string;
  kind: 'action';
  action: string;
  phase: 'main' | 'teardown' | 'unreachable';
}

export interface ExplainCallNode {
  nodeId: string;
  kind: 'call';
  ref: string;
  phase: 'main' | 'teardown' | 'unreachable';
  /** Resolved callee, or null when no library provides it. */
  recipe: ExplainRecipeNode | null;
}

export interface ExplainRecipeNode {
  ref: string;
  source: string | null;
  file: string | null;
  variant: string | null;
  parameters: ExplainParameter[];
  nodes: Array<ExplainActionNode | ExplainCallNode>;
}

export interface ExplainRequiredAction {
  name: string;
  declared: boolean;
  source: string | null;
  handler: DiscoveryActionHandler | null;
  capabilities: RecipeExecutionCapability[];
  /** `<recipe ref>#<node id>` for every use. */
  usedBy: string[];
}

export interface ExplainEnvelope extends DiscoveryEnvelope {
  command: 'explain';
  platform: string | null;
  libraries: DiscoveryLibrary[];
  recipe: ExplainRecipeNode;
  requiredActions: ExplainRequiredAction[];
  capabilities: RecipeExecutionCapability[];
  missing: {
    parameters: Array<{ recipe: string; name: string }>;
    recipes: Array<{ from: string; ref: string }>;
    actions: Array<{ name: string; usedBy: string[] }>;
    /** Declared actions whose handler comes from a platform adapter this CLI does not load. */
    handlers: string[];
    problems: DiscoveryProblem[];
  };
  /** The runner's static resolution document, present when every call resolves. */
  resolution: RecipeResolutionDocument | null;
}

export interface SearchResult {
  kind: 'action' | 'recipe';
  name: string;
  score: number;
  source: string | null;
  description: string;
}

export interface SearchEnvelope extends DiscoveryEnvelope {
  command: 'search';
  platform: string | null;
  query: string;
  results: SearchResult[];
}

export interface TemplateEnvelope extends DiscoveryEnvelope {
  command: 'template';
  platform: string | null;
  kind: 'recipe' | 'action';
  name: string;
  /** A workflow node ready to paste into a recipe. */
  node: Record<string, unknown>;
  /** A complete recipe document wrapping the node. */
  recipe: Record<string, unknown>;
  /** Command that runs the recipe or a recipe wrapping the action. */
  runCommand: string;
}

export interface CompletionsEnvelope extends DiscoveryEnvelope {
  command: 'completions';
  kind: 'commands' | 'actions' | 'recipes';
  candidates: string[];
}

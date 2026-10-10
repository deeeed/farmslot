// The context one invocation resolved (context.ts): which adapter, target and
// slot a command acts on, and where each came from. Kept apart from the
// resolver so the commands and output modules read it without importing the
// plugin loader.
import path from 'node:path';

import type { RecipeConformanceSource } from '@farmslot/protocol';
import type { RecipeLibrarySource } from '@farmslot/recipe-runner';

import { CliError } from './cli-error.js';

/** Where a context value came from, strongest first. */
export type ContextSource = 'flag' | 'binding' | 'slot' | 'detect' | 'default';

/** The detect predicate that matched a checkout. */
export type DetectMatch = 'remote' | 'files';

export interface HarnessContext {
  project?: ResolvedProjectBinding;
  /** The owned binding file actually read, including an explicit runtime-dir environment override. */
  runtimeConfigPath?: string;
  adapter?: {
    value: string;
    /** Selected target alias before provider normalization, such as ios or android. */
    requested?: string;
    source: ContextSource;
    /**
     * The human label: '--adapter', '--platform' or 'positional' (flag),
     * 'runtime-context' (binding), 'slot-config' (slot), the matched predicates
     * joined by '+' (detect), 'default'.
     */
    detail: string;
    /** The predicates that matched, for source 'detect'. */
    matched?: DetectMatch[];
    /** The library that declares the adapter, when it is a plugin. */
    library?: string;
  };
  target: { value: string; source: 'flag' | 'default'; detail: '--target' | 'cwd' };
  /**
   * The checkout's slot. `source: 'none'` (value null) when the runtime context
   * names no slot either: detail 'no-pool-dir' when no pool directory is known,
   * 'not-in-pool' (with `poolDir`) when the pool maps no slot to the checkout.
   */
  slot?:
    | {
        value: string;
        source: 'slot' | 'binding';
        detail: 'slot-config' | 'slot-config (~/farmslot-node/pool)' | 'runtime-context';
        session?: string;
        poolFile?: string;
        /** Matched pool slot when a scratch runtime supplies a different identity. */
        poolSlot?: string;
        ports: Record<string, number>;
      }
    | { value: null; source: 'none'; detail: 'no-pool-dir' }
    | { value: null; source: 'none'; detail: 'not-in-pool'; poolDir: string };
  /**
   * A runtime context the checkout would have read (an inherited
   * RECIPE_RUNTIME_CONTEXT) whose repoRoot is another checkout: it binds no
   * adapter or slot here.
   */
  ignoredBinding?: { path: string; repoRoot: string | null };
  /**
   * The generic ports the command takes. 'flag': a spelling of the option was
   * typed (`value` when the spellings agree). 'env': the user's environment
   * holds it (`filled: false`, left to the adapter). 'slot': the slot's port,
   * set in the environment the adapters read (`filled: true`, `via: 'env'`,
   * `names` the variables set; `invalidEnv` names a non-port value it replaced). The command's argv is
   * never changed. Adapter-specific ports stay in `slot.ports`.
   */
  ports?: Partial<
    Record<
      ContextPortName,
      {
        value?: number;
        source: 'flag' | 'env' | 'slot';
        filled?: boolean;
        via?: 'env';
        /** The environment names a fill set. */
        names?: readonly string[];
        invalidEnv?: { name: string; value: string };
      }
    >
  >;
}

export interface ResolvedProjectLibrary extends RecipeLibrarySource {
  name: string;
  owner?: string;
  revision?: string;
  identity: RecipeConformanceSource;
  overriddenSource?: { root: string; owner: string; revision?: string };
}

export interface ResolvedProjectBinding {
  name: string;
  source: ContextSource;
  root: string;
  configPath: string;
  checkoutRoot: string;
  app?: string;
  domain?: string;
  template?: string;
  manifest?: string;
  runtimeDir: string;
  farmRuntimeDir: string;
  artifactDir: string;
  provider: {
    ref: string;
    module: string;
    export: string;
    package?: string;
    version?: string;
    root: string;
    revision?: string;
    identity: RecipeConformanceSource;
    authority: 'configured' | 'installed' | 'discovered';
  };
  libraries: ResolvedProjectLibrary[];
}

export class ProjectBindingError extends CliError {
  readonly details?: { candidates: readonly string[] };
  constructor(
    readonly code: string,
    message: string,
    readonly userAction: string,
    readonly candidates?: readonly string[],
  ) {
    super(candidates?.length ? `${message} Candidates: ${candidates.join(', ')}.` : message, 2);
    this.name = 'ProjectBindingError';
    if (candidates) this.details = { candidates };
  }
}

/** A generic port option a command may take: `--cdp-port`, `--watcher-port`. */
export type ContextPortName = 'cdp' | 'watcher';

/** One adapter whose detect predicates matched a checkout. */
export interface AdapterCandidate {
  adapter: string;
  matched: DetectMatch[];
  library?: string;
}

/** More than one adapter matched a checkout, with nothing to choose between them. Exit 2. */
export class AdapterAmbiguousError extends CliError {
  readonly code = 'ADAPTER_AMBIGUOUS';
  readonly userAction: string;
  readonly candidates: AdapterCandidate[];
  constructor(target: string, candidates: AdapterCandidate[]) {
    const listed = candidates
      .map((candidate) => `${candidate.adapter} (${candidate.matched.join(', ')})`)
      .join(', ');
    // EXIT.usage; shared.ts imports this module, so the value is spelled here.
    super(`${target} matches more than one adapter: ${listed}`, 2);
    this.name = 'AdapterAmbiguousError';
    this.candidates = candidates;
    this.userAction = `pass --adapter <${candidates.map((candidate) => candidate.adapter).join('|')}>`;
  }
}

let current: HarnessContext | undefined;

/** Record the invocation's context; undefined clears it. */
export function setHarnessContext(context: HarnessContext | undefined): void {
  current = context;
}

/** The context createHarnessCli resolved for this invocation, if any. */
export function harnessContext(): HarnessContext | undefined {
  return current;
}

/**
 * The adapter the resolved context names for `target`, or undefined when no
 * context was resolved for it. Commands take it after their own flags.
 */
export function contextAdapter(target: string): string | undefined {
  return current?.target.value === path.resolve(target) ? current.adapter?.value : undefined;
}

/** `{ context }` for a command's --json envelope, or nothing outside a resolved invocation. */
export function harnessContextField(): { context?: HarnessContext } {
  return current ? { context: current } : {};
}

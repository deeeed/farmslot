// The context one invocation resolved (context.ts): which adapter, target and
// slot a command acts on, and where each came from. Kept apart from the
// resolver so the commands and output modules read it without importing the
// plugin loader.
import path from 'node:path';

/** Where a context value came from, strongest first. */
export type ContextSource = 'flag' | 'binding' | 'slot' | 'detect' | 'default';

/** The detect predicate that matched a checkout. */
export type DetectMatch = 'remote' | 'files';

export interface HarnessContext {
  adapter?: {
    value: string;
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
   * The checkout's slot. `source: 'none'` (value null, detail 'no-pool-dir')
   * when no pool directory is known and the runtime context names no slot, so
   * the slot could not be looked up; absent when the pool maps no slot here.
   */
  slot?:
    | {
        value: string;
        source: 'slot' | 'binding';
        detail: 'slot-config' | 'runtime-context';
        session?: string;
        poolFile?: string;
        ports: Record<string, number>;
      }
    | { value: null; source: 'none'; detail: 'no-pool-dir' };
}

/** One adapter whose detect predicates matched a checkout. */
export interface AdapterCandidate {
  adapter: string;
  matched: DetectMatch[];
  library?: string;
}

/** More than one adapter matched a checkout, with nothing to choose between them. */
export class AdapterAmbiguousError extends Error {
  readonly code = 'ADAPTER_AMBIGUOUS';
  /** Usage: EXIT.usage. */
  readonly exitCode = 2;
  readonly userAction: string;
  readonly candidates: AdapterCandidate[];
  constructor(target: string, candidates: AdapterCandidate[]) {
    const listed = candidates
      .map((candidate) => `${candidate.adapter} (${candidate.matched.join(', ')})`)
      .join(', ');
    super(`${target} matches more than one adapter: ${listed}`);
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

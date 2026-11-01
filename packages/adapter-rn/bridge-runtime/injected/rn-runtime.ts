/**
 * Generic React Native agentic runtime, injected over CDP into a Metro dev
 * bundle (Hermes). Nothing here is bundled into the app: the host preset
 * (L3) bundles this file with its own extension into one IIFE and evaluates
 * it through Runtime.evaluate.
 *
 * Mechanisms (no in-app seam needed):
 * - Metro dev registry: `__r.getModules()` with `verboseName` paths, `__r(id)`.
 * - React DevTools hook: `__REACT_DEVTOOLS_GLOBAL_HOOK__` renderers/roots.
 * - React Refresh: `register` + `performReactRefresh` to swap an always-mounted
 *   leaf component for the step HUD.
 *
 * The fiber helpers and the UI members below are ported unchanged from
 * MetaMask Mobile `app/dev-tools/AgenticService/AgenticService.ts` (main,
 * 032bc6d0eee). Marked blocks say which source lines they copy.
 */

// ─── Metro module registry ──────────────────────────────────────────────────

interface MetroModuleRecord {
  verboseName?: string;
  isInitialized?: boolean;
  hasError?: boolean;
  dependencyMap?: number[];
  publicModule?: { exports?: unknown };
}

interface MetroRequire {
  (moduleId: number): unknown;
  getModules?: () => Map<number, MetroModuleRecord>;
}

/** One app module the runtime needs, located by its Metro path. */
export interface ModuleSpec {
  key: string;
  /** Metro `verboseName` candidates, most specific first. */
  paths: string[];
  /**
   * Returns null when the exports have the expected shape, otherwise a short
   * reason. Runs after `__r(id)`.
   */
  shape: (exports: Record<string, unknown>) => string | null;
  /** Require on first use instead of at install, like Metro inline requires. */
  lazy?: boolean;
  /** Missing modules are tolerated (feature-detected) instead of fatal. */
  optional?: boolean;
}

export interface ResolvedModule {
  key: string;
  id: number | null;
  path: string | null;
  initializedBeforeResolve: boolean | null;
  shape: 'ok' | 'pending' | string;
  exports: Record<string, unknown> | null;
}

function metroRequire(): MetroRequire {
  const r = (globalThis as { __r?: MetroRequire }).__r;
  if (typeof r !== 'function' || typeof r.getModules !== 'function') {
    throw new Error(
      'Metro dev registry is missing: globalThis.__r.getModules is not a function (release bundle?)',
    );
  }
  return r;
}

let moduleIdsByPath: Map<string, number> | null = null;

function indexModulePaths(): Map<string, number> {
  const index = new Map<string, number>();
  const modules = metroRequire().getModules?.() ?? new Map();
  modules.forEach((record, id) => {
    if (record?.verboseName) index.set(record.verboseName, id);
  });
  moduleIdsByPath = index;
  return index;
}

export function getModuleRecord(id: number): MetroModuleRecord | undefined {
  return metroRequire().getModules?.()?.get(id);
}

/** Find a module id by path; the index is rebuilt once on a miss (lazy bundles). */
export function findModuleId(paths: string[]): { id: number; path: string } | null {
  for (const attempt of [0, 1]) {
    const index =
      attempt === 0 && moduleIdsByPath ? moduleIdsByPath : indexModulePaths();
    for (const path of paths) {
      const id = index.get(path);
      if (id !== undefined) return { id, path };
    }
  }
  return null;
}

export function resolveModule(spec: ModuleSpec, force = false): ResolvedModule {
  const found = findModuleId(spec.paths);
  if (!found) {
    if (spec.optional) {
      return {
        key: spec.key,
        id: null,
        path: null,
        initializedBeforeResolve: null,
        shape: 'missing (optional)',
        exports: null,
      };
    }
    throw new Error(
      `Module "${spec.key}" not found in the Metro registry; tried ${spec.paths.join(', ')}`,
    );
  }
  const record = getModuleRecord(found.id);
  const initialized = Boolean(record?.isInitialized);
  if (spec.lazy && !initialized && !force) {
    return {
      key: spec.key,
      id: found.id,
      path: found.path,
      initializedBeforeResolve: false,
      shape: 'pending',
      exports: null,
    };
  }
  const exports = metroRequire()(found.id) as Record<string, unknown>;
  const problem =
    exports && (typeof exports === 'object' || typeof exports === 'function')
      ? spec.shape(exports)
      : 'exports are not an object';
  return {
    key: spec.key,
    id: found.id,
    path: found.path,
    initializedBeforeResolve: initialized,
    shape: problem ?? 'ok',
    exports: problem ? null : exports,
  };
}

/** Resolves a module map; lazy entries resolve their id now and exports on first use. */
export function createModuleTable(specs: ModuleSpec[]) {
  const resolved = new Map<string, ResolvedModule>();
  const byKey = new Map(specs.map((spec) => [spec.key, spec]));
  const ensure = (key: string, force = false): ResolvedModule => {
    const spec = byKey.get(key);
    if (!spec) throw new Error(`Unknown module key "${key}"`);
    const current = resolved.get(key);
    if (current && current.shape === 'ok') return current;
    const next = resolveModule(spec, force);
    resolved.set(key, next);
    if (next.shape !== 'ok' && next.shape !== 'pending' && !spec.optional) {
      throw new Error(`Module "${key}" at ${next.path} failed its shape check: ${next.shape}`);
    }
    return next;
  };
  specs.forEach((spec) => ensure(spec.key));
  return {
    /** Exports of a module; requires a lazy module on first use. */
    get<T = Record<string, unknown>>(key: string): T {
      const entry = ensure(key, true);
      if (!entry.exports) throw new Error(`Module "${key}" is unavailable (${entry.shape})`);
      return entry.exports as T;
    },
    /** A function export that requires its module only when called. */
    lazyFunction<T extends (...args: never[]) => unknown>(key: string, name: string): T {
      return ((...args: never[]) =>
        (this.get<Record<string, T>>(key)[name] as T)(...args)) as T;
    },
    has(key: string): boolean {
      return Boolean(resolved.get(key)?.id !== null && resolved.get(key));
    },
    /** Resolve every module, including lazy ones, and report id, path and shape. */
    check(): Omit<ResolvedModule, 'exports'>[] {
      return specs.map((spec) => {
        const entry = (() => {
          try {
            return ensure(spec.key, true);
          } catch (error) {
            return {
              key: spec.key,
              id: null,
              path: null,
              initializedBeforeResolve: null,
              shape: String((error as Error).message || error),
              exports: null,
            };
          }
        })();
        const { exports: _exports, ...summary } = entry;
        return summary;
      });
    },
    snapshot(): Omit<ResolvedModule, 'exports'>[] {
      return specs.map((spec) => {
        const entry = resolved.get(spec.key);
        const { exports: _exports, ...summary } = entry ?? {
          key: spec.key,
          id: null,
          path: null,
          initializedBeforeResolve: null,
          shape: 'unresolved',
          exports: null,
        };
        return summary;
      });
    },
  };
}

export type ModuleTable = ReturnType<typeof createModuleTable>;

// ─── Ported: AgenticService.ts:57-110 (fiber types) ─────────────────────────

// ─── Fiber tree types ──────────────────────────────────────────────────────

/**
 * Minimal React fiber node shape used to walk the component tree
 * via __REACT_DEVTOOLS_GLOBAL_HOOK__.
 */
interface FiberNode {
  alternate?: FiberNode | null;
  tag?: number;
  type?: unknown;
  memoizedState?: unknown;
  child: FiberNode | null;
  sibling: FiberNode | null;
  return: FiberNode | null;
  memoizedProps: {
    testID?: string;
    onPress?: (...args: unknown[]) => unknown;
    onChangeText?: (text: string) => void;
    disabled?: boolean;
    isDisabled?: boolean;
    accessibilityState?: { disabled?: boolean };
    [key: string]: unknown;
  } | null;
  stateNode: {
    canonical?: {
      publicInstance?: FiberNode['stateNode'];
    };
    scrollTo?: (opts: { y: number; animated: boolean }) => void;
    scrollToOffset?: (opts: { offset: number; animated: boolean }) => void;
    measure?: (
      callback: (
        x: number,
        y: number,
        width: number,
        height: number,
        pageX: number,
        pageY: number,
      ) => void,
    ) => void;
    measureInWindow?: (
      callback: (x: number, y: number, width: number, height: number) => void,
    ) => void;
    [key: string]: unknown;
  } | null;
}

interface FiberRoot {
  current: FiberNode | null;
}

interface ReactDevToolsHook {
  renderers: Map<number, unknown>;
  getFiberRoots?: (id: number) => Set<FiberRoot>;
}

// ─── Ported: AgenticService.ts:112-123 (HUD step) ───────────────────────────

/** Shape of the __DEV__-only agentic bridge on globalThis. */
interface AgenticHudStep {
  id: string;
  status?: string;
  intent: string;
  progress?: { current?: number; total?: number };
  detail?: string;
  error?: string;
  nodeId?: string;
  debug?: { nodeId?: string; proofTarget?: unknown };
  placement?: 'top' | 'bottom';
}

declare global {
  // eslint-disable-next-line no-var
  var __REACT_DEVTOOLS_GLOBAL_HOOK__: ReactDevToolsHook | undefined;
}

// Bound by createRnMembers() so the ported bodies keep their original names.
let Dimensions: {
  get: (dim: 'window') => { width: number; height: number };
};
let Logger: { log: (...args: unknown[]) => void };

// ─── Ported: AgenticService.ts:312-507 (fiber tree helpers) ─────────────────

// ─── Fiber tree helpers ─────────────────────────────────────────────────────

/**
 * Walk a fiber sub-tree depth-first, calling `visitor` on each node.
 * Returns true as soon as visitor returns true (short-circuit).
 * Sibling traversal is iterative to avoid stack overflow on wide trees.
 */
function walkFiber(
  fiber: FiberNode | null,
  visitor: (f: FiberNode) => boolean,
): boolean {
  let current: FiberNode | null = fiber;
  while (current) {
    if (visitor(current)) return true;
    if (walkFiber(current.child, visitor)) return true;
    current = current.sibling;
  }
  return false;
}

// React Native's renderer uses tag 22 for Offscreen and non-null committed
// memoizedState for its hidden children, even when the native route is active.
const OFFSCREEN_FIBER_TAG = 22;

interface CommittedFiberTree {
  roots: FiberNode[];
  parents: Map<FiberNode, FiberNode | null>;
  inactive: Set<FiberNode>;
}

/** Read visibility from the downward tree, never from render-time return links. */
function indexFiberTree(
  fiber: FiberNode | null,
  tree: CommittedFiberTree,
  parent: FiberNode | null = null,
  parentInactive = false,
): void {
  let current = fiber;
  while (current) {
    tree.parents.set(current, parent);
    const props = current.memoizedProps;
    const styles = Array.isArray(props?.style) ? props.style : [props?.style];
    const inactive =
      parentInactive ||
      (current.tag === OFFSCREEN_FIBER_TAG &&
        current.memoizedState !== null &&
        current.memoizedState !== undefined) ||
      props?.activityState === 0 ||
      styles.some(
        (style) =>
          typeof style === 'object' &&
          style !== null &&
          'display' in style &&
          style.display === 'none',
      );
    if (inactive) tree.inactive.add(current);
    indexFiberTree(current.child, tree, current, inactive);
    current = current.sibling;
  }
}

function createFiberTree(fiber: FiberNode | null): CommittedFiberTree {
  const tree: CommittedFiberTree = {
    roots: fiber ? [fiber] : [],
    parents: new Map(),
    inactive: new Set(),
  };
  indexFiberTree(fiber, tree);
  return tree;
}

function readCommittedFiberTree(): CommittedFiberTree {
  const tree = createFiberTree(null);
  walkFiberRoots((root) => {
    tree.roots.push(root);
    indexFiberTree(root, tree);
    return false;
  });
  return tree;
}

function walkCommittedFiberRoots(
  visitor: (root: FiberNode, tree: CommittedFiberTree) => boolean,
): boolean {
  const tree = readCommittedFiberTree();
  return tree.roots.some((root) => visitor(root, tree));
}

function getFiberOwnerPath(
  fiber: FiberNode,
  tree: CommittedFiberTree,
): FiberNode[] {
  const path: FiberNode[] = [];
  let current: FiberNode | null | undefined = fiber;
  while (current && tree.parents.has(current)) {
    path.push(current);
    current = tree.parents.get(current);
  }
  return path;
}

/** React swaps a mounted fiber with its alternate on ordinary commits. */
function sameFiber(left: FiberNode | null, right: FiberNode | null): boolean {
  return left === right || Boolean(left && right && left.alternate === right);
}

function sameFiberOwnerPath(left: FiberNode[], right: FiberNode[]): boolean {
  return (
    left.length === right.length &&
    left.every((fiber, index) => sameFiber(fiber, right[index]))
  );
}

/** Missing fibers and committed hidden ancestry are both inactive. */
function isFiberInactive(fiber: FiberNode, tree: CommittedFiberTree): boolean {
  return !tree.parents.has(fiber) || tree.inactive.has(fiber);
}

/** Return true when a pressable fiber declares any supported disabled state. */
function isFiberDisabled(fiber: FiberNode): boolean {
  const props = fiber.memoizedProps;
  return (
    props?.disabled === true ||
    props?.isDisabled === true ||
    props?.accessibilityState?.disabled === true
  );
}

/**
 * Find the first fiber node whose `testID` prop matches.
 */
function findFiberByTestId(
  fiber: FiberNode | null,
  testId: string,
  tree = createFiberTree(fiber),
): FiberNode | null {
  let result: FiberNode | null = null;
  walkFiber(fiber, (f) => {
    if (f.memoizedProps?.testID === testId && !isFiberInactive(f, tree)) {
      result = f;
      return true;
    }
    return false;
  });
  return result;
}

/**
 * Collapse matching fibers nested on the same component path. React forwards
 * props through composite components, so one rendered control can expose the
 * same testID and press handler on several ancestor/descendant fibers.
 */
function collapseNestedFibers(
  fibers: FiberNode[],
  tree: CommittedFiberTree,
): FiberNode[] {
  const candidates = new Set(fibers);
  return fibers.filter((fiber) => {
    let ancestor = tree.parents.get(fiber);
    while (ancestor) {
      if (
        candidates.has(ancestor) &&
        ancestor.memoizedProps?.onPress === fiber.memoizedProps?.onPress &&
        isFiberDisabled(ancestor) === isFiberDisabled(fiber) &&
        findMeasurableStateNode(ancestor, false, tree) ===
          findMeasurableStateNode(fiber, false, tree)
      ) {
        return false;
      }
      ancestor = tree.parents.get(ancestor);
    }
    return true;
  });
}

/**
 * Iterate all React renderer roots and call `visitor` on each root fiber.
 * Returns true if any visitor call returns true.
 */
function walkFiberRoots(visitor: (rootFiber: FiberNode) => boolean): boolean {
  const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook?.renderers) return false;

  for (const [id] of hook.renderers) {
    const fiberRoots = hook.getFiberRoots?.(id);
    if (!fiberRoots) continue;
    let found = false;
    fiberRoots.forEach((root) => {
      if (!found && root.current) {
        found = visitor(root.current);
      }
    });
    if (found) return true;
  }
  return false;
}

// ─── Ported: AgenticService.ts:971-1369 (scroll, measure, texts, rows) ──────

/**
 * Walk a fiber sub-tree looking for a scrollable stateNode (scrollTo or
 * scrollToOffset). When `walkSiblings` is false only the child axis is
 * traversed — useful when starting from a testId anchor whose siblings
 * are unrelated components.
 */
function tryScrollStateNode(
  stateNode: FiberNode['stateNode'],
  offset: number,
  animated: boolean,
): boolean {
  const publicInstance = stateNode?.canonical?.publicInstance ?? stateNode;
  if (typeof publicInstance?.scrollTo === 'function') {
    publicInstance.scrollTo({ y: offset, animated });
    return true;
  }
  if (typeof publicInstance?.scrollToOffset === 'function') {
    publicInstance.scrollToOffset({ offset, animated });
    return true;
  }
  return false;
}

function tryScroll(
  start: FiberNode | null,
  offset: number,
  animated: boolean,
  walkSiblings = true,
  tree = createFiberTree(start),
): boolean {
  let current: FiberNode | null = start;
  while (current) {
    if (!isFiberInactive(current, tree)) {
      if (tryScrollStateNode(current.stateNode, offset, animated)) return true;
      if (tryScroll(current.child, offset, animated, true, tree)) return true;
    }
    current = walkSiblings ? current.sibling : null;
  }
  return false;
}

function targetMatches(
  fiber: FiberNode,
  options: { testId?: string; textContains?: string },
  tree: CommittedFiberTree,
): boolean {
  if (options.testId && fiber.memoizedProps?.testID !== options.testId) {
    return false;
  }
  if (options.textContains) {
    const needle = options.textContains.toLowerCase();
    const texts = options.testId
      ? collectFiberTexts(fiber, tree)
      : collectOwnFiberTexts(fiber, tree);
    return texts.some((text) => text.toLowerCase().includes(needle));
  }
  return Boolean(options.testId);
}

function findMeasurableStateNode(
  fiber: FiberNode | null,
  includeAncestors = true,
  tree?: CommittedFiberTree,
): FiberNode['stateNode'] | null {
  const isStandalone = !tree && !globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!tree) {
    tree = readCommittedFiberTree();
  }
  // An installed hook owns membership even when it has no mounted roots.
  if (isStandalone) {
    let root = fiber;
    while (root?.return) root = root.return;
    tree = createFiberTree(root);
    if (fiber && !tree.parents.has(fiber))
      indexFiberTree(fiber, tree, fiber.return);
  }
  const committedTree = tree;
  if (fiber && isFiberInactive(fiber, committedTree)) return null;
  const resolveMeasurableStateNode = (node: FiberNode) => {
    if (isFiberInactive(node, committedTree)) return null;
    const stateNode = node.stateNode;
    const publicInstance = stateNode?.canonical?.publicInstance ?? stateNode;
    return publicInstance &&
      (typeof publicInstance.measureInWindow === 'function' ||
        typeof publicInstance.measure === 'function')
      ? publicInstance
      : null;
  };

  let result = fiber ? resolveMeasurableStateNode(fiber) : null;
  walkFiber(fiber?.child ?? null, (node) => {
    const descendant = resolveMeasurableStateNode(node);
    if (descendant) {
      result = descendant;
      return true;
    }
    return false;
  });

  let ancestor =
    includeAncestors && fiber ? committedTree.parents.get(fiber) : null;
  while (!result && ancestor) {
    result = resolveMeasurableStateNode(ancestor);
    ancestor = committedTree.parents.get(ancestor);
  }
  return result;
}

function measureStateNode(
  stateNode: FiberNode['stateNode'],
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (!stateNode) {
      resolve(null);
      return;
    }
    let settled = false;
    const settle = (
      value: { x: number; y: number; width: number; height: number } | null,
    ) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // Native measure callbacks never fire for detached/off-screen views;
    // fall back to null after a short delay so callers don't hang forever.
    const timeout = setTimeout(() => settle(null), 2500);
    const finish = (x: number, y: number, width: number, height: number) => {
      clearTimeout(timeout);
      settle({ x, y, width, height });
    };
    try {
      if (typeof stateNode.measureInWindow === 'function') {
        stateNode.measureInWindow(finish);
        return;
      }
      if (typeof stateNode.measure === 'function') {
        stateNode.measure((_x, _y, width, height, pageX, pageY) =>
          finish(pageX, pageY, width, height),
        );
        return;
      }
    } catch (e) {
      Logger.log(String(e), 'AgenticService.measureStateNode');
    }
    clearTimeout(timeout);
    settle(null);
  });
}

async function queryUiTarget(options: {
  testId?: string;
  textContains?: string;
  visibility?: 'tree' | 'viewport';
}): Promise<{
  present: boolean;
  visible: boolean;
  visibility: 'tree' | 'viewport';
  testId?: string;
  textContains?: string;
  textMatched?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  viewport?: { width: number; height: number };
  error?: string;
}> {
  const visibility: 'tree' | 'viewport' =
    options.visibility === 'viewport' ? 'viewport' : 'tree';
  const select = () => {
    const tree = readCommittedFiberTree();
    const targets: FiberNode[] = [];
    tree.roots.forEach((root) =>
      walkFiber(root, (fiber) => {
        if (
          !isFiberInactive(fiber, tree) &&
          targetMatches(fiber, options, tree)
        )
          targets.push(fiber);
        return false;
      }),
    );
    return { target: targets[0] ?? null, targets, tree };
  };
  const original = select();
  const { target, tree } = original;
  const evidence = (
    current: FiberNode | null,
    currentTree: CommittedFiberTree,
  ) => ({
    present: Boolean(current),
    visible: Boolean(current) && visibility === 'tree',
    visibility,
    testId: options.testId,
    textContains: options.textContains,
    textMatched: options.textContains
      ? Boolean(current && targetMatches(current, options, currentTree))
      : undefined,
  });
  const base = evidence(target, tree);
  if (!target || visibility === 'tree') return base;

  const stateNode = findMeasurableStateNode(target, true, tree);
  if (!stateNode) {
    return {
      ...base,
      visible: false,
      error:
        'Target exists in fiber tree but no measurable native node was found',
    };
  }

  const ownerPath = getFiberOwnerPath(target, tree);
  const rect = await measureStateNode(stateNode);
  const current = select();
  const currentTarget = current.target;
  if (
    !currentTarget ||
    !sameFiber(currentTarget, target) ||
    current.targets.length !== original.targets.length ||
    !current.targets.every((fiber) =>
      original.targets.some((originalFiber) => sameFiber(fiber, originalFiber)),
    ) ||
    isFiberInactive(currentTarget, current.tree) ||
    !sameFiberOwnerPath(
      ownerPath,
      getFiberOwnerPath(currentTarget, current.tree),
    ) ||
    findMeasurableStateNode(currentTarget, true, current.tree) !== stateNode ||
    !targetMatches(currentTarget, options, current.tree)
  ) {
    return {
      ...evidence(null, current.tree),
      visible: false,
      error: 'Target changed during measurement; no current viewport evidence',
    };
  }
  const currentBase = evidence(currentTarget, current.tree);
  const viewport = Dimensions.get('window');
  if (!rect) {
    return {
      ...currentBase,
      visible: false,
      viewport: { width: viewport.width, height: viewport.height },
      error: 'Target exists in fiber tree but measurement returned no frame',
    };
  }

  const visible =
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x < viewport.width &&
    rect.y < viewport.height &&
    rect.x + rect.width > 0 &&
    rect.y + rect.height > 0;

  return {
    ...currentBase,
    visible,
    rect,
    viewport: { width: viewport.width, height: viewport.height },
  };
}

function appendTextContent(value: unknown, out: string[]) {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    if (text.length > 0) {
      out.push(text);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => appendTextContent(entry, out));
    return;
  }
  if (typeof value === 'object' && value && 'props' in value) {
    const maybeProps = (value as { props?: { children?: unknown } }).props;
    if (maybeProps?.children !== undefined) {
      appendTextContent(maybeProps.children, out);
    }
  }
}

function dedupeTexts(texts: string[]): string[] {
  return texts.filter((text, index) => texts.indexOf(text) === index);
}

function collectFiberTexts(
  fiber: FiberNode | null,
  tree: CommittedFiberTree,
): string[] {
  const texts = collectOwnFiberTexts(fiber, tree);
  walkFiber(fiber?.child ?? null, (node) => {
    texts.push(...collectOwnFiberTexts(node, tree));
    return false;
  });
  return dedupeTexts(texts);
}

function collectOwnFiberTexts(
  fiber: FiberNode | null,
  tree: CommittedFiberTree,
): string[] {
  const texts: string[] = [];
  if (fiber && !fiber.child && !isFiberInactive(fiber, tree)) {
    // Committed children are authoritative. Ancestor element props can still
    // describe retained hidden content. HostText leaves store primitive props.
    const props: unknown = fiber.memoizedProps;
    appendTextContent(
      typeof props === 'string' || typeof props === 'number'
        ? props
        : fiber.memoizedProps?.children,
      texts,
    );
  }
  return dedupeTexts(texts);
}

function findAncestorTexts(
  fiber: FiberNode | null,
  predicate: (texts: string[]) => boolean,
  maxTexts: number,
  tree: CommittedFiberTree,
): string[] | null {
  let current = fiber;
  while (current) {
    const texts = collectFiberTexts(current, tree);
    if (texts.length > 0 && texts.length <= maxTexts && predicate(texts)) {
      return texts;
    }
    current = tree.parents.get(current) ?? null;
  }
  return null;
}

function findRowTexts(
  label: string,
  options: {
    anchorTestId?: string;
    requiredLabels?: string[];
    maxTexts?: number;
  } = {},
): string[] | null {
  const { anchorTestId, requiredLabels = [], maxTexts = 14 } = options;
  const matchesRow = (texts: string[]) =>
    texts.includes(label) &&
    requiredLabels.every((requiredLabel) => texts.includes(requiredLabel));

  if (anchorTestId) {
    let anchoredMatch: string[] | null = null;
    walkCommittedFiberRoots((rootFiber, tree) => {
      const anchor = findFiberByTestId(rootFiber, anchorTestId, tree);
      if (!anchor) {
        return false;
      }
      anchoredMatch = findAncestorTexts(anchor, matchesRow, maxTexts, tree);
      return Boolean(anchoredMatch);
    });
    if (anchoredMatch) {
      return anchoredMatch;
    }
  }

  let fallbackMatch: string[] | null = null;
  walkCommittedFiberRoots((rootFiber, tree) =>
    walkFiber(rootFiber, (fiber) => {
      const texts = collectFiberTexts(fiber, tree);
      if (texts.length === 0 || texts.length > maxTexts) {
        return false;
      }
      if (!matchesRow(texts)) {
        return false;
      }
      fallbackMatch = texts;
      return true;
    }),
  );

  return fallbackMatch;
}

function getRowValue(
  label: string,
  pattern: string,
  options: {
    anchorTestId?: string;
    requiredLabels?: string[];
    maxTexts?: number;
  } = {},
): string | null {
  const rowTexts = findRowTexts(label, options);
  if (!rowTexts) {
    return null;
  }
  const matcher = new RegExp(pattern);
  return rowTexts.find((text) => text !== label && matcher.test(text)) ?? null;
}

// ─── Generic UI members ─────────────────────────────────────────────────────

export interface RnMemberDeps {
  Dimensions: typeof Dimensions;
  Logger: typeof Logger;
}

/**
 * The generic `__AGENTIC__` UI members. Each property body is copied from
 * AgenticService.ts:1420-1751 and 1790-1801 without change.
 */
export function createRnMembers(deps: RnMemberDeps) {
  Dimensions = deps.Dimensions;
  Logger = deps.Logger;
  return {
      pressTestIdScopeVersion: 1,
      pressTestId: async (
        testId: string,
        options?: { ancestorTestId: string },
      ) => {
        try {
          if (options && !options.ancestorTestId)
            return {
              ok: false,
              testId,
              error: 'Exact ancestor scope is required',
            };
          const select = () => {
            const tree = readCommittedFiberTree();
            const ancestors: FiberNode[] = [];
            if (options)
              tree.roots.forEach((root) =>
                walkFiber(root, (fiber) => {
                  if (
                    fiber.memoizedProps?.testID === options.ancestorTestId &&
                    !isFiberInactive(fiber, tree)
                  )
                    ancestors.push(fiber);
                  return false;
                }),
              );
            const distinctAncestors = collapseNestedFibers(ancestors, tree);
            const ancestor =
              distinctAncestors.length === 1 ? distinctAncestors[0] : null;
            const candidates: FiberNode[] = [];
            const collect = (fiber: FiberNode) => {
              if (
                fiber.memoizedProps?.testID === testId &&
                typeof fiber.memoizedProps?.onPress === 'function' &&
                !isFiberInactive(fiber, tree)
              )
                candidates.push(fiber);
              return false;
            };
            if (options) walkFiber(ancestor?.child ?? null, collect);
            else tree.roots.forEach((root) => walkFiber(root, collect));
            return {
              tree,
              ancestor,
              candidates: collapseNestedFibers(candidates, tree),
            };
          };
          const original = select();
          if (
            options &&
            (!original.ancestor || original.candidates.length !== 1)
          )
            return {
              ok: false,
              testId,
              error: 'Scoped control or ancestor is missing or ambiguous',
            };
          const { tree, candidates: distinctCandidates } = original;
          const selections = new Map(
            distinctCandidates.map((fiber) => [
              fiber,
              {
                handler: fiber.memoizedProps?.onPress,
                stateNode: findMeasurableStateNode(fiber, false, tree),
                ownerPath: getFiberOwnerPath(fiber, tree),
              },
            ]),
          );
          const viewport = Dimensions.get('window');
          const measuredCandidates = await Promise.all(
            distinctCandidates.map(async (fiber) => ({
              fiber,
              rect: await measureStateNode(
                selections.get(fiber)?.stateNode ?? null,
              ),
            })),
          );
          const visibleCandidate = measuredCandidates.find(({ rect }) =>
            Boolean(
              rect &&
                rect.width > 0 &&
                rect.height > 0 &&
                rect.x < viewport.width &&
                rect.y < viewport.height &&
                rect.x + rect.width > 0 &&
                rect.y + rect.height > 0,
            ),
          )?.fiber;
          const candidate =
            visibleCandidate ??
            (distinctCandidates.length === 1 ? distinctCandidates[0] : null);
          if (!candidate) {
            return {
              ok: false,
              testId,
              error:
                distinctCandidates.length > 1
                  ? `No visible component with testID="${testId}" found among duplicate matches`
                  : `No component with testID="${testId}" found or no onPress prop`,
            };
          }
          const current = select();
          const selection = selections.get(candidate);
          const currentCandidate = current.candidates.find((fiber) =>
            sameFiber(fiber, candidate),
          );
          if (
            !selection ||
            !currentCandidate ||
            isFiberInactive(currentCandidate, current.tree) ||
            !sameFiberOwnerPath(
              selection.ownerPath,
              getFiberOwnerPath(currentCandidate, current.tree),
            ) ||
            current.candidates.length !== distinctCandidates.length ||
            !current.candidates.every((fiber) =>
              distinctCandidates.some((originalFiber) =>
                sameFiber(fiber, originalFiber),
              ),
            ) ||
            currentCandidate.memoizedProps?.onPress !== selection.handler ||
            findMeasurableStateNode(currentCandidate, false, current.tree) !==
              selection.stateNode ||
            !sameFiber(current.ancestor, original.ancestor)
          ) {
            return {
              ok: false,
              testId,
              error: `Component with testID="${testId}" changed or became inactive; no press attempted`,
            };
          }
          if (isFiberDisabled(currentCandidate)) {
            return {
              ok: false,
              testId,
              error: `Component with testID="${testId}" is disabled`,
            };
          }
          if (
            options &&
            (!current.ancestor ||
              isFiberDisabled(current.ancestor) ||
              !visibleCandidate)
          )
            return {
              ok: false,
              testId,
              error:
                'Scoped control changed or is not visible; no press attempted',
            };
          currentCandidate.memoizedProps?.onPress?.();
          return { ok: true, testId };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
      pressText: (
        text: string,
        options: { requiredTexts?: string[]; maxTexts?: number } = {},
      ) => {
        const { requiredTexts = [], maxTexts = 14 } = options;
        try {
          let bestMatch: FiberNode | null = null;
          let bestTextCount = Number.POSITIVE_INFINITY;
          walkCommittedFiberRoots((rootFiber, tree) =>
            walkFiber(rootFiber, (fiber) => {
              if (
                typeof fiber.memoizedProps?.onPress !== 'function' ||
                isFiberInactive(fiber, tree)
              ) {
                return false;
              }
              const texts = collectFiberTexts(fiber, tree);
              if (texts.length === 0 || texts.length > maxTexts) {
                return false;
              }
              if (!texts.includes(text)) {
                return false;
              }
              if (requiredTexts.some((required) => !texts.includes(required))) {
                return false;
              }
              if (texts.length < bestTextCount) {
                bestMatch = fiber;
                bestTextCount = texts.length;
              }
              return false;
            }),
          );
          const matched = bestMatch as FiberNode | null;
          if (matched && typeof matched.memoizedProps?.onPress === 'function') {
            if (isFiberDisabled(matched)) {
              return {
                ok: false,
                text,
                error: `Pressable for text="${text}" is disabled`,
              };
            }
            matched.memoizedProps.onPress();
            return { ok: true, text };
          }
          return {
            ok: false,
            error: `No pressable found for text="${text}"`,
          };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
      scrollView: (
        options: {
          testId?: string;
          offset?: number;
          animated?: boolean;
        } = {},
      ) => {
        const {
          testId: scrollTestId,
          offset = 300,
          animated = false,
        } = options;
        try {
          const found = walkCommittedFiberRoots((rootFiber, tree) => {
            if (scrollTestId) {
              const anchor = findFiberByTestId(rootFiber, scrollTestId, tree);
              if (!anchor) return false;
              if (tryScroll(anchor, offset, animated, false, tree)) return true;
              let ancestor = tree.parents.get(anchor);
              while (ancestor) {
                if (tryScrollStateNode(ancestor.stateNode, offset, animated)) {
                  return true;
                }
                ancestor = tree.parents.get(ancestor);
              }
              return false;
            }
            return tryScroll(rootFiber, offset, animated, true, tree);
          });
          if (found)
            return { ok: true, testId: scrollTestId, offset, animated };
          return {
            ok: false,
            error: scrollTestId
              ? `No scrollable found near testID="${scrollTestId}"`
              : 'No scrollable found in fiber tree',
          };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
      setInput: (testId: string, value: string) => {
        try {
          const result: {
            ok: boolean;
            testId?: string;
            value?: string;
            error?: string;
          } = {
            ok: false,
            error: `No component with testID="${testId}" found`,
          };
          walkCommittedFiberRoots((rootFiber, tree) => {
            const target = findFiberByTestId(rootFiber, testId, tree);
            if (!target) return false;
            // Walk the found fiber and its parents looking for onChangeText
            let current: FiberNode | null = target;
            while (current) {
              if (typeof current.memoizedProps?.onChangeText === 'function') {
                current.memoizedProps.onChangeText(value);
                result.ok = true;
                result.testId = testId;
                result.value = value;
                result.error = undefined;
                return true;
              }
              current = tree.parents.get(current) ?? null;
            }
            result.error = `Component with testID="${testId}" has no onChangeText prop`;
            return true;
          });
          return result;
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
      getTextByTestId: (testId: string, options: { all?: boolean } = {}) => {
        let texts: string[] | null = null;
        walkCommittedFiberRoots((rootFiber, tree) => {
          const target = findFiberByTestId(rootFiber, testId, tree);
          if (!target) {
            return false;
          }
          texts = collectFiberTexts(target, tree);
          return true;
        });
        const collected = texts as string[] | null;
        if (!collected || collected.length === 0) {
          return null;
        }
        return options.all ? collected : collected[0];
      },
      getAncestorTextsByTestId: (
        testId: string,
        options: { requiredLabels?: string[]; maxTexts?: number } = {},
      ) => {
        const { requiredLabels = [], maxTexts = 14 } = options;
        let texts: string[] | null = null;
        walkCommittedFiberRoots((rootFiber, tree) => {
          const target = findFiberByTestId(rootFiber, testId, tree);
          if (!target) {
            return false;
          }
          texts = findAncestorTexts(
            target,
            (candidateTexts) =>
              requiredLabels.every((label) => candidateTexts.includes(label)),
            maxTexts,
            tree,
          );
          return Boolean(texts);
        });
        return texts;
      },
      getRowValue: (
        label: string,
        pattern: string,
        options: {
          anchorTestId?: string;
          requiredLabels?: string[];
          maxTexts?: number;
        } = {},
      ) => getRowValue(label, pattern, options),
      findFiberByTestId: (testId: string): boolean => {
        let found = false;
        walkCommittedFiberRoots((rootFiber, tree) => {
          if (findFiberByTestId(rootFiber, testId, tree)) {
            found = true;
            return true;
          }
          return false;
        });
        return found;
      },
      queryUiTarget,
  };
}

export {
  walkFiber,
  walkFiberRoots,
  walkCommittedFiberRoots,
  readCommittedFiberTree,
  findFiberByTestId,
  isFiberInactive,
  collectFiberTexts,
};
export type { FiberNode, CommittedFiberTree, AgenticHudStep };

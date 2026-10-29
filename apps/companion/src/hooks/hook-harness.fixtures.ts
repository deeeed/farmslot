import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import ts from 'typescript';

export interface MountedHook<Args extends unknown[]> {
  /** Calls the hook as one render, then runs the effects whose deps changed. */
  render(...args: Args): unknown;
  /** Runs every effect cleanup, as an unmount does. */
  cleanup(): void;
}

/**
 * Executes a hook module's real code in node tests with deterministic React scheduling.
 * `dependencies` stubs every module the hook imports besides react; an unknown import fails.
 */
export function mountHook<Args extends unknown[]>(
  moduleUrl: URL,
  exportName: string,
  dependencies: Record<string, unknown>,
  globals: Record<string, unknown> = {},
): MountedHook<Args> {
  const cells: unknown[] = [];
  const effects: Array<{ deps: readonly unknown[]; cleanup?: () => void }> = [];
  let cell = 0;
  let effect = 0;
  let pending: Array<() => void> = [];
  const react = {
    useState(initial: unknown) {
      const index = cell++;
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [
        cells[index],
        (next: unknown) => {
          cells[index] = typeof next === 'function' ? next(cells[index]) : next;
        },
      ];
    },
    useRef(initial: unknown) {
      const index = cell++;
      if (!(index in cells)) cells[index] = { current: initial };
      return cells[index];
    },
    useMemo(calculate: () => unknown, deps: readonly unknown[]) {
      const index = cell++;
      const previous = cells[index] as { deps: readonly unknown[]; value: unknown } | undefined;
      if (
        previous &&
        deps.length === previous.deps.length &&
        deps.every((value, at) => Object.is(value, previous.deps[at]))
      )
        return previous.value;
      const value = calculate();
      cells[index] = { deps, value };
      return value;
    },
    useCallback(callback: unknown) {
      return callback;
    },
    useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) {
      return getSnapshot();
    },
    useEffect(callback: () => unknown, deps: readonly unknown[]) {
      const index = effect++;
      const previous = effects[index];
      if (
        previous &&
        deps.length === previous.deps.length &&
        deps.every((value, at) => Object.is(value, previous.deps[at]))
      )
        return;
      pending.push(() => {
        previous?.cleanup?.();
        const cleanup = callback();
        effects[index] = {
          deps,
          ...(typeof cleanup === 'function' ? { cleanup: () => cleanup() } : {}),
        };
      });
    },
  };
  const modules: Record<string, unknown> = { react, ...dependencies };
  const exports: Record<string, unknown> = {};
  const compiled = ts.transpileModule(readFileSync(fileURLToPath(moduleUrl), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(
    compiled,
    {
      exports,
      console,
      // The test's errors and the hook's instanceof checks share one realm.
      Error,
      ...globals,
      require(name: string) {
        if (!(name in modules)) throw new Error(`Unexpected hook dependency ${name}`);
        return modules[name];
      },
    },
    { timeout: 1000 },
  );
  const hook = exports[exportName];
  if (typeof hook !== 'function') throw new Error(`Hook export missing: ${exportName}`);
  return {
    render(...args: Args) {
      cell = 0;
      effect = 0;
      pending = [];
      const result: unknown = hook(...args);
      for (const callback of pending) callback();
      return result;
    },
    cleanup() {
      for (const entry of effects) entry.cleanup?.();
    },
  };
}

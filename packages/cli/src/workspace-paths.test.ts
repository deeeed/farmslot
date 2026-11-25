import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

/** Every non-test source file under packages/cli/src. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return /\.tsx?$/.test(entry.name) && !/\.(test|live)\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

/** The source a `paths` target names, completed as bin/prebuilt-resolve.mjs completes it. */
function complete(file: string): string | undefined {
  return [file, `${file}.ts`, `${file}.tsx`, path.join(file, 'index.ts')].find(
    (candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate),
  );
}

// The node CLI install (scripts/lib/node-cli-refresh.sh) builds dist/ only for the packages
// recipe-cli depends on, and the CLI loads workspace packages through its tsconfig `paths`.
// A workspace import that reaches a dist/ fails there when the install never built it
// (ERR_MODULE_NOT_FOUND for @farmslot/handoff/dist/scrub/index.js from `runs traces export`).
test('every workspace package the CLI imports at runtime resolves to its source', () => {
  const { compilerOptions } = JSON.parse(
    readFileSync(path.join(packageDir, 'tsconfig.json'), 'utf8'),
  ) as { compilerOptions: { paths: Record<string, [string]> } };
  const throughPaths = (specifier: string) => {
    for (const [pattern, [target]] of Object.entries(compilerOptions.paths)) {
      const prefix = pattern.endsWith('/*') ? pattern.slice(0, -1) : undefined;
      if (prefix ? specifier.startsWith(prefix) : specifier === pattern) {
        const file = complete(
          path.resolve(
            packageDir,
            prefix ? target.replace('*', specifier.slice(prefix.length)) : target,
          ),
        );
        if (file) return file;
      }
    }
    return undefined;
  };
  // Without a mapping the resolver falls back to the package's exports, which must name a file
  // that ships as is (such as a script), not a build output.
  const resolve = (specifier: string) => {
    const file = throughPaths(specifier) ?? fileURLToPath(import.meta.resolve(specifier));
    return file.split(path.sep).includes('dist') ? undefined : file;
  };
  const unresolved = new Set<string>();
  for (const file of sources(path.join(packageDir, 'src'))) {
    const code = readFileSync(file, 'utf8');
    // Type-only imports are erased; every other static or dynamic import loads at runtime.
    for (const match of code.matchAll(
      /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;]*?from\s+'(@farmslot\/[^']+)'|import\(\s*'(@farmslot\/[^']+)'\s*\)/g,
    )) {
      const specifier = match[1] ?? match[2];
      if (!resolve(specifier)) unresolved.add(`${specifier} (${path.relative(packageDir, file)})`);
    }
  }
  assert.deepEqual([...unresolved], []);
});

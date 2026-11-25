import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(packageDir, '../..');

/** Every non-test source file under a package's src. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return /\.tsx?$/.test(entry.name) && !/\.(test|live|d)\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

/**
 * The `@farmslot/*` specifiers a file loads at run time: import and export declarations that
 * are not type-only, `import()`, `require()`, `require.resolve()`, `createRequire(...)(...)` and
 * `import.meta.resolve()`. Type queries (`import('x').T`) and comments are not run-time loads.
 */
function runtimeImports(file: string, text = readFileSync(file, 'utf8')): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  const found: string[] = [];
  const add = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node) && node.text.startsWith('@farmslot/'))
      found.push(node.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      // `import type`, or only `type` specifiers: erased, so nothing loads.
      const clause = node.importClause;
      const typeOnly =
        clause !== undefined &&
        (ts.isTypeOnlyImportOrExportDeclaration(clause) ||
          (!clause.name &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)));
      if (!typeOnly) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      const typeOnly =
        node.isTypeOnly ||
        (clause !== undefined &&
          ts.isNamedExports(clause) &&
          clause.elements.length > 0 &&
          clause.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) add(node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loads =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require') ||
        ts.isCallExpression(callee) ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve');
      if (loads) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test('run-time imports are told apart from type-only ones', () => {
  const source = [
    "import type { A } from '@farmslot/type-only';",
    "import { type B, type C } from '@farmslot/type-specifiers';",
    "export type { D } from '@farmslot/type-export';",
    "export { type E } from '@farmslot/type-export-specifier';",
    "type F = import('@farmslot/type-query').F;",
    "// import { G } from '@farmslot/comment';",
    "import { H, type I } from '@farmslot/mixed';",
    "import '@farmslot/side-effect';",
    "export * from '@farmslot/star';",
    "const j = await import(\n  '@farmslot/dynamic', // comment\n);",
    'const k = require("@farmslot/required");',
    "const l = createRequire(import.meta.url)('@farmslot/created');",
    "const m = import.meta.resolve('@farmslot/resolved');",
  ].join('\n');
  assert.deepEqual(runtimeImports('probe.ts', source), [
    '@farmslot/mixed',
    '@farmslot/side-effect',
    '@farmslot/star',
    '@farmslot/dynamic',
    '@farmslot/required',
    '@farmslot/created',
    '@farmslot/resolved',
  ]);
});

// The node CLI install (scripts/lib/node-cli-refresh.sh) builds dist/ only for the packages
// recipe-cli depends on, and the CLI loads workspace packages through its tsconfig `paths`,
// for every importing file (bin/prebuilt-resolve.mjs). An import that reaches a dist/ fails
// where the install never built it (ERR_MODULE_NOT_FOUND for @farmslot/handoff/dist/scrub
// from `runs traces export`).
test('every workspace import the CLI loads resolves to a source file, not a dist/ build', async () => {
  const resolver: unknown = await import(
    pathToFileURL(path.join(packageDir, 'bin/prebuilt-resolve.mjs')).href
  );
  const complete =
    resolver && typeof resolver === 'object' && 'complete' in resolver ? resolver.complete : null;
  assert.equal(typeof complete, 'function');
  const completeSource = (file: string): string | undefined => {
    const found: unknown = (complete as (file: string) => unknown)(file);
    return typeof found === 'string' ? found : undefined;
  };
  const { compilerOptions } = JSON.parse(
    readFileSync(path.join(packageDir, 'tsconfig.json'), 'utf8'),
  ) as { compilerOptions: { paths: Record<string, [string]> } };
  const throughPaths = (specifier: string) => {
    for (const [pattern, [target]] of Object.entries(compilerOptions.paths)) {
      const prefix = pattern.endsWith('/*') ? pattern.slice(0, -1) : undefined;
      if (prefix ? !specifier.startsWith(prefix) : specifier !== pattern) continue;
      const file = completeSource(
        path.resolve(
          packageDir,
          prefix ? target.replace('*', specifier.slice(prefix.length)) : target,
        ),
      );
      if (file) return file;
    }
    return undefined;
  };
  // Without a mapping the resolver falls back to the package's exports, which must name a file
  // that ships as it is (a script), not a build output.
  const resolve = (specifier: string): string | undefined => {
    let file = throughPaths(specifier);
    if (!file) {
      try {
        file = fileURLToPath(import.meta.resolve(specifier));
      } catch {
        // Not exported either: the caller lists the specifier as unresolved.
        return undefined;
      }
    }
    if (!existsSync(file) || path.relative(repoRoot, file).split(path.sep).includes('dist'))
      return undefined;
    return file;
  };
  // The CLI's sources, and those of every workspace package they reach.
  const queue = [path.join(packageDir, 'src')];
  const unresolved = new Set<string>();
  for (const dir of queue)
    for (const file of sources(dir))
      for (const specifier of runtimeImports(file)) {
        const target = resolve(specifier);
        if (!target) {
          unresolved.add(`${specifier} (${path.relative(repoRoot, file)})`);
          continue;
        }
        const src = /^(.*[/\\](?:packages|services)[/\\][^/\\]+[/\\]src)[/\\]/.exec(target)?.[1];
        if (src && !queue.includes(src)) queue.push(src);
      }
  assert.ok(queue.length > 1, 'the scan follows mapped packages');
  assert.deepEqual([...unresolved], []);
});

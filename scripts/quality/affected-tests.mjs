import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { isFragmentPath } from '../release/changelog-fragments.mjs';

import { affectedWorkspaceNames, runtimeImpactFiles } from './workspace-test-targets.mjs';

export const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
export const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function ownerOf(file, workspaces) {
  return [...workspaces]
    .sort((a, b) => b.dir.length - a.dir.length)
    .find(({ dir }) => file.startsWith(`${dir}/`));
}

function resolveSource(candidate, files) {
  const stem = candidate.replace(/\.[cm]?js$/, '');
  return [
    candidate,
    ...[
      '.ts',
      '.tsx',
      '.mts',
      '.cts',
      '.js',
      '.mjs',
      '.cjs',
      '/index.ts',
      '/index.tsx',
      '/index.js',
    ].map((suffix) => `${stem}${suffix}`),
  ].find((file) => files.has(file));
}

// Parse source syntax, not import-shaped comments. Literal runtime references are
// included too: fixtures read through new URL or fs are dependencies of tests.
export function sourceReferences(source, file) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const references = new Set();
  const modules = new Set();
  let dynamic = false;
  let runtimeRead = false;
  function visit(node) {
    // Tests also execute/copy source files by literal path. Keep those edges
    // without treating production metadata descriptions as imports.
    if (TEST_FILE.test(file) && ts.isStringLiteralLike(node)) references.add(node.text);
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      modules.add(node.moduleSpecifier.text);
      references.add(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const called = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : '';
      if (['readFile', 'readFileSync', 'readdir', 'readdirSync'].includes(called)) {
        runtimeRead = true;
        const paths = (part) => {
          if (ts.isStringLiteralLike(part) && /\.[a-z]+$/i.test(part.text))
            references.add(part.text);
          ts.forEachChild(part, paths);
        };
        if (node.arguments[0]) paths(node.arguments[0]);
      }
      const moduleCall =
        expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(expression) && expression.text === 'require');
      if (moduleCall && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        modules.add(node.arguments[0].text);
        references.add(node.arguments[0].text);
      }
      if (moduleCall && (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0])))
        dynamic = true;
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      references.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return { references: [...references], modules, dynamic, runtimeRead };
}

export function buildSourceGraph(files, workspaces, readSource) {
  const known = new Set(files);
  const reverse = new Map();
  const opaque = new Set();
  const unresolved = new Set();
  // The renderer resolves these project inputs at runtime rather than importing them.
  const reviewGoldens = 'services/gateway/src/review/templates-golden.test.ts';
  if (known.has(reviewGoldens))
    for (const name of ['review.md', 'review.static-code.md', 'review.full-live.md'])
      add(`projects/farmslot-farm/templates/worker/${name}`, reviewGoldens);
  for (const file of files.filter((name) => SOURCE_FILE.test(name))) {
    const { references, modules, dynamic, runtimeRead } = sourceReferences(readSource(file), file);
    if (dynamic || (runtimeRead && TEST_FILE.test(file))) opaque.add(file);
    for (const reference of references) {
      let dependency;
      if (reference.startsWith('.')) {
        const candidate = path.posix.normalize(
          path.posix.join(path.posix.dirname(file), reference),
        );
        dependency = modules.has(reference)
          ? resolveSource(candidate, known)
          : known.has(candidate)
            ? candidate
            : undefined;
      } else if (modules.has(reference) && reference.startsWith('@farmslot/')) {
        const workspace = workspaces.find(
          ({ name }) => reference === name || reference.startsWith(`${name}/`),
        );
        if (workspace) {
          const subpath = reference.slice(workspace.name.length + 1);
          dependency = resolveSource(`${workspace.dir}/src/${subpath || 'index'}`, known);
          // Package export aliases are not necessarily source file names.
          // Conservatively connect every source of that package in that case.
          if (!dependency) {
            for (const candidate of files.filter((name) => name.startsWith(`${workspace.dir}/`)))
              add(candidate, file);
          }
        }
      } else if (known.has(reference)) dependency = reference;
      if (!dependency && SOURCE_FILE.test(reference))
        dependency = resolveSource(path.posix.join(path.posix.dirname(file), reference), known);
      if (dependency) add(dependency, file);
      else if (modules.has(reference) && reference.startsWith('.')) unresolved.add(file);
    }
  }
  function add(dependency, consumer) {
    if (!reverse.has(dependency)) reverse.set(dependency, new Set());
    reverse.get(dependency).add(consumer);
  }
  return { reverse, opaque, unresolved };
}

export function selectAffectedTests({ files, changed, workspaces, graph }) {
  const runtimeChanges = runtimeImpactFiles(changed);
  const affected = affectedWorkspaceNames(workspaces, runtimeChanges);
  const all = changed === null;
  const widened = new Set();
  // Runtime assets and config are not described reliably by static imports.
  for (const file of runtimeChanges ?? []) {
    const owner = ownerOf(file, workspaces);
    if (owner && isFragmentPath(file, owner.dir)) continue;
    if (!SOURCE_FILE.test(file) || !files.includes(file)) {
      if (owner) for (const name of affectedWorkspaceNames(workspaces, [file])) widened.add(name);
      else if (!/\.(?:md|png|jpe?g|svg)$/.test(file))
        for (const name of affected) widened.add(name);
    }
  }
  for (const file of graph.opaque) {
    const owner = ownerOf(file, workspaces);
    if (
      owner &&
      affected.has(owner.name) &&
      !TEST_FILE.test(file) &&
      !file.includes('.live.') &&
      !file.includes('/scripts/')
    )
      widened.add(owner.name);
  }
  const reached = new Set(changed ?? files);
  const pending = [...reached];
  while (pending.length) {
    for (const consumer of graph.reverse.get(pending.pop()) ?? []) {
      if (!reached.has(consumer)) {
        reached.add(consumer);
        pending.push(consumer);
      }
    }
  }
  for (const file of graph.unresolved ?? []) {
    if (reached.has(file) && !TEST_FILE.test(file)) {
      const owner = ownerOf(file, workspaces);
      if (owner) widened.add(owner.name);
    }
  }
  return files.filter(
    (file) =>
      TEST_FILE.test(file) &&
      (all ||
        reached.has(file) ||
        widened.has(ownerOf(file, workspaces)?.name) ||
        (graph.opaque.has(file) && affected.has(ownerOf(file, workspaces)?.name))),
  );
}

export function readGraph(root, files, workspaces) {
  return buildSourceGraph(files, workspaces, (file) => readFileSync(path.join(root, file), 'utf8'));
}

import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { affectedWorkspaceNames } from './workspace-test-targets.mjs';

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
  function visit(node) {
    if (ts.isStringLiteralLike(node)) references.add(node.text);
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      modules.add(node.moduleSpecifier.text);
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const moduleCall =
        expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(expression) && expression.text === 'require');
      if (moduleCall && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]))
        modules.add(node.arguments[0].text);
      if (moduleCall && (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0])))
        dynamic = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return { references: [...references], modules, dynamic };
}

export function buildSourceGraph(files, workspaces, readSource) {
  const known = new Set(files);
  const reverse = new Map();
  const opaque = new Set();
  const unresolved = new Set();
  for (const file of files.filter((name) => SOURCE_FILE.test(name))) {
    const { references, modules, dynamic } = sourceReferences(readSource(file), file);
    if (dynamic) opaque.add(file);
    for (const reference of references) {
      let dependency;
      if (reference.startsWith('.'))
        dependency = resolveSource(
          path.posix.normalize(path.posix.join(path.posix.dirname(file), reference)),
          known,
        );
      else if (reference.startsWith('@farmslot/')) {
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
  const affected = affectedWorkspaceNames(workspaces, changed);
  const all = changed === null;
  const widened = new Set();
  // Runtime assets and config are not described reliably by static imports.
  for (const file of changed ?? []) {
    if (!SOURCE_FILE.test(file) || !files.includes(file)) {
      const owner = ownerOf(file, workspaces);
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
    if (reached.has(file)) {
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

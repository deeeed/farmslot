import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { isFragmentPath } from '../release/changelog-fragments.mjs';

import { classifyTest } from './run-tsx-tests.mjs';
import { sourceFileInputs } from './source-file-inputs.mjs';
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

function exportedSources(workspace, subpath, files) {
  if (workspace.exports === undefined) {
    const source =
      resolveSource(`${workspace.dir}/src/${subpath || 'index'}`, files) ??
      resolveSource(`${workspace.dir}/${subpath || 'index'}`, files);
    return source ? [source] : [];
  }
  const key = subpath ? `./${subpath}` : '.';
  let entry = workspace.exports;
  let wildcard;
  if (
    entry &&
    typeof entry === 'object' &&
    Object.keys(entry).some((name) => name.startsWith('.'))
  ) {
    let match = key;
    if (!(key in entry))
      match = Object.keys(entry)
        .filter((name) => {
          const [before, after] = name.split('*');
          return name.includes('*') && key.startsWith(before) && key.endsWith(after);
        })
        .sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length)[0];
    if (!match) return [];
    if (match.includes('*')) {
      const [before, after] = match.split('*');
      wildcard = key.slice(before.length, key.length - after.length);
    }
    entry = entry[match];
  } else if (subpath) return [];
  const result = new Set();
  function visit(target) {
    if (typeof target === 'string' && target.startsWith('./')) {
      target = target.replaceAll('*', wildcard ?? '');
      const source =
        resolveSource(`${workspace.dir}/${target.slice(2)}`, files) ??
        (target.startsWith('./dist/') &&
          resolveSource(
            `${workspace.dir}/src/${target.slice(7).replace(/\.d\.[cm]?ts$/, '')}`,
            files,
          ));
      if (source) result.add(source);
    } else if (target && typeof target === 'object') Object.values(target).forEach(visit);
  }
  visit(entry);
  return [...result];
}

// Parse source syntax, not import-shaped comments. Literal runtime references are
// included too: fixtures read through new URL or fs are dependencies of tests.
export function sourceReferences(source, file) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const references = new Set();
  const modules = new Set();
  let dynamic = false;
  let runtimeRead = false;
  const reads = [];
  const readNames = new Map(
    ['readFile', 'readFileSync', 'readdir', 'readdirSync'].map((name) => [name, name]),
  );
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const names = statement.importClause?.namedBindings;
    if (names && ts.isNamedImports(names))
      for (const name of names.elements)
        if (readNames.has((name.propertyName ?? name.name).text))
          readNames.set(name.name.text, readNames.get((name.propertyName ?? name.name).text));
  }
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
      if (readNames.has(called)) {
        runtimeRead = true;
        reads.push({
          expression,
          argument: node.arguments[0],
          directory: readNames.get(called).startsWith('readdir'),
        });
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
  return {
    references: [...references],
    modules,
    dynamic,
    runtimeRead,
    inputs: reads.length ? sourceFileInputs(parsed, file, reads) : [],
  };
}

export function buildSourceGraph(files, workspaces, readSource) {
  const known = new Set(files);
  const reverse = new Map();
  const opaque = new Set();
  const unresolved = new Set();
  const unknownAssetReaders = new Set();
  const directories = new Map();
  const lanes = new Map();
  // The renderer resolves these project inputs at runtime rather than importing them.
  const reviewGoldens = 'services/gateway/src/review/templates-golden.test.ts';
  if (known.has(reviewGoldens))
    for (const name of ['review.md', 'review.static-code.md', 'review.full-live.md'])
      add(`projects/farmslot-farm/templates/worker/${name}`, reviewGoldens);
  for (const file of files.filter((name) => SOURCE_FILE.test(name))) {
    const source = readSource(file);
    const { references, modules, dynamic, inputs } = sourceReferences(source, file);
    if (TEST_FILE.test(file)) lanes.set(file, classifyTest(source));
    if (dynamic) opaque.add(file);
    for (const input of inputs) {
      if (input.kind === 'temporary') continue;
      if (input.kind === 'repository' && input.directory) {
        const directory = input.path.replace(/\/+$/, '') || '.';
        if (!directories.has(directory)) directories.set(directory, new Set());
        directories.get(directory).add(file);
      } else if (input.kind === 'repository' && known.has(input.path)) add(input.path, file);
      else if (TEST_FILE.test(file)) opaque.add(file);
      else unknownAssetReaders.add(file);
    }
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
          const exported = exportedSources(workspace, subpath, known);
          dependency = exported[0];
          for (const candidate of exported.slice(1)) add(candidate, file);
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
  // Index directory consumers in one pass, including files added on this head.
  for (const file of files) {
    for (const directory of parentDirectories(file))
      for (const consumer of directories.get(directory) ?? []) add(file, consumer);
  }
  return { reverse, opaque, unresolved, directories, lanes, unknownAssetReaders };
}

function* parentDirectories(file) {
  let directory = path.posix.dirname(file);
  while (true) {
    yield directory;
    if (directory === '.') return;
    const parent = path.posix.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

function isRuntimeConfiguration(file) {
  return /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|[^/]+\.(?:config|setup)\.[cm]?[jt]s|\.yarnrc\.yml)$/.test(
    file,
  );
}

export function selectAffectedTests({ files, changed, workspaces, graph }) {
  const runtimeChanges = runtimeImpactFiles(changed);
  const affected = affectedWorkspaceNames(workspaces, runtimeChanges);
  // Test edits do not change opaque production inputs; opaque tests still use the fallback below.
  const productionAffected = affectedWorkspaceNames(
    workspaces,
    runtimeChanges?.filter((file) => !TEST_FILE.test(file)) ?? null,
  );
  const all = changed === null;
  const widened = new Set();
  const opaqueAssetOwners = new Set(
    [...(graph.unknownAssetReaders ?? [])].map((file) => ownerOf(file, workspaces)?.name),
  );
  // Runtime assets and config are not described reliably by static imports.
  for (const file of runtimeChanges ?? []) {
    const owner = ownerOf(file, workspaces);
    if (owner && isFragmentPath(file, owner.dir)) continue;
    const explicitInput =
      graph.reverse.has(file) ||
      [...parentDirectories(file)].some((directory) => graph.directories?.has(directory));
    if (
      isRuntimeConfiguration(file) ||
      !files.includes(file) ||
      (!SOURCE_FILE.test(file) && owner && opaqueAssetOwners.has(owner.name)) ||
      (!SOURCE_FILE.test(file) && !explicitInput)
    ) {
      if (owner) for (const name of affectedWorkspaceNames(workspaces, [file])) widened.add(name);
      else if (!/\.(?:md|png|jpe?g|svg)$/.test(file))
        for (const name of affected) widened.add(name);
    }
  }
  for (const file of graph.opaque) {
    const owner = ownerOf(file, workspaces);
    if (
      owner &&
      productionAffected.has(owner.name) &&
      !TEST_FILE.test(file) &&
      !file.includes('.live.') &&
      !file.includes('/scripts/')
    )
      widened.add(owner.name);
  }
  const reached = new Set(changed ?? files);
  // A deleted input is absent from the known-file index, but its directory
  // consumer must still run even when that input lived outside a workspace.
  for (const file of changed ?? [])
    for (const directory of parentDirectories(file))
      for (const consumer of graph.directories?.get(directory) ?? []) reached.add(consumer);
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

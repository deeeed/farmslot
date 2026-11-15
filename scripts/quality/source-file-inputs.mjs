import path from 'node:path';

import ts from 'typescript';

const FS = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const PATH = new Set(['path', 'node:path']);
const OS = new Set(['os', 'node:os']);
const URL = new Set(['url', 'node:url']);

function scope(node) {
  for (let current = node; current; current = current.parent)
    if (
      ts.isSourceFile(current) ||
      ts.isBlock(current) ||
      ts.isFunctionLike(current) ||
      ts.isForStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isCatchClause(current)
    )
      return current;
}

function moduleLiteral(node) {
  return ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments[0] &&
    ts.isStringLiteralLike(node.arguments[0])
    ? node.arguments[0].text
    : undefined;
}

function* bindingNames(name) {
  if (ts.isIdentifier(name)) yield name.text;
  else
    for (const entry of name.elements)
      if (ts.isBindingElement(entry)) yield* bindingNames(entry.name);
}

/** Resolve only immutable, lexical paths. Unproved reads keep the existing fallback. */
export function sourceFileInputs(source, file, reads) {
  const bindings = new Map();
  let temporaryIsOpaque = false;
  function bind(name, node, value, owner = scope(node.parent)) {
    if (!bindings.has(owner)) bindings.set(owner, new Map());
    bindings.get(owner).set(name, value);
  }
  function collect(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.name) bind(clause.name.text, node, { module });
      const names = clause?.namedBindings;
      if (names && ts.isNamespaceImport(names)) bind(names.name.text, node, { module });
      if (names && ts.isNamedImports(names))
        for (const name of names.elements)
          bind(name.name.text, node, { module, name: (name.propertyName ?? name.name).text });
    }
    if (ts.isParameter(node))
      for (const name of bindingNames(node.name)) bind(name, node, {}, node.parent);
    if (ts.isFunctionDeclaration(node) && node.name) bind(node.name.text, node, {});
    if (ts.isVariableDeclaration(node)) {
      const immutable = Boolean(node.parent.flags & ts.NodeFlags.Const);
      if (ts.isIdentifier(node.name))
        bind(node.name.text, node, immutable ? { initializer: node.initializer } : {});
      else if (ts.isObjectBindingPattern(node.name)) {
        const module = node.initializer && moduleLiteral(node.initializer);
        for (const entry of node.name.elements)
          if (ts.isIdentifier(entry.name))
            bind(
              entry.name.text,
              node,
              immutable && module
                ? { module, name: (entry.propertyName ?? entry.name).getText(source) }
                : {},
            );
          else for (const name of bindingNames(entry.name)) bind(name, node, {});
      } else for (const name of bindingNames(node.name)) bind(name, node, {});
    }
    if (ts.isCallExpression(node)) {
      const called = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : '';
      // A private path can lead back to repository inputs through a link, a mocked
      // path provider, or an external script. Keep those files conservative.
      if (
        /^(?:symlink|symlinkSync|link|linkSync|exec|execSync|execFile|execFileSync|spawn|spawnSync)$/.test(
          called,
        ) ||
        (['method', 'stub', 'defineProperty', 'module'].includes(called) &&
          node.arguments.some(
            (arg) =>
              ts.isStringLiteralLike(arg) &&
              /^(?:tmpdir|join|resolve|node:(?:os|path)|os|path)$/.test(arg.text),
          ))
      )
        temporaryIsOpaque = true;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      /\.(?:TMPDIR|TMP|TEMP|tmpdir|join|resolve)$/.test(node.left.getText(source))
    )
      temporaryIsOpaque = true;
    ts.forEachChild(node, collect);
  }
  collect(source);

  function binding(name, node) {
    for (let current = node; current; current = current.parent) {
      const values = bindings.get(current);
      if (values?.has(name)) return values.get(name);
    }
  }
  function callable(node, seen = new Set()) {
    if (ts.isIdentifier(node)) {
      const value = binding(node.text, node);
      if (value?.module) return value;
      if (value?.initializer && !seen.has(value))
        return callable(value.initializer, new Set([...seen, value]));
    }
    if (ts.isPropertyAccessExpression(node)) {
      const owner = callable(node.expression, seen);
      if (owner?.module && !owner.name) return { module: owner.module, name: node.name.text };
    }
    const module = moduleLiteral(node);
    if (module) return { module };
  }
  function value(node, seen = new Set()) {
    if (!node) return;
    if (
      ts.isAwaitExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return value(node.expression, seen);
    if (ts.isStringLiteralLike(node)) return { kind: 'literal', path: node.text };
    if (ts.isIdentifier(node)) {
      const entry = binding(node.text, node);
      if (!entry && node.text === '__dirname')
        return { kind: 'repository', path: path.posix.dirname(file) };
      if (!entry && node.text === '__filename') return { kind: 'repository', path: file };
      if (entry?.initializer && !seen.has(entry))
        return value(entry.initializer, new Set([...seen, entry]));
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (node.expression.getText(source) === 'import.meta') {
        if (node.name.text === 'dirname')
          return { kind: 'repository', path: path.posix.dirname(file) };
        if (node.name.text === 'url') return { kind: 'repository', path: file };
      }
      if (node.name.text === 'pathname') return value(node.expression, seen);
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      !binding('URL', node)
    ) {
      const relative = value(node.arguments?.[0], seen);
      const base = value(node.arguments?.[1], seen);
      if (
        relative?.kind === 'literal' &&
        relative.path.startsWith('.') &&
        base?.kind === 'repository'
      )
        return {
          kind: 'repository',
          path: path.posix.normalize(path.posix.join(path.posix.dirname(base.path), relative.path)),
        };
    }
    if (!ts.isCallExpression(node)) return;
    const fn = callable(node.expression);
    if (!fn) return;
    if (OS.has(fn.module) && fn.name === 'tmpdir')
      return temporaryIsOpaque ? undefined : { kind: 'temporary', path: '.' };
    const first = value(node.arguments[0], seen);
    if (FS.has(fn.module) && /^(?:mkdtemp|mkdtempSync|realpath|realpathSync)$/.test(fn.name ?? ''))
      return first?.kind === 'temporary' ? first : undefined;
    if (URL.has(fn.module) && fn.name === 'fileURLToPath') return first;
    if (!PATH.has(fn.module) || !first) return;
    if (fn.name === 'dirname' && first.kind !== 'literal')
      return { ...first, path: path.posix.dirname(first.path) };
    if (!['join', 'resolve'].includes(fn.name) || first.kind === 'literal') return;
    const parts = node.arguments.slice(1).map((arg) => value(arg, seen));
    if (parts.some((part) => part?.kind !== 'literal' || path.posix.isAbsolute(part.path))) return;
    const result = path.posix.normalize(
      path.posix.join(first.path, ...parts.map((part) => part.path)),
    );
    if (result === '..' || result.startsWith('../')) return;
    return { kind: first.kind, path: result };
  }
  return reads.map(({ expression, argument, directory }) => {
    const reader = callable(expression);
    if (!reader || !FS.has(reader.module)) return { kind: 'unknown', directory };
    const input = value(argument);
    if (
      input?.kind === 'repository' &&
      (input.path === '..' || input.path.startsWith('../') || path.posix.isAbsolute(input.path))
    )
      return { kind: 'unknown', directory };
    return input?.kind === 'repository' || input?.kind === 'temporary'
      ? { ...input, directory }
      : { kind: 'unknown', directory };
  });
}

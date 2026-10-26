#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const roots = ['apps/command-center/ui/src', 'apps/companion/src'];
const unknown = Symbol('unresolved');
const requestNames = new Set([
  'request',
  'requestResource',
  'rawRequest',
  'requestRaw',
  'requestObserved',
  'rpc',
]);

// These files own transport/cache implementation or execute explicit developer proofs.
// A dev/ or farmslot/ directory exemption would also hide ordinary application reads.
export const IMPLEMENTATION_FILES = new Set([
  'apps/command-center/ui/src/gateway-client.ts',
  'apps/command-center/ui/src/resource-cache.ts',
  'apps/companion/src/lib/gateway-client.ts',
  'apps/companion/src/lib/resource-cache.ts',
  'apps/command-center/ui/src/dev/offline-client-cache-proof.ts',
  'apps/command-center/ui/src/dev/local-store-proof.ts',
  'apps/command-center/ui/src/dev/resource-authority-proof.ts',
  'apps/companion/src/farmslot/backlog-ready-touch-proof.ts',
  'apps/companion/src/farmslot/offline-client-cache-proof.ts',
  'apps/companion/src/farmslot/offline-client-cache-auth-proof.ts',
  'apps/companion/src/farmslot/local-store-proof.ts',
  'apps/companion/src/farmslot/run-collections-proof.ts',
  'apps/companion/src/farmslot/sources-cache-proof.ts',
]);

// Exceptions name the actual parameter contract, never an entire client/file.
// An unknown boolean, false, or a spread overriding true cannot prove a command.
const imperativeContracts = [
  ['PR_LIST', 'packages/protocol/src/rpc/pr.ts', 'PRListParams', 'force'],
  ['PR_STATUS', 'packages/protocol/src/rpc/pr.ts', 'PRStatusParams', 'force'],
  ['GATEWAY_STATUS', 'packages/protocol/src/rpc/gateway.ts', 'GatewayStatusParams', 'refresh'],
  [
    'CONFIG_GITHUB_ACCOUNTS',
    'packages/protocol/src/rpc/config.ts',
    'ConfigGitHubAccountsParams',
    'refresh',
  ],
  [
    'PROVIDER_ACCOUNTS_SNAPSHOT',
    'packages/protocol/src/rpc/provider-accounts.ts',
    'ProviderAccountsSnapshotParams',
    'forceRefresh',
  ],
];

const unwrap = (node) => {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node))
  )
    node = node.expression;
  return node;
};
const functionNode = (node) =>
  node &&
  (ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node));
const each = (node, visit) => {
  visit(node);
  ts.forEachChild(node, (child) => each(child, visit));
};
const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const testFile = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;

function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : collect(file);
    return entry.isFile() && sourceExtension.test(file) && !file.endsWith('.d.ts') ? [file] : [];
  });
}

function parse(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  if (source.parseDiagnostics.length) throw new Error(`Cannot parse ${file}`);
  return source;
}

function objectVariable(file, name) {
  let value;
  each(file, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
      value = unwrap(node.initializer);
  });
  if (!value || !ts.isObjectLiteralExpression(value))
    throw new Error(`${name} must remain a closed object in ${file.fileName}`);
  return value;
}

export function readCachedMethods(repoRoot = defaultRoot) {
  const methods = new Map();
  const methodSource = parse(path.join(repoRoot, 'packages/protocol/src/rpc/registry.ts'));
  for (const property of objectVariable(methodSource, 'Methods').properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer))
      throw new Error('Methods must use literal protocol names');
    methods.set(property.name.getText(methodSource), property.initializer.text);
  }
  const registry = parse(path.join(repoRoot, 'packages/protocol/src/client-cache/registry.ts'));
  const cached = new Set();
  for (const property of objectVariable(registry, 'RESOURCE_QUERY_DEFINITIONS').properties) {
    if (!ts.isPropertyAssignment(property))
      throw new Error('Cached query registration must remain closed');
    const key = property.name;
    if (
      !ts.isComputedPropertyName(key) ||
      !ts.isPropertyAccessExpression(key.expression) ||
      key.expression.expression.getText(registry) !== 'Methods' ||
      !methods.has(key.expression.name.text)
    )
      throw new Error(`Unresolved cached method: ${key.getText(registry)}`);
    cached.add(methods.get(key.expression.name.text));
  }
  if (!cached.size) throw new Error('Cached query registry is empty');
  const imperative = new Map();
  for (const [constant, relative, name, flag] of imperativeContracts) {
    const file = parse(path.join(repoRoot, relative));
    let contract;
    each(file, (node) => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === name) contract = node;
    });
    const field = contract?.members.find(
      (node) => ts.isPropertySignature(node) && node.name.getText(file) === flag,
    );
    if (!field || field.type?.kind !== ts.SyntaxKind.BooleanKeyword)
      throw new Error(`Imperative contract changed: ${relative} ${name}.${flag}`);
    imperative.set(methods.get(constant), flag);
  }
  return { cached, methods, imperative };
}

export function analyzeCachedPanelReads({ repoRoot = defaultRoot, files } = {}) {
  repoRoot = path.resolve(repoRoot);
  const relative = (file) => path.relative(repoRoot, file).split(path.sep).join('/');
  const ignored = (file) =>
    IMPLEMENTATION_FILES.has(relative(file)) ||
    testFile.test(relative(file)) ||
    relative(file).startsWith('packages/protocol/src/client-cache/') ||
    relative(file) === 'packages/local-store/src/owner.ts';
  const inputs = (files ?? roots.flatMap((directory) => collect(path.join(repoRoot, directory))))
    .map((file) => path.resolve(repoRoot, file))
    .filter((file) => !ignored(file))
    .sort();
  const { cached, methods, imperative } = readCachedMethods(repoRoot);
  const program = ts.createProgram({
    rootNames: inputs,
    options: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      skipLibCheck: true,
      noEmit: true,
      experimentalDecorators: true,
      baseUrl: repoRoot,
      paths: {
        '@farmslot/protocol': ['packages/protocol/src/index.ts'],
        '@farmslot/protocol/*': ['packages/protocol/src/*'],
        '@farmslot/local-store': ['packages/local-store/src/index.ts'],
        '@farmslot/local-store/*': ['packages/local-store/src/*'],
        '@/*': ['apps/companion/src/*'],
      },
    },
  });
  const checker = program.getTypeChecker();
  const findings = new Map();
  const unresolved = new Map();
  const modified = new Set();
  const symbol = (node) => {
    let result = node && checker.getSymbolAtLocation(node);
    if (result?.flags & ts.SymbolFlags.Alias) result = checker.getAliasedSymbol(result);
    return result;
  };
  const position = (node) => {
    const file = node.getSourceFile();
    const point = file.getLineAndCharacterOfPosition(node.getStart(file));
    return { file: relative(file.fileName), line: point.line + 1, column: point.character + 1 };
  };
  const rootSymbol = (node) => {
    node = unwrap(node);
    while (node && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)))
      node = unwrap(node.expression);
    return ts.isIdentifier(node) ? symbol(node) : undefined;
  };
  for (const file of inputs) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`TypeScript did not include ${file}`);
    if (source.parseDiagnostics.length) throw new Error(`Cannot parse ${file}`);
    each(source, (node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        modified.add(rootSymbol(node.left));
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
      )
        modified.add(rootSymbol(node.operand));
    });
  }
  function typed(node) {
    const values = (type) => {
      if (type.isUnion()) return type.types.flatMap(values);
      if (type.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral))
        return [type.value];
      if (type.flags & ts.TypeFlags.BooleanLiteral) return [type.intrinsicName === 'true'];
      if (type.flags & ts.TypeFlags.Undefined) return [undefined];
      if (type.flags & ts.TypeFlags.Null) return [null];
      return [unknown];
    };
    return values(checker.getTypeAtLocation(node));
  }
  function member(values, keys) {
    return values.flatMap((value) =>
      keys.flatMap((key) => {
        if (!value?.fields || key === unknown) return [unknown];
        return value.fields.get(String(key)) ?? (value.open ? [unknown] : [undefined]);
      }),
    );
  }
  function evaluate(node, bindings, seen = new Set()) {
    node = unwrap(node);
    if (!node) return [undefined];
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
      return [ts.isNumericLiteral(node) ? Number(node.text) : node.text];
    if (node.kind === ts.SyntaxKind.TrueKeyword) return [true];
    if (node.kind === ts.SyntaxKind.FalseKeyword) return [false];
    if (node.kind === ts.SyntaxKind.NullKeyword) return [null];
    if (ts.isIdentifier(node) && node.text === 'undefined') return [undefined];
    if (ts.isConditionalExpression(node)) {
      const condition = evaluate(node.condition, bindings, seen);
      if (condition.length === 1 && condition[0] !== unknown)
        return evaluate(condition[0] ? node.whenTrue : node.whenFalse, bindings, seen);
      return [
        ...evaluate(node.whenTrue, bindings, seen),
        ...evaluate(node.whenFalse, bindings, seen),
      ];
    }
    if (ts.isIdentifier(node)) {
      const reference = symbol(node);
      if (bindings.has(reference)) return bindings.get(reference);
      if (!reference || seen.has(reference)) return [unknown];
      const next = new Set([...seen, reference]);
      if (!modified.has(reference))
        for (const declaration of reference.declarations ?? []) {
          if (
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer &&
            declaration.parent.flags & ts.NodeFlags.Const
          )
            return evaluate(declaration.initializer, bindings, next);
          if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
            const variable = declaration.parent.parent;
            if (
              ts.isVariableDeclaration(variable) &&
              variable.initializer &&
              variable.parent.flags & ts.NodeFlags.Const
            )
              return member(evaluate(variable.initializer, bindings, next), [
                (declaration.propertyName ?? declaration.name).getText(),
              ]);
          }
        }
      return typed(node);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const object = { fields: new Map(), open: false };
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = evaluate(property.expression, bindings, seen);
          if (spread.length === 1 && spread[0]?.fields && !spread[0].open)
            for (const [key, value] of spread[0].fields) object.fields.set(key, value);
          else {
            object.open = true;
            for (const key of object.fields.keys()) object.fields.set(key, [unknown]);
          }
        } else if (
          ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property)
        ) {
          const keys = ts.isComputedPropertyName(property.name)
            ? evaluate(property.name.expression, bindings, seen)
            : [property.name.text];
          const value = evaluate(
            ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer,
            bindings,
            seen,
          );
          if (keys.length === 1 && keys[0] !== unknown) object.fields.set(String(keys[0]), value);
          else object.open = true;
        }
      }
      return [object];
    }
    if (ts.isArrayLiteralExpression(node))
      return [
        {
          fields: new Map(
            node.elements.map((element, index) => [
              String(index),
              ts.isSpreadElement(element) ? [unknown] : evaluate(element, bindings, seen),
            ]),
          ),
          open: node.elements.some(ts.isSpreadElement),
        },
      ];
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const keys = ts.isPropertyAccessExpression(node)
        ? [node.name.text]
        : evaluate(node.argumentExpression, bindings, seen);
      const result = member(evaluate(node.expression, bindings, seen), keys);
      return result.every((value) => value === unknown) ? typed(node) : result;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluate(node.left, bindings, seen),
        right = evaluate(node.right, bindings, seen);
      return left.flatMap((a) =>
        right.map((b) =>
          a === unknown || b === unknown || typeof a === 'object' || typeof b === 'object'
            ? unknown
            : a + b,
        ),
      );
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.getText() === 'Object.freeze'
    )
      return evaluate(node.arguments[0], bindings, seen);
    return typed(node);
  }
  function callable(node, seen = new Set()) {
    node = unwrap(node);
    if (!node) return [];
    if (functionNode(node)) return [node];
    const reference = symbol(ts.isPropertyAccessExpression(node) ? node.name : node);
    if (!reference || seen.has(reference)) return [];
    const next = new Set([...seen, reference]);
    return (reference.declarations ?? []).flatMap((declaration) => {
      if (functionNode(declaration) && declaration.body) return [declaration];
      return declaration.initializer ? callable(declaration.initializer, next) : [];
    });
  }
  function sink(node, seen = new Set()) {
    node = unwrap(node);
    if (!node) return false;
    if (ts.isPropertyAccessExpression(node) && requestNames.has(node.name.text)) return true;
    if (ts.isPropertyAccessExpression(node) && ['call', 'apply'].includes(node.name.text))
      return sink(node.expression, seen);
    if (
      ts.isElementAccessExpression(node) &&
      evaluate(node.argumentExpression, new Map()).some((value) => requestNames.has(value))
    )
      return true;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'bind'
    )
      return sink(node.expression.expression, seen);
    const reference = symbol(node);
    if (!reference || seen.has(reference)) return false;
    const next = new Set([...seen, reference]);
    return (reference.declarations ?? []).some((declaration) => {
      if (
        ts.isBindingElement(declaration) &&
        requestNames.has((declaration.propertyName ?? declaration.name).getText())
      )
        return true;
      if (
        (ts.isParameter(declaration) ||
          (ts.isFunctionDeclaration(declaration) && !declaration.body)) &&
        declaration.name &&
        requestNames.has(declaration.name.getText())
      )
        return true;
      return declaration.initializer ? sink(declaration.initializer, next) : false;
    });
  }
  function requestArguments(expression, args, seen = new Set()) {
    expression = unwrap(expression);
    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === 'bind'
    )
      return requestArguments(
        expression.expression.expression,
        [...expression.arguments.slice(1), ...args],
        seen,
      );
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'call')
      return requestArguments(expression.expression, args.slice(1), seen);
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'apply') {
      const array = unwrap(args[1]);
      return array && ts.isArrayLiteralExpression(array) && !array.elements.some(ts.isSpreadElement)
        ? requestArguments(expression.expression, [...array.elements], seen)
        : null;
    }
    const reference = symbol(
      ts.isPropertyAccessExpression(expression) ? expression.name : expression,
    );
    if (reference && !seen.has(reference)) {
      const declaration = reference.declarations?.find((node) => node.initializer);
      if (declaration)
        return requestArguments(declaration.initializer, args, new Set([...seen, reference]));
    }
    return args;
  }
  function command(method, parameters) {
    const flag = imperative.get(method);
    if (
      flag &&
      parameters.length &&
      parameters.every(
        (value) =>
          value?.fields &&
          value.fields.get(flag)?.length === 1 &&
          value.fields.get(flag)[0] === true,
      )
    )
      return true;
    // Existing assessment.report creates an artifact when no id selector is present.
    return (
      method === methods.get('ASSESSMENT_REPORT') &&
      parameters.length > 0 &&
      parameters.every(
        (value) =>
          value === undefined ||
          (value?.fields &&
            !value.open &&
            (!value.fields.has('id') ||
              value.fields.get('id').every((entry) => entry === undefined))),
      )
    );
  }
  function bindParameter(name, values, bindings, callerBindings) {
    if (ts.isIdentifier(name)) {
      bindings.set(symbol(name), values);
      return;
    }
    for (const [index, element] of name.elements.entries()) {
      if (ts.isOmittedExpression(element)) continue;
      const key = ts.isArrayBindingPattern(name)
        ? String(index)
        : (element.propertyName ?? element.name).getText();
      let selected = element.dotDotDotToken ? [unknown] : member(values, [key]);
      if (element.initializer && selected.every((value) => value === undefined))
        selected = evaluate(element.initializer, callerBindings);
      bindParameter(element.name, selected, bindings, callerBindings);
    }
  }
  function inspect(call, bindings, origin, chain) {
    if (sink(call.expression)) {
      const args = requestArguments(call.expression, [...call.arguments]);
      const names = args ? evaluate(args[0], bindings) : [unknown];
      const parameters = args ? evaluate(args[1], bindings) : [unknown];
      const here = position(origin);
      if (names.includes(unknown))
        unresolved.set(`${here.file}:${here.line}:${here.column}`, {
          ...here,
          transport: position(call),
        });
      for (const method of new Set(names.filter((name) => cached.has(name)))) {
        if (command(method, parameters)) continue;
        findings.set(`${here.file}:${here.line}:${here.column}:${method}`, {
          ...here,
          method,
          transport: position(call),
          message: `Use the shared resource cache for ${method}`,
        });
      }
      return;
    }
    for (const fn of callable(call.expression)) {
      if (!fn.body || ignored(fn.getSourceFile().fileName) || chain.has(fn) || chain.size >= 12)
        continue;
      const next = new Map(bindings);
      fn.parameters.forEach((parameter, index) => {
        const argument = call.arguments[index] ?? parameter.initializer;
        bindParameter(parameter.name, evaluate(argument, bindings), next, bindings);
      });
      walk(fn.body, next, origin, new Set([...chain, fn]));
    }
  }
  function walk(node, bindings, origin, chain) {
    if (ts.isIfStatement(node)) {
      const condition = evaluate(node.expression, bindings);
      if (condition.length === 1 && condition[0] !== unknown) {
        const branch = condition[0] ? node.thenStatement : node.elseStatement;
        if (branch) walk(branch, bindings, origin, chain);
        return;
      }
    }
    if (ts.isCallExpression(node)) inspect(node, bindings, origin ?? node, chain);
    ts.forEachChild(node, (child) => walk(child, bindings, origin, chain));
  }
  for (const file of inputs) walk(program.getSourceFile(file), new Map(), undefined, new Set());
  return {
    scannedFiles: inputs.length,
    registeredMethods: [...cached].sort(),
    findings: [...findings.values()].sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.column - b.column ||
        a.method.localeCompare(b.method),
    ),
    unresolvedTransports: [...unresolved.values()],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const selected = args.filter((arg) => arg !== '--json' && arg !== '--files');
  if (selected.length && !args.includes('--files'))
    throw new Error('Use --files <paths...> for focused fixture checks');
  const result = analyzeCachedPanelReads({
    files: args.includes('--files') ? selected : undefined,
  });
  if (jsonOutput) console.log(JSON.stringify(result, null, 2));
  else {
    for (const finding of result.findings)
      console.error(`${finding.file}:${finding.line}:${finding.column}: ${finding.message}`);
    console.log(
      `Cached panel reads: ${result.findings.length} violation(s), ${result.scannedFiles} files, ${result.registeredMethods.length} registered methods; ${result.unresolvedTransports.length} unresolved transport call(s).`,
    );
  }
  if (result.findings.length) process.exitCode = 1;
}

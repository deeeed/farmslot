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
  const workspaceMethods = new Set();
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
    const definition = unwrap(property.initializer);
    if (
      (ts.isIdentifier(definition) && definition.text === 'workspaceDefinition') ||
      (ts.isObjectLiteralExpression(definition) &&
        definition.properties.some(
          (entry) =>
            ts.isSpreadAssignment(entry) &&
            entry.expression.getText(registry) === 'workspaceDefinition',
        ))
    )
      workspaceMethods.add(methods.get(key.expression.name.text));
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
  return { cached, methods, imperative, workspaceMethods };
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
  const { cached, methods, imperative, workspaceMethods } = readCachedMethods(repoRoot);
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
  const classified = new Map();
  const imperativeCalls = new Map();
  const modified = new Set();
  const modifiedProperties = new Set();
  const symbol = (node) => {
    const shorthand =
      node?.parent && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? node.parent
        : undefined;
    // A shorthand property's own symbol differs from the local value that flow facts bind.
    let result = shorthand
      ? checker.getShorthandAssignmentValueSymbol(shorthand)
      : node && checker.getSymbolAtLocation(node);
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
  for (const file of inputs)
    if (!program.getSourceFile(file)) throw new Error(`TypeScript did not include ${file}`);
  for (const source of program.getSourceFiles()) {
    if (
      source.isDeclarationFile ||
      relative(source.fileName).startsWith('../') ||
      source.fileName.includes('/node_modules/')
    )
      continue;
    if (source.parseDiagnostics.length) throw new Error(`Cannot parse ${source.fileName}`);
    each(source, (node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        modified.add(rootSymbol(node.left));
        const left = unwrap(node.left);
        if (ts.isPropertyAccessExpression(left)) modifiedProperties.add(symbol(left.name));
      }
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
  // Member reads must not expand unrelated, repeatedly shared object subtrees.
  class Fields extends Map {
    get(key) {
      const value = super.get(key);
      if (typeof value !== 'function') return value;
      const evaluated = value();
      super.set(key, evaluated);
      return evaluated;
    }
  }
  // The closed enum was already validated above; identify its symbol, including import aliases.
  const registrySource = program.getSourceFile(
    path.join(repoRoot, 'packages/protocol/src/rpc/registry.ts'),
  );
  const registryDeclaration = registrySource?.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'Methods',
    );
  const registryReference = registryDeclaration && symbol(registryDeclaration.name);
  const registryValue = {
    fields: new Map([...methods].map(([name, method]) => [name, [method]])),
    open: false,
    identity: registryReference,
  };
  function member(values, keys) {
    return values.flatMap((value) =>
      keys.flatMap((key) => {
        if (!value?.fields || key === unknown) return [unknown];
        return value.fields.get(String(key)) ?? (value.open ? [unknown] : [undefined]);
      }),
    );
  }
  function key(node) {
    node = unwrap(node);
    if (!node) return undefined;
    if (ts.isIdentifier(node)) return symbol(node);
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword)
      return symbol(node.name);
    return undefined;
  }
  function truth(value) {
    if (value === unknown) return undefined;
    if (value?.notReceiver) return undefined;
    if (value?.stringConstraint) return value.nonempty ? true : undefined;
    return Boolean(value);
  }
  function assume(node, positive, bindings) {
    node = unwrap(node);
    const result = new Map(bindings);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
      return assume(node.operand, !positive, result);
    const reference = key(node);
    if (reference) {
      const current = evaluate(node, bindings);
      if (!current.includes(unknown))
        result.set(
          reference,
          current.filter((value) => truth(value) === undefined || truth(value) === positive),
        );
      const type = checker.getTypeAtLocation(node);
      if (type.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral))
        result.set(reference, positive ? [{ stringConstraint: true, nonempty: true }] : ['']);
      else if (
        type.flags &
        (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Union)
      ) {
        const parts = type.isUnion() ? type.types : [type];
        if (
          parts.every((entry) => entry.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral))
        )
          result.set(reference, [positive]);
      }
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(operator)
      ) {
        const equal = positive === (operator === ts.SyntaxKind.EqualsEqualsEqualsToken);
        const left = evaluate(node.left, bindings),
          right = evaluate(node.right, bindings);
        const leftKey = key(node.left),
          rightKey = key(node.right);
        if (equal && right.length === 1 && right[0] !== unknown && leftKey)
          result.set(leftKey, right);
        else if (equal && left.length === 1 && left[0] !== unknown && rightKey)
          result.set(rightKey, left);
        else if (!equal) {
          if (right.length === 1 && right[0] === '' && leftKey)
            result.set(leftKey, [{ stringConstraint: true, nonempty: true }]);
          if (left.length === 1 && left[0] === '' && rightKey)
            result.set(rightKey, [{ stringConstraint: true, nonempty: true }]);
          if (right.length === 1 && right[0]?.identity && leftKey)
            result.set(leftKey, [{ notReceiver: right[0].identity }]);
          if (left.length === 1 && left[0]?.identity && rightKey)
            result.set(rightKey, [{ notReceiver: left[0].identity }]);
        }
      }
      if (
        (operator === ts.SyntaxKind.AmpersandAmpersandToken && positive) ||
        (operator === ts.SyntaxKind.BarBarToken && !positive)
      )
        return assume(node.right, positive, assume(node.left, positive, result));
    }
    if (
      positive &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'startsWith' &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === '/'
    ) {
      const reference = key(node.expression.expression);
      if (reference)
        result.set(reference, [{ stringConstraint: true, nonempty: true, absolute: true }]);
    }
    return result;
  }
  function returns(fn) {
    if (!ts.isBlock(fn.body)) return [fn.body];
    const result = [];
    const visit = (node) => {
      if (functionNode(node) && node !== fn) return;
      if (ts.isReturnStatement(node)) result.push(node.expression);
      else ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return result;
  }
  function invocation(fn, args, bindings) {
    const next = new Map(bindings);
    fn.parameters.forEach((parameter, index) =>
      bindParameter(
        parameter.name,
        evaluate(args[index] ?? parameter.initializer, bindings),
        next,
        bindings,
      ),
    );
    return next;
  }
  function evaluate(node, bindings, seen = new Set()) {
    const alternatives = evaluateValue(node, bindings, seen);
    return alternatives.length > 1 ? [...new Set(alternatives)] : alternatives;
  }
  function evaluateValue(node, bindings, seen) {
    node = unwrap(node);
    if (!node) return [undefined];
    if (seen.size > 24) return typed(node);
    const bound = key(node);
    if (bound && bindings.has(bound)) return bindings.get(bound);
    if (node.kind === ts.SyntaxKind.ThisKeyword) return bindings.get('this') ?? [unknown];
    if (functionNode(node)) return [{ function: node }];
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
      return [ts.isNumericLiteral(node) ? Number(node.text) : node.text];
    if (node.kind === ts.SyntaxKind.TrueKeyword) return [true];
    if (node.kind === ts.SyntaxKind.FalseKeyword) return [false];
    if (node.kind === ts.SyntaxKind.NullKeyword) return [null];
    if (ts.isIdentifier(node) && node.text === 'undefined') return [undefined];
    if (ts.isConditionalExpression(node)) {
      const condition = evaluate(node.condition, bindings, seen);
      if (condition.length === 1 && truth(condition[0]) !== undefined)
        return evaluate(truth(condition[0]) ? node.whenTrue : node.whenFalse, bindings, seen);
      return [
        ...evaluate(node.whenTrue, assume(node.condition, true, bindings), seen),
        ...evaluate(node.whenFalse, assume(node.condition, false, bindings), seen),
      ];
    }
    if (ts.isIdentifier(node)) {
      const reference = symbol(node);
      if (bindings.has(reference)) return bindings.get(reference);
      if (registryReference && reference === registryReference && !modified.has(registryReference))
        return [registryValue];
      if (!reference || seen.has(reference)) return [unknown];
      const next = new Set([...seen, reference]);
      const functions = callable(node);
      if (functions.length) return functions.map((fn) => ({ function: fn }));
      if (!modified.has(reference))
        for (const declaration of reference.declarations ?? []) {
          if (
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer &&
            declaration.parent.flags & ts.NodeFlags.Const
          )
            return evaluate(declaration.initializer, bindings, next).map((value) =>
              value && typeof value === 'object' && !value.stringConstraint && !value.identity
                ? { ...value, identity: reference }
                : value,
            );
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
      const object = { fields: new Fields(), open: false };
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = evaluate(property.expression, bindings, seen);
          if (spread.length === 1 && spread[0]?.fields && !spread[0].open)
            for (const [key, value] of spread[0].fields) object.fields.set(key, value);
          else {
            object.open = true;
            for (const key of object.fields.keys()) object.fields.set(key, [unknown]);
          }
        } else if (ts.isMethodDeclaration(property)) {
          object.fields.set(property.name.text, [{ function: property }]);
        } else if (
          ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property)
        ) {
          const keys = ts.isComputedPropertyName(property.name)
            ? evaluate(property.name.expression, bindings, seen)
            : [property.name.text];
          const value = () =>
            evaluate(
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
          fields: new Fields(
            node.elements.map((element, index) => [
              String(index),
              ts.isSpreadElement(element) ? [unknown] : () => evaluate(element, bindings, seen),
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
      if (
        result.every((value) => value === unknown) &&
        node.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isPropertyAccessExpression(node)
      ) {
        const declaration = symbol(node.name)?.valueDeclaration;
        const modifiers =
          declaration && ts.canHaveModifiers(declaration)
            ? (ts.getModifiers(declaration) ?? [])
            : [];
        if (
          declaration?.initializer &&
          !modifiedProperties.has(symbol(node.name)) &&
          modifiers.some((modifier) =>
            [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ReadonlyKeyword].includes(modifier.kind),
          ) &&
          !seen.has(declaration)
        )
          return evaluate(declaration.initializer, bindings, new Set([...seen, declaration]));
      }
      return result.every((value) => value === unknown) ? typed(node) : result;
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
      return evaluate(node.operand, bindings, seen).map((value) =>
        truth(value) === undefined ? unknown : !truth(value),
      );
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
        node.operatorToken.kind,
      )
    ) {
      const rightValues = evaluate(node.right, bindings, seen);
      return evaluate(node.left, bindings, seen).flatMap((left) =>
        rightValues.map((right) =>
          left === unknown ||
          right === unknown ||
          left?.stringConstraint ||
          right?.stringConstraint ||
          left?.notReceiver ||
          right?.notReceiver
            ? unknown
            : (typeof left === 'object' && left !== null) ||
                (typeof right === 'object' && right !== null)
              ? left?.identity && right?.identity && left.identity === right.identity
                ? node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
                : unknown
              : node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
                ? left === right
                : left !== right,
        ),
      );
    }
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
      ].includes(node.operatorToken.kind)
    ) {
      let rightValues;
      return evaluate(node.left, bindings, seen).flatMap((left) => {
        const fallback = () => (rightValues ??= evaluate(node.right, bindings, seen));
        if (left === unknown) return [unknown, ...fallback()];
        if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
          return left == null ? fallback() : [left];
        if (truth(left) === undefined) return [left, ...fallback()];
        return truth(left) === (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
          ? fallback()
          : [left];
      });
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
    if (ts.isNewExpression(node)) {
      const declaration = symbol(node.expression)?.valueDeclaration;
      if (declaration && ts.isClassDeclaration(declaration)) {
        const constructor = declaration.members.find(ts.isConstructorDeclaration);
        const fields = new Map();
        constructor?.parameters.forEach((parameter, index) => {
          if (ts.isIdentifier(parameter.name) && ts.getModifiers(parameter)?.length)
            fields.set(
              parameter.name.text,
              evaluate(node.arguments?.[index] ?? parameter.initializer, bindings, seen),
            );
        });
        return [{ instance: declaration, fields, open: true }];
      }
    }
    if (ts.isCallExpression(node)) {
      const reference = checker.getSymbolAtLocation(node.expression);
      if (
        reference?.declarations?.some(
          (entry) =>
            ts.isImportSpecifier(entry) &&
            (entry.propertyName ?? entry.name).text === 'useMemo' &&
            entry.parent.parent.parent.moduleSpecifier?.text === 'react',
        )
      ) {
        const factory = unwrap(node.arguments[0]);
        if (functionNode(factory))
          return returns(factory).flatMap((expression) => evaluate(expression, bindings, seen));
      }
      const functions = callable(node.expression).filter((fn) => fn.body && !seen.has(fn));
      if (functions.length)
        return functions.flatMap((fn) => {
          const next = invocation(fn, node.arguments, bindings);
          return returns(fn).flatMap((expression) =>
            evaluate(expression, next, new Set([...seen, fn])),
          );
        });
    }
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
  function excludedVariant(method, parameters) {
    if (!parameters.length) return undefined;
    const field = (value, name) => value?.fields?.get(name);
    const nonempty = (values) =>
      values?.length &&
      values.every(
        (value) =>
          (typeof value === 'string' && value.length > 0) ||
          (value?.stringConstraint && value.nonempty),
      );
    if (
      method === methods.get('ROADMAP_LIST') &&
      parameters.every((value) => nonempty(field(value, 'search')))
    )
      return 'Nonempty roadmap search is excluded by roadmapListObservationParams';
    if (workspaceMethods.has(method)) {
      if (
        method === methods.get('FS_READ') &&
        parameters.every(
          (value) =>
            value?.fields?.has('slotId') &&
            field(value, 'path')?.every((entry) =>
              typeof entry === 'string'
                ? entry.startsWith('/')
                : entry?.stringConstraint && entry.absolute,
            ),
        )
      )
        return 'Absolute artifact path is outside registered workspace observations';
      const frozenFields =
        method === methods.get('GIT_SHOW')
          ? ['ref', 'path']
          : [methods.get('GIT_DIFF'), methods.get('GIT_BRANCH_DIFF')].includes(method)
            ? ['base', 'head']
            : undefined;
      if (
        frozenFields &&
        parameters.every(
          (value) =>
            value?.fields &&
            !value.open &&
            field(value, 'slotId')?.length === 1 &&
            field(value, 'slotId')[0] === '' &&
            nonempty(field(value, 'runId')) &&
            !value.fields.has('sessionId') &&
            frozenFields.every((name) => nonempty(field(value, name))),
        )
      )
        return 'Frozen run-only legacy source is outside registered workspace selectors';
    }
    return undefined;
  }
  function workerOperation(call) {
    const signature = checker.getResolvedSignature(call);
    const parameter = signature?.parameters[0];
    if (!parameter) return false;
    const type = checker.getTypeOfSymbolAtLocation(parameter, call);
    const parts = type.isUnion() ? type.types : [type];
    return (
      parts.length > 0 &&
      parts.every((part) => {
        const operation = part.getProperty('operation');
        if (!operation || part.getProperty('method') || part.flags & ts.TypeFlags.StringLike)
          return false;
        const discriminator = checker.getTypeOfSymbolAtLocation(operation, call);
        const alternatives = discriminator.isUnion() ? discriminator.types : [discriminator];
        return alternatives.every((entry) => entry.flags & ts.TypeFlags.StringLiteral);
      })
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
  // Follow helpers that can reach transport calls; pure rendering/model helpers cannot add findings.
  const functions = new Set();
  for (const source of program.getSourceFiles()) {
    if (
      source.isDeclarationFile ||
      relative(source.fileName).startsWith('../') ||
      source.fileName.includes('/node_modules/') ||
      ignored(source.fileName)
    )
      continue;
    each(source, (node) => {
      if (functionNode(node) && node.body) functions.add(node);
    });
  }
  // TypeScript bounds every caller's value, so a closed union of uncached method types is a
  // command whatever the bindings; open, generic or cached-including types stay possible reads.
  function typedCommand(call) {
    const args = requestArguments(call.expression, [...call.arguments]);
    return Boolean(
      args?.length && typed(args[0]).every((name) => typeof name === 'string' && !cached.has(name)),
    );
  }
  const transportFunctions = new Set();
  // Helpers that can reach a transport call whose method is not a typed command.
  const readCapable = new Set();
  const dependents = new Map();
  for (const fn of functions)
    each(fn.body, (node) => {
      if (!ts.isCallExpression(node)) return;
      if (sink(node.expression)) {
        transportFunctions.add(fn);
        if (!typedCommand(node)) readCapable.add(fn);
      }
      for (const target of callable(node.expression)) {
        if (!functions.has(target)) continue;
        if (!dependents.has(target)) dependents.set(target, new Set());
        dependents.get(target).add(fn);
      }
    });
  for (const reached of [transportFunctions, readCapable]) {
    const pendingFunctions = [...reached];
    while (pendingFunctions.length) {
      const target = pendingFunctions.pop();
      for (const caller of dependents.get(target) ?? [])
        if (!reached.has(caller)) {
          reached.add(caller);
          pendingFunctions.push(caller);
        }
    }
  }
  function inspect(call, bindings, origin, chain) {
    if (sink(call.expression)) {
      const args = requestArguments(call.expression, [...call.arguments]);
      const names = args ? evaluate(args[0], bindings) : [unknown];
      const parameters = args ? evaluate(args[1], bindings) : [unknown];
      const here = position(origin);
      const implementations = evaluate(call.expression, bindings).filter(
        (value) =>
          value?.function &&
          value.function.body &&
          !ignored(value.function.getSourceFile().fileName) &&
          !chain.has(value.function),
      );
      if (implementations.length) {
        for (const value of implementations) {
          const fn = value.function;
          walk(
            fn.body,
            invocation(fn, args ?? call.arguments, bindings),
            origin,
            new Set([...chain, fn]),
          );
        }
        classified.set(`${here.file}:${here.line}:${here.column}:implementation`, {
          ...here,
          transport: position(call),
          reason: 'Concrete request implementation analyzed instead of assuming gateway transport',
        });
        return;
      }
      if (workerOperation(call)) {
        classified.set(`${here.file}:${here.line}:${here.column}:worker`, {
          ...here,
          transport: position(call),
          reason: 'Object-discriminated worker operation, not a gateway method parameter',
        });
        return;
      }
      if (names.some((name) => name === unknown || name?.stringConstraint))
        unresolved.set(`${here.file}:${here.line}:${here.column}`, {
          ...here,
          transport: position(call),
        });
      for (const method of new Set(names.filter((name) => cached.has(name)))) {
        const exclusion = excludedVariant(method, parameters);
        if (exclusion || command(method, parameters)) {
          classified.set(`${here.file}:${here.line}:${here.column}:${method}`, {
            ...here,
            method,
            transport: position(call),
            reason: exclusion ?? 'Parameter-proven imperative variant',
          });
          continue;
        }
        findings.set(`${here.file}:${here.line}:${here.column}:${method}`, {
          ...here,
          method,
          transport: position(call),
          message: `Use the shared resource cache for ${method}`,
          receiverConstraints: [...bindings.entries()].flatMap(([reference, values]) => {
            if (reference?.name === 'api' && values.some((value) => value?.notReceiver))
              return [
                'Alternate API differs from the singleton gateway; concrete transport remains unsealed',
              ];
            if (reference?.name === 'fixture' && values.length === 1 && values[0] === true)
              return ['Fixture flag is true; this does not prove a non-gateway receiver'];
            return [];
          }),
        });
      }
      const commands = names.filter((name) => typeof name === 'string' && !cached.has(name));
      if (commands.length && !names.some((name) => name === unknown || name?.stringConstraint))
        imperativeCalls.set(`${here.file}:${here.line}:${here.column}`, {
          ...here,
          transport: position(call),
          methods: [...new Set(commands)].sort(),
        });
      return;
    }
    for (const fn of callable(call.expression)) {
      if (
        !fn.body ||
        !transportFunctions.has(fn) ||
        ignored(fn.getSourceFile().fileName) ||
        chain.has(fn)
      )
        continue;
      if (chain.size >= 12) {
        // The bound stays fail-closed only where a deeper call could still reach a read.
        if (!readCapable.has(fn)) continue;
        const here = position(origin);
        unresolved.set(`${here.file}:${here.line}:${here.column}`, {
          ...here,
          transport: position(call),
          reason: 'Transport helper traversal exceeded its depth bound',
        });
        continue;
      }
      const next = invocation(fn, call.arguments, bindings);
      if (ts.isPropertyAccessExpression(call.expression) && !ts.isArrowFunction(fn))
        next.set('this', evaluate(call.expression.expression, bindings));
      walk(fn.body, next, origin, new Set([...chain, fn]));
    }
  }
  function walk(node, bindings, origin, chain) {
    if (functionNode(node) && node.body && !transportFunctions.has(node)) return false;
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      let current = bindings;
      for (const statement of node.statements) {
        if (walk(statement, current, origin, chain)) return true;
        if (ts.isIfStatement(statement)) {
          if (terminates(statement.thenStatement))
            current = assume(statement.expression, false, current);
          else if (statement.elseStatement && terminates(statement.elseStatement))
            current = assume(statement.expression, true, current);
        }
      }
      return false;
    }
    if (ts.isIfStatement(node)) {
      const condition = evaluate(node.expression, bindings);
      if (condition.length === 1 && truth(condition[0]) !== undefined) {
        const branch = truth(condition[0]) ? node.thenStatement : node.elseStatement;
        return branch
          ? walk(branch, assume(node.expression, truth(condition[0]), bindings), origin, chain)
          : false;
      }
      walk(node.expression, bindings, origin, chain);
      const yes = walk(node.thenStatement, assume(node.expression, true, bindings), origin, chain);
      const no = node.elseStatement
        ? walk(node.elseStatement, assume(node.expression, false, bindings), origin, chain)
        : false;
      return yes && no;
    }
    if (ts.isCallExpression(node)) inspect(node, bindings, origin ?? node, chain);
    ts.forEachChild(node, (child) => {
      walk(child, bindings, origin, chain);
    });
    return ts.isReturnStatement(node) || ts.isThrowStatement(node);
  }
  function terminates(node) {
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
    if (ts.isBlock(node)) return node.statements.some(terminates);
    return (
      ts.isIfStatement(node) &&
      node.elseStatement &&
      terminates(node.thenStatement) &&
      terminates(node.elseStatement)
    );
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
    classifiedTransports: [...classified.values()],
    imperativeTransports: [...imperativeCalls.values()],
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
  if (result.findings.length || result.unresolvedTransports.length) process.exitCode = 1;
}

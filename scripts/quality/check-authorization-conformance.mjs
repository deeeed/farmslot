#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const registryPath = resolve(repoRoot, 'packages/protocol/src/rpc/registry.ts');
const allowlistPath = resolve(repoRoot, 'docs/reference/authorization-method-classification.json');
const markdownPath = resolve(repoRoot, 'docs/reference/authorization-method-classification.md');
const generatedRuntimePath = resolve(
  repoRoot,
  'services/gateway/src/security/authorization-classification.generated.ts',
);
const webhookPath = resolve(repoRoot, 'services/gateway/src/webhook.ts');
const callbackFixturePath = resolve(
  repoRoot,
  'scripts/quality/fixtures/authorization-conformance-callback.ts',
);
const queueFixturePath = resolve(
  repoRoot,
  'scripts/quality/fixtures/authorization-conformance-queue.ts',
);
const dispatchQueuePath = resolve(repoRoot, 'services/gateway/src/index.ts');
const routePaths = [
  'services/gateway/src/server/route-method.ts',
  'services/gateway/src/server/run-route.ts',
];
const invariants = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7'];
const forbiddenCallNames = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
  'execLocal',
  'execOnSlot',
  'gitExec',
  'runGit',
  'tmuxSendKeys',
  'sendKeys',
  'write',
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'readFile',
  'readFileSync',
  'open',
  'openSync',
  'createWriteStream',
  'createReadStream',
  'readdir',
  'readdirSync',
  'stat',
  'statSync',
  'lstat',
  'lstatSync',
  'access',
  'accessSync',
  'rename',
  'renameSync',
  'unlink',
  'unlinkSync',
  'rm',
  'rmSync',
  'mkdir',
  'mkdirSync',
  'copyFile',
  'copyFileSync',
]);
const authoritySensitiveNames = new Set([
  'safetyTier',
  'resolveCreateSafetyTier',
  'storedAction',
  'confirmAction',
]);
const write = process.argv.includes('--write-markdown');

const privilegedReasons = {
  'gateway.status': 'runs git fetch against the gateway clone',
  'fleet.status': 'a stale read can shell- and git-probe every slot',
  'run.get': 'reads run artifact paths by pathname',
  'family.observability.get': 'scans and reads task artifacts by pathname',
  'family.report.generate': 'reads artifacts and may launch an unsandboxed report CLI',
  'backlog.upcoming': 'reads project config and spec paths by pathname',
  'decision.list': 'scans task directories and reads decision artifacts',
  'analytics.query': 'enumerates and reads analytics paths directly',
  'analytics.backfill': 'writes analytics records and updates runs',
  'operator.snapshot': 'transitively invokes decision.list',
};

const registry = registryMethods();
const { program, checker } = analysisProgram();
const registrySet = new Set(registry.values());
const routed = routedMethods(registry);
const allMethods = [...new Set([...registry.values(), ...routed])].sort((a, b) =>
  a.localeCompare(b),
);
const rawAllowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
const problems = [];
problems.push(...webhookOriginatorProblems());
problems.push(...callbackIndirectionFixtureProblems(program, checker));
problems.push(...queueFixtureProblems(program, checker));

if (!Array.isArray(rawAllowlist) || rawAllowlist.length !== 8) {
  problems.push('authorization allowlist must be a top-level array with exactly eight entries');
}

const entries = Array.isArray(rawAllowlist) ? rawAllowlist : [];
const seen = new Set();
const normalizedEntries = [];
for (const entry of entries) {
  const method = entry?.method;
  if (typeof method !== 'string' || !method) {
    problems.push('allowlist entry has no exact method name');
    continue;
  }
  if (method.includes('*')) problems.push(`wildcards and family patterns are forbidden: ${method}`);
  if (!registrySet.has(method)) problems.push(`allowlist entry is not in the registry: ${method}`);
  if (seen.has(method)) problems.push(`duplicate allowlist entry: ${method}`);
  seen.add(method);
  if (typeof entry.handler !== 'string' || !entry.handler) {
    problems.push(`allowlist entry has no handler path: ${method}`);
    continue;
  }
  for (const invariant of invariants) {
    if (entry.assertions?.[invariant] !== true) {
      problems.push(`${method} must explicitly assert ${invariant}`);
    }
  }
  const handlerPath = resolve(repoRoot, entry.handler);
  if (!existsSync(handlerPath)) {
    problems.push(`${method} handler does not exist: ${entry.handler}`);
    continue;
  }
  const analysis = analyzeCaseReachability(handlerPath, method, registry, program, checker);
  if (!analysis) {
    problems.push(`${method} has no statically resolvable switch handler in ${entry.handler}`);
    continue;
  }
  for (const finding of analysis.findings) problems.push(`${method}: ${finding}`);
  const reachabilityHash = sha256([...analysis.reachable].sort().join('\n'));
  if (!write && entry.reachabilityHash && entry.reachabilityHash !== reachabilityHash) {
    problems.push(
      `${method} reachability set changed (${entry.reachabilityHash} -> ${reachabilityHash})`,
    );
  }
  normalizedEntries.push({ ...entry, reachabilityHash });
}

problems.push(
  ...dispatchQueueReachabilityProblems(
    new Set(normalizedEntries.map((entry) => entry.method)),
    program,
    checker,
  ),
);

for (const method of routed) {
  if (!allMethods.includes(method)) problems.push(`routed method is unclassified: ${method}`);
}
if (!allMethods.includes('node.connect'))
  problems.push('node.connect is missing from routed methods');

const classifications = allMethods.map((method) => ({
  method,
  classification:
    method === 'node.connect' ? 'node-subject' : seen.has(method) ? 'operator' : 'admin',
  ...(privilegedReasons[method] ? { reason: privilegedReasons[method] } : {}),
}));
const prettier = await import('prettier');
const prettierConfig = await prettier.resolveConfig(markdownPath);
const markdown = await prettier.format(renderMarkdown(classifications), {
  ...prettierConfig,
  parser: 'markdown',
});
const runtime = await prettier.format(renderRuntime(classifications), {
  ...prettierConfig,
  parser: 'typescript',
});
const normalizedJson = `${JSON.stringify(normalizedEntries, null, 2)}\n`;
if (problems.length > 0) {
  console.error(`Authorization conformance guard failed (${problems.length} problem(s)):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

if (write) {
  writeFileSync(allowlistPath, normalizedJson);
  writeFileSync(markdownPath, markdown);
  writeFileSync(generatedRuntimePath, runtime);
  console.log(`Wrote ${allowlistPath}`);
  console.log(`Wrote ${markdownPath}`);
  console.log(`Wrote ${generatedRuntimePath}`);
} else {
  const stale = [];
  if (readFileSync(allowlistPath, 'utf8') !== normalizedJson) stale.push(allowlistPath);
  if (!existsSync(markdownPath) || readFileSync(markdownPath, 'utf8') !== markdown) {
    stale.push(markdownPath);
  }
  if (!existsSync(generatedRuntimePath) || readFileSync(generatedRuntimePath, 'utf8') !== runtime) {
    stale.push(generatedRuntimePath);
  }
  if (stale.length > 0) {
    console.error(
      `Authorization classification artifacts are stale: ${stale.join(', ')}. Run yarn quality:authorization --write-markdown.`,
    );
    process.exit(1);
  }
}

console.log(
  `Authorization conformance guard passed (${classifications.length} routed/registry methods; ${normalizedEntries.length} operator methods).`,
);

function registryMethods() {
  const source = readFileSync(registryPath, 'utf8');
  const file = ts.createSourceFile(registryPath, source, ts.ScriptTarget.Latest, true);
  const methods = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === 'Methods' &&
      node.initializer
    ) {
      const object = unwrapObject(node.initializer);
      for (const property of object?.properties ?? []) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer))
          continue;
        methods.set(property.name.getText(file), property.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (methods.size === 0) throw new Error(`No methods parsed from ${registryPath}`);
  return methods;
}

function webhookOriginatorProblems() {
  const source = readFileSync(webhookPath, 'utf8');
  const file = ts.createSourceFile(webhookPath, source, ts.ScriptTarget.Latest, true);
  const expectedProviders = new Set(['github', 'jira']);
  const observedProviders = new Set();
  const findings = [];
  let addItemCalls = 0;
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(file) === 'kind' &&
      ts.isStringLiteral(node.initializer) &&
      node.initializer.text === 'system'
    ) {
      findings.push('webhook ingress must never stamp work as the system principal');
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'addItem'
    ) {
      addItemCalls += 1;
      const originator = node.arguments[1]?.getText(file);
      if (originator !== 'originator') {
        findings.push(
          `webhook addItem must use the resolved service originator (found ${originator ?? 'none'})`,
        );
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'webhookOriginatorOrReject'
    ) {
      const provider = node.arguments[1];
      if (provider && ts.isStringLiteral(provider) && expectedProviders.has(provider.text)) {
        observedProviders.add(provider.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (addItemCalls !== 2) {
    findings.push(
      `webhook ingress must have exactly two queue persistence sites (found ${addItemCalls})`,
    );
  }
  for (const provider of expectedProviders) {
    if (!observedProviders.has(provider)) {
      findings.push(`webhook ingress is missing ${provider} service-authority resolution`);
    }
  }
  return [...new Set(findings)];
}

function unwrapObject(node) {
  if (ts.isObjectLiteralExpression(node)) return node;
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return unwrapObject(node.expression);
  return undefined;
}

function routedMethods(registryMap) {
  const methods = new Set();
  for (const relativePath of routePaths) {
    const path = resolve(repoRoot, relativePath);
    const source = readFileSync(path, 'utf8');
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isCaseClause(node)) {
        const method = caseMethod(node.expression, file, registryMap);
        if (method) methods.add(method);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return methods;
}

function analysisProgram() {
  const configPath = resolve(repoRoot, 'services/gateway/tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const program = ts.createProgram({
    rootNames: [...parsed.fileNames, callbackFixturePath, queueFixturePath],
    options: parsed.options,
  });
  return { program, checker: program.getTypeChecker() };
}

function analyzeCaseReachability(path, method, registryMap, program, checker) {
  const file = program.getSourceFile(path);
  if (!file) throw new Error(`TypeScript program did not include ${path}`);
  let root;
  const findCase = (node) => {
    if (root) return;
    if (ts.isCaseClause(node) && caseMethod(node.expression, file, registryMap) === method) {
      root = node;
      return;
    }
    ts.forEachChild(node, findCase);
  };
  findCase(file);
  if (!root) return null;

  return analyzeFunctionReachability(root, registryMap, program, checker, new Set([method]));
}

function analyzeFunctionReachability(root, registryMap, program, checker, targetMethods) {
  const reachable = new Set([nodeIdentity(root)]);
  const reachableMethods = new Set();
  const findings = new Set();
  const visitedDeclarations = new Set();

  const visit = (node) => {
    if (ts.isCaseClause(node)) {
      const method = caseMethod(node.expression, node.getSourceFile(), registryMap);
      if (targetMethods.has(method)) reachableMethods.add(method);
    }
    if (ts.isCallExpression(node)) inspectCall(node);
    if (ts.isIdentifier(node) && authoritySensitiveNames.has(node.text)) {
      findings.add(`reads safety-tier or stored-action authority at ${nodeLocation(node)}`);
    }
    ts.forEachChild(node, visit);
  };

  const inspectCall = (call) => {
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
      findings.add(`contains an unresolvable dynamic import edge at ${nodeLocation(call)}`);
      return;
    }
    const callName = calledName(call.expression);
    if (isForbiddenCall(call, callName, checker)) {
      findings.add(
        `reaches forbidden primitive '${callName || call.expression.getText()}' at ${nodeLocation(call)}`,
      );
    }
    const declaration = resolvedImplementation(call, checker);
    if (declaration) {
      visitImplementation(declaration);
      return;
    }
    if (isKnownIntrinsic(call, checker)) {
      for (const argument of call.arguments) inspectIntrinsicCallback(argument, call);
    } else {
      findings.add(
        `has an unresolvable call-graph edge '${call.expression.getText()}' at ${nodeLocation(call)}`,
      );
    }
  };

  const visitImplementation = (declaration) => {
    const identity = nodeIdentity(declaration);
    reachable.add(identity);
    if (visitedDeclarations.has(identity)) return;
    visitedDeclarations.add(identity);
    visit(declarationBody(declaration) ?? declaration);
  };

  const inspectIntrinsicCallback = (argument, call) => {
    if (!isCallableArgument(argument, checker) || isKnownCallableIntrinsic(argument)) return;
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return;
    const declaration = resolvedExpressionImplementation(argument, checker);
    if (declaration) {
      visitImplementation(declaration);
      return;
    }
    findings.add(
      `has an unresolvable intrinsic callback edge '${argument.getText()}' from '${call.expression.getText()}' at ${nodeLocation(argument)}`,
    );
  };

  visit(root);
  return { reachable, findings, reachableMethods };
}

function dispatchQueueReachabilityProblems(targetMethods, program, checker) {
  const file = program.getSourceFile(dispatchQueuePath);
  if (!file) return [`TypeScript program did not include ${dispatchQueuePath}`];
  const callback = findDispatchQueueCallback(file);
  if (!callback) {
    return ['dispatch queue fire callback could not be resolved from initDispatchQueue'];
  }
  const analysis = analyzeFunctionReachability(callback, new Map(), program, checker, targetMethods);
  return [...analysis.reachableMethods].map(
    (method) => `allowlisted method ${method} is reachable from the dispatch queue fire path`,
  );
}

function queueFixtureProblems(program, checker) {
  const file = program.getSourceFile(queueFixturePath);
  if (!file) return ['authorization queue-fire negative fixture was not included'];
  const callback = findDispatchQueueCallback(file);
  if (!callback) return ['authorization queue-fire negative fixture has no dispatch callback'];
  const analysis = analyzeFunctionReachability(
    callback,
    new Map(),
    program,
    checker,
    new Set(['nodes.list']),
  );
  if (analysis.reachableMethods.has('nodes.list')) return [];
  return ['authorization queue-fire negative fixture was not rejected'];
}

function findDispatchQueueCallback(file) {
  let callback;
  const visit = (node) => {
    if (callback) return;
    if (ts.isCallExpression(node) && calledName(node.expression) === 'initDispatchQueue') {
      const candidate = node.arguments[1];
      if (candidate && (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate))) {
        callback = candidate;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return callback;
}

function callbackIndirectionFixtureProblems(program, checker) {
  const analysis = analyzeCaseReachability(
    callbackFixturePath,
    'fixture.callback',
    new Map(),
    program,
    checker,
  );
  if (
    analysis &&
    [...analysis.findings].some((finding) =>
      finding.includes("reaches forbidden primitive 'execLocal'"),
    ) &&
    [...analysis.reachable].some((identity) => identity.endsWith('#forbiddenCallback'))
  ) {
    return [];
  }
  return ['authorization callback-indirection negative fixture was not rejected'];
}

function resolvedImplementation(call, checker) {
  const candidates = [];
  const signature = checker.getResolvedSignature(call);
  if (signature?.declaration) candidates.push(signature.declaration);
  let symbol = checker.getSymbolAtLocation(call.expression);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  if (symbol?.declarations) candidates.push(...symbol.declarations);
  for (const declaration of candidates) {
    const body = declarationBody(declaration);
    if (!body) continue;
    const source = declaration.getSourceFile();
    if (source.isDeclarationFile || !resolve(source.fileName).startsWith(`${repoRoot}/`)) continue;
    return declaration;
  }
  return undefined;
}

function resolvedExpressionImplementation(expression, checker) {
  let symbol = checker.getSymbolAtLocation(expression);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  for (const declaration of symbol?.declarations ?? []) {
    if (!declarationBody(declaration)) continue;
    const source = declaration.getSourceFile();
    if (source.isDeclarationFile || !resolve(source.fileName).startsWith(`${repoRoot}/`)) continue;
    return declaration;
  }
  return undefined;
}

function declarationBody(declaration) {
  if ('body' in declaration && declaration.body) return declaration.body;
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer))
  ) {
    return declaration.initializer.body;
  }
  return undefined;
}

function calledName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteral(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return '';
}

function isCallableArgument(argument, checker) {
  return (
    ts.isArrowFunction(argument) ||
    ts.isFunctionExpression(argument) ||
    checker.getTypeAtLocation(argument).getCallSignatures().length > 0
  );
}

function isKnownCallableIntrinsic(argument) {
  return (
    ts.isIdentifier(argument) &&
    new Set([
      'structuredClone',
      'String',
      'Number',
      'Boolean',
      'parseInt',
      'parseFloat',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ]).has(argument.text)
  );
}

function isForbiddenCall(call, name, checker) {
  if (forbiddenCallNames.has(name)) {
    if (name !== 'write') return true;
    const receiver = ts.isPropertyAccessExpression(call.expression)
      ? call.expression.expression.getText()
      : '';
    if (/\b(?:pty|stdin|stdout|socket|stream)\b/iu.test(receiver)) return true;
  }
  if (/^(?:git(?:[A-Z_]|$)|.*Git(?:[A-Z_]|$)|.*_git(?:_|$))/u.test(name)) return true;
  if (name === 'sendNodeRequest') {
    const methodText = call.arguments.map((argument) => argument.getText()).join(' ');
    return /['"](?:exec|fs\.)/u.test(methodText) || !/['"][^'"]+['"]/u.test(methodText);
  }
  const symbol = checker.getSymbolAtLocation(call.expression);
  const declarations = symbol?.declarations ?? [];
  return declarations.some((declaration) => {
    const file = declaration.getSourceFile().fileName;
    return /node:(?:child_process|fs)|@types\/node\/(?:child_process|fs)/u.test(file);
  });
}

function isKnownIntrinsic(call, checker) {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) {
    return new Set([
      'structuredClone',
      'String',
      'Number',
      'Boolean',
      'parseInt',
      'parseFloat',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ]).has(expression.text);
  }
  if (!ts.isPropertyAccessExpression(expression)) return false;
  const receiverText = expression.expression.getText();
  if (/^(?:console|JSON|Object|Array|Number|Math|Promise|Date)$/u.test(receiverText)) return true;
  const receiverType = checker.typeToString(checker.getTypeAtLocation(expression.expression));
  return /(?:\[\]|Array<|readonly |string|Map<|Set<|Date|RegExp)/u.test(receiverType);
}

function nodeIdentity(node) {
  const source = node.getSourceFile();
  const relative = source.fileName.startsWith(repoRoot)
    ? source.fileName.slice(repoRoot.length + 1)
    : source.fileName;
  const name = ts.isCaseClause(node)
    ? `case:${node.expression.getText(source)}`
    : (node.name?.getText(source) ?? declarationContainerName(node, source));
  return `${relative}#${name}`;
}

function nodeLocation(node) {
  const source = node.getSourceFile();
  const relative = source.fileName.startsWith(repoRoot)
    ? source.fileName.slice(repoRoot.length + 1)
    : source.fileName;
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${relative}:${position.line + 1}`;
}

function declarationContainerName(node, source) {
  let current = node.parent;
  while (current) {
    if (current.name && typeof current.name.getText === 'function') {
      return `${current.name.getText(source)}:${ts.SyntaxKind[node.kind]}`;
    }
    current = current.parent;
  }
  return `${ts.SyntaxKind[node.kind]}:${sha256(node.getText(source)).slice(0, 12)}`;
}

function caseMethod(expression, file, registryMap) {
  if (ts.isStringLiteral(expression)) return expression.text;
  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.expression.getText(file) === 'Methods'
  ) {
    return registryMap.get(expression.name.text);
  }
  return undefined;
}

function renderMarkdown(classifications) {
  const lines = [
    '# Authorization Method Classification',
    '',
    'Generated by `scripts/quality/check-authorization-conformance.mjs`.',
    'The table is normative; unlisted or unproven methods are admin-only.',
    '',
    '| Method | Classification | Admin reason |',
    '| --- | --- | --- |',
  ];
  for (const entry of classifications) {
    lines.push(`| \`${entry.method}\` | ${entry.classification} | ${entry.reason ?? ''} |`);
  }
  return `${lines.join('\n')}\n`;
}

function renderRuntime(classifications) {
  const entries = classifications
    .map(
      (entry) =>
        `  ${JSON.stringify(entry.method)}: { classification: ${JSON.stringify(entry.classification)}${entry.reason ? `, reason: ${JSON.stringify(entry.reason)}` : ''} },`,
    )
    .join('\n');
  return `// Generated by scripts/quality/check-authorization-conformance.mjs. Do not edit.\nexport const AUTHORIZATION_METHOD_CLASSIFICATION = {\n${entries}\n} as const;\n\nexport type AuthorizationMethodName = keyof typeof AUTHORIZATION_METHOD_CLASSIFICATION;\n`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

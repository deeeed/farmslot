import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  analyzeCachedPanelReads,
  IMPLEMENTATION_FILES,
  readCachedMethods,
} from './check-cached-panel-reads.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = (name) => path.join(root, 'scripts/quality/fixtures/cached-panel-reads', name);

test('cached method inventory comes from the closed registry, including memory-only reads', () => {
  const { cached } = readCachedMethods(root);
  assert(cached.has('backlog.list'));
  assert(cached.has('copilot.status'));
  assert(cached.has('prRules.list'));
  assert(!cached.has('run.create'));
  assert(!IMPLEMENTATION_FILES.has('apps/command-center/ui/src/dev/new-panel.ts'));
  assert(!IMPLEMENTATION_FILES.has('apps/companion/src/farmslot/new-panel.ts'));
});

test('fixture rejects cached reads through direct, aliased and indirect RPC calls', () => {
  const file = fixture('violations.ts');
  const result = analyzeCachedPanelReads({ repoRoot: root, files: [file] });
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = source.statements.filter(ts.isVariableStatement).flatMap((statement) =>
    statement.declarationList.declarations
      .filter((node) => ts.isIdentifier(node.name) && node.initializer)
      .map((node) => ({
        name: node.name.text,
        start: node.initializer.getStart(source),
        end: node.initializer.end,
      })),
  );
  const binding = (finding) => {
    const point = source.getPositionOfLineAndCharacter(finding.line - 1, finding.column - 1);
    return declarations.find((node) => point >= node.start && point < node.end)?.name;
  };
  const expected = [
    'direct',
    'resourceTransport',
    'alias',
    'methodDestructure',
    'boundTransport',
    'preboundMethod',
    'calledTransport',
    'appliedTransport',
    'transportDestructure',
    'helperRead',
    'destructuredHelper',
    'indexedTransport',
    'falseForce',
    'uncertainForce',
    'unrelatedForce',
    'overwrittenForce',
    'reportRead',
    'unionMethod',
    'changedFlag',
  ];
  assert.deepEqual(new Set(result.findings.map(binding)), new Set(expected));
  const helper = result.findings.find((finding) => binding(finding) === 'helperRead');
  assert.equal(helper.method, 'pr.list');
  assert(helper.transport.file.endsWith('/request-helper.ts'));
});

test('fixture accepts shared-cache observations and parameter-proven commands', () => {
  const result = analyzeCachedPanelReads({ repoRoot: root, files: [fixture('compliant.ts')] });
  assert.deepEqual(result.findings, []);
});

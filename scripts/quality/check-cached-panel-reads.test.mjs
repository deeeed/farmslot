import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('parameter branches, concrete fixture receivers and constructor cache providers are classified', () => {
  const result = analyzeCachedPanelReads({
    repoRoot: root,
    files: [fixture('variants-compliant.ts')],
  });
  assert.deepEqual(result.findings, []);
  assert(
    result.classifiedTransports.some((item) => item.reason.includes('Nonempty roadmap search')),
  );
  assert(
    result.classifiedTransports.some((item) => item.reason.includes('Absolute artifact path')),
  );
  assert(result.classifiedTransports.some((item) => item.reason.includes('Frozen run-only')));
  assert(result.classifiedTransports.some((item) => item.reason.includes('worker operation')));
  assert(
    result.classifiedTransports.some((item) =>
      item.reason.includes('Concrete request implementation'),
    ),
  );
  assert(
    result.imperativeTransports.some(
      (item) =>
        item.methods.includes('backlog.dequeue') && item.methods.includes('dispatch.queue.remove'),
    ),
  );
});

test('mixed eligible reads, missing cache providers and unsealed fixture receivers remain visible', () => {
  const file = fixture('variants-violations.ts');
  const result = analyzeCachedPanelReads({ repoRoot: root, files: [file] });
  const source = readFileSync(file, 'utf8').split('\n');
  const required = [
    'uncertainSearch',
    'emptySearch',
    'runSearch',
    'slotFrozenSource',
    'mixedFrozenSource',
    'unpinnedRunSource',
    'absoluteOverridden',
    'relativeSource',
    'uncertainPath',
    'withoutCacheProvider',
    'fixtureFlagIsNotFakeReceiver',
  ];
  // A formatted declaration may wrap its call onto later lines.
  const declared = (name) => {
    const start = source.findIndex((text) => text.startsWith(`export const ${name} =`)) + 1;
    assert(start > 0, `Missing fixture ${name}`);
    const next = source.findIndex((text, index) => index >= start && text.startsWith('export '));
    const end = next === -1 ? source.length : next;
    return (item) => item.line >= start && item.line <= end;
  };
  for (const name of required)
    assert(result.findings.some(declared(name)), `Missing violation for ${name}`);
  assert(result.unresolvedTransports.some(declared('unresolvedMethod')));
});

test('CLI rejects unresolved transport methods even without a known cached-read finding', () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, 'scripts/quality/check-cached-panel-reads.mjs'),
      '--json',
      '--files',
      fixture('unknown-transport.ts'),
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.findings, []);
  assert.equal(report.unresolvedTransports.length, 1);
});

test('typed uncached command helpers cannot exhaust the depth bound; open methods still do', () => {
  const typedResult = analyzeCachedPanelReads({
    repoRoot: root,
    files: [fixture('typed-commands.ts')],
  });
  assert.deepEqual(typedResult.findings, []);
  assert.deepEqual(typedResult.unresolvedTransports, []);
  const open = analyzeCachedPanelReads({
    repoRoot: root,
    files: [fixture('typed-commands-open.ts')],
  });
  assert(
    open.unresolvedTransports.some((item) => item.reason?.includes('exceeded its depth bound')),
  );
  assert.deepEqual(
    open.findings.map(({ method }) => method),
    ['run.list'],
  );
});

test('shared unused object fields do not expand while classifying the selected read', () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, 'scripts/quality/check-cached-panel-reads.mjs'),
      '--json',
      '--files',
      fixture('shared-fields.ts'),
    ],
    { cwd: root, encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.findings.map(({ method }) => method),
    ['run.list'],
  );
});

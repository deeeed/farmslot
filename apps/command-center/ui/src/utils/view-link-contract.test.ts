import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { COMMAND_CENTER_SURFACES } from '@farmslot/protocol/surfaces/command-center';
import {
  validViewRoute,
  VIEW_QUERY_PARAMETERS,
  viewLinkFromRoute,
  viewRouteFromLink,
} from '@farmslot/protocol/surfaces/view-links';

import { familyRunHash } from '../components/runs/family-observability-url-state.js';
import {
  runDetailEvidenceArtifactHash,
  runDetailStepHash,
} from '../components/runs/run-detail-url-state.js';
import { runsHashWithState } from '../state-url-state.js';

test('actual navigation builders round trip through the desktop contract', () => {
  const routes = [
    runDetailStepHash('run-1', 'monitor', '#runs?run=run-1'),
    runDetailEvidenceArtifactHash('run-1', { path: 'artifacts/report.md' }, '#run/run-1'),
    runsHashWithState(
      { tab: 'history', status: 'failed', q: 'release', tag: 'daily', family: 'f1' },
      '#runs',
    )!,
    familyRunHash('f1', 'run-1', { tokens: 'run', evidence: 'all', gate: 'max' }),
  ];
  for (const route of routes) {
    assert.equal(validViewRoute(route), true, route);
    assert.equal(viewRouteFromLink(viewLinkFromRoute(route)), route);
  }
  for (const surface of COMMAND_CENTER_SURFACES) {
    assert.equal(validViewRoute(surface.sampleHash), true, surface.surfaceId);
    for (const key of surface.queryParams)
      assert.ok(VIEW_QUERY_PARAMETERS.has(key), `${surface.surfaceId}: ${key}`);
  }
});

test('navigation parameter declarations cannot drift from desktop sharing', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith('.ts') && !file.endsWith('.test.ts')) files.push(file);
    }
  }
  walk(root);
  const configPath = path.join(root, '../tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram(files, parsed.options);
  const checker = program.getTypeChecker();
  const missing = new Set<string>();
  function check(key: string, file: string) {
    // These two parameters version /api/run-artifact responses, not hash navigation.
    if (
      file.endsWith('/workspace/ready-workspace-action-presenter.ts') &&
      ['v', 'vsize'].includes(key)
    )
      return;
    if (!VIEW_QUERY_PARAMETERS.has(key)) missing.add(`${path.relative(root, file)}: ${key}`);
  }
  for (const file of files) {
    const source = program.getSourceFile(file)!;
    const ownsHashState =
      file.endsWith('url-state.ts') ||
      /\b(?:parseHashRoute|hashParams|getHashParam)\b|location\.hash/.test(source.text);
    function visit(node: ts.Node) {
      // URL state helpers own dynamic query construction. Resolve constants and
      // literal unions, including loop keys such as keyof RunsHashState.
      if (
        ownsHashState &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['get', 'set', 'has', 'delete', 'append'].includes(node.expression.name.text) &&
        node.arguments[0] &&
        checker.typeToString(checker.getTypeAtLocation(node.expression.expression)) ===
          'URLSearchParams'
      ) {
        const type = checker.getTypeAtLocation(node.arguments[0]);
        for (const member of type.isUnion() ? type.types : [type]) {
          if (member.isStringLiteral()) check(member.value, file);
        }
      }
      // Include hand-authored hash links outside the URL-state helpers. Only
      // hash navigation participates; API query parameters are a separate contract.
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const text = node.text;
        if (text.startsWith('#') || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          const template =
            ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.parent.parent : null;
          const isHash =
            text.startsWith('#') ||
            (template && ts.isTemplateExpression(template) && template.head.text.startsWith('#'));
          if (isHash)
            for (const match of text.matchAll(/[?&]([a-zA-Z][\w]*)=/g)) check(match[1], file);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(
    [...missing].sort(),
    [],
    'Register navigation keys in the shared view-link contract',
  );
  // Guard the source walk itself against silently scanning an empty directory.
  assert.ok(files.some((file) => readFileSync(file, 'utf8').includes('RUNS_TAB_PARAM')));
});

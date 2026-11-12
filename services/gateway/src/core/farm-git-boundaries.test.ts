import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const mutation =
  /\bgit(?:\s+-[Cc]\s+(?:'[^']*'|"[^"]*"|\S+))*\s+(?:fetch|pull|gc|repack|commit(?:-tree)?|merge(?:-tree)?|rebase|checkout|worktree|push)(?![-\w])/;

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sources(file)
      : /\.(?:test|live|test-support)\.ts$/.test(file) || !file.endsWith('.ts')
        ? []
        : [file];
  });
}

function hasGitMutation(node: ts.Node): boolean {
  if (
    ts.isArrayLiteralExpression(node) &&
    node.elements[0] &&
    ts.isStringLiteralLike(node.elements[0]) &&
    node.elements[0].text === 'git'
  ) {
    return mutation.test(
      node.elements
        .map((element) => (ts.isStringLiteralLike(element) ? element.text : 'ARG'))
        .join(' '),
    );
  }
  if (ts.isStringLiteralLike(node)) return mutation.test(node.text);
  if (ts.isTemplateExpression(node)) {
    return mutation.test(
      node.head.text + node.templateSpans.map((span) => `ARG${span.literal.text}`).join(''),
    );
  }
  return node.getChildren().some(hasGitMutation);
}

test('slot execution requires explicit farm scope for literal Git mutations', () => {
  const violations: string[] = [];
  // Worker commands must stay unwrapped. Add only exact, reviewed sites here;
  // currently no literal Git mutation belongs to a worker execution boundary.
  const workerOwned = new Set<string>();
  for (const file of sources(sourceRoot)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        /^(execOnSlot|execArgvOnSlot|execLocal)$/.test(node.expression.getText(source))
      ) {
        const command = node.arguments[node.expression.getText(source) === 'execLocal' ? 0 : 1];
        if (
          command &&
          hasGitMutation(command) &&
          !/\bwithFarmGit(?:Config|Argv)\(/.test(command.getText(source))
        ) {
          const site = `${path.relative(sourceRoot, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
          if (!workerOwned.has(site)) violations.push(site);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(violations, []);
});

test('indirect farm Git executors wrap their payload before slot execution', () => {
  // These adapters take variables or script builders, so the literal scan above
  // cannot follow them. Keep the guard at the execution call, not merely an import.
  const boundaries: Array<[string, string]> = [
    ['run-engine/branch-freshness.ts', 'withFarmGitConfig(script)'],
    ['run-engine/diff-artifacts.ts', 'withFarmGitConfig(command)'],
    ['review/templates.ts', 'withFarmGitConfig(`cd ${shellQuote(vars.remoteRepo)} && ${command}`)'],
    [
      'methods/dispatch/branch-checkout.ts',
      'withFarmGitConfig(branchHolderGitCommand(vars.remoteRepo, branch, true))',
    ],
    ['work-graph/attach-run.ts', 'withFarmGitConfig(command)'],
    ['fleet/slot-scaffolding.ts', 'withFarmGitConfig(['],
    ['run-engine/push-verification.ts', 'withFarmGitConfig(command)'],
  ];
  for (const [file, wrapper] of boundaries) {
    const source = ts.createSourceFile(
      file,
      readFileSync(path.join(sourceRoot, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    let found = false;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === 'execOnSlot' &&
        node.arguments[1]?.getText(source).replace(/\s+/g, '').includes(wrapper.replace(/\s+/g, ''))
      )
        found = true;
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.ok(found, `${file}: missing scoped Git execution`);
  }
});

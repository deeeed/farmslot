import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(repoRoot, 'scripts/quality/fixtures/role-template-mark-guard');
const roleTemplateRelPaths = [
  'metamask-extension-farm/templates/worker/self-review.md',
  'metamask-extension-farm/templates/worker/self-review-fix.md',
  'metamask-extension-farm/templates/worker/ci-fix.md',
  'metamask-mobile-farm/templates/worker/self-review.md',
  'metamask-mobile-farm/templates/worker/self-review-fix.md',
  'metamask-mobile-farm/templates/worker/ci-fix.md',
  'metamask-core-farm/templates/worker/self-review.md',
  'metamask-core-farm/templates/worker/self-review-fix.md',
  'metamask-core-farm/templates/worker/ci-fix.md',
];

function resolveTemplatePaths(rootDir, relPaths) {
  return relPaths
    .map((rel) => ({ rel, abs: path.join(rootDir, rel) }))
    .filter(({ abs }) => existsSync(abs));
}

const fixtureTemplates = resolveTemplatePaths(fixtureRoot, roleTemplateRelPaths);
const operatorTemplates = resolveTemplatePaths(
  path.join(repoRoot, 'projects'),
  roleTemplateRelPaths.map((rel) => rel),
);

test('role-template mark guard is not vacuous — tracked fixtures must cover all role templates', () => {
  assert.equal(
    fixtureTemplates.length,
    roleTemplateRelPaths.length,
    `expected ${roleTemplateRelPaths.length} tracked fixture templates under scripts/quality/fixtures/role-template-mark-guard; found ${fixtureTemplates.length}`,
  );
});

function assertRoleTemplateUsesTaskDirMark(rel, abs) {
  const src = readFileSync(abs, 'utf8');
  assert.doesNotMatch(src, /mark-self-review/);
  assert.doesNotMatch(src, /packages\/skills\/scripts\/mark-checklist-step\.cjs/);
  assert.doesNotMatch(
    src,
    /node\s+\{\{farmslot_dir\}\}\/packages\/agent-runtime\/scripts\/mark-checklist-step\.cjs/,
  );
  assert.match(src, /\{\{TASK_DIR\}\}\/mark/);
}

for (const { rel, abs } of fixtureTemplates) {
  test(`fixture ${rel}: role templates use bare {{TASK_DIR}}/mark`, () => {
    assertRoleTemplateUsesTaskDirMark(rel, abs);
  });
}

for (const { rel, abs } of operatorTemplates) {
  test(`projects/${rel}: live pack templates stay aligned with task-dir ./mark`, () => {
    assertRoleTemplateUsesTaskDirMark(rel, abs);
  });
}

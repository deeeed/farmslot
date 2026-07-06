import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/**
 * Byte-compare a committed fixture against its live pack template. Returns null when in sync
 * OR when the live template is absent (a bare clone without the gitignored packs), and a drift
 * message otherwise. The guard checks committed fixture COPIES so it stays non-vacuous on bare
 * clones; this closes the gap where those copies could silently drift from the real
 * projects/ templates on any machine that has the packs (Arthur's dev, a populated CI).
 */
export function roleTemplateDrift(fixtureAbs, projectAbs) {
  if (!existsSync(projectAbs)) return null; // packs not checked out — nothing to compare
  const fixture = readFileSync(fixtureAbs, 'utf8');
  const project = readFileSync(projectAbs, 'utf8');
  if (fixture === project) return null;
  return `fixture ${fixtureAbs} has drifted from the live pack template ${projectAbs}; re-copy the pack template into the fixture so the guard checks current content`;
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

// Fail loudly if a committed fixture no longer byte-matches its live pack template — only when
// the packs are present (Arthur's dev, populated CI); a no-op on bare clones.
for (const { rel, abs } of fixtureTemplates) {
  test(`fixture ${rel}: byte-matches the live pack template when the packs are present`, () => {
    const drift = roleTemplateDrift(abs, path.join(repoRoot, 'projects', rel));
    assert.equal(drift, null, drift ?? undefined);
  });
}

test('roleTemplateDrift flags a drifted fixture, passes a match, and no-ops without the pack', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'role-template-drift-'));
  try {
    const fixture = path.join(dir, 'fixture.md');
    const project = path.join(dir, 'project.md');
    writeFileSync(fixture, 'ROLE TEMPLATE\n{{TASK_DIR}}/mark 1\n');
    // Matching → in sync.
    writeFileSync(project, 'ROLE TEMPLATE\n{{TASK_DIR}}/mark 1\n');
    assert.equal(roleTemplateDrift(fixture, project), null);
    // Drifted → a message naming both paths.
    writeFileSync(project, 'ROLE TEMPLATE\n{{TASK_DIR}}/mark 1\nEXTRA LINE\n');
    const drift = roleTemplateDrift(fixture, project);
    assert.match(drift ?? '', /drifted from the live pack template/);
    // Pack absent → bare clone, nothing to compare.
    assert.equal(roleTemplateDrift(fixture, path.join(dir, 'missing.md')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

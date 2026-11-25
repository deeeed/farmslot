import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// First-party guard only: external project packs are gitignored nested repos and
// enforce their own template rules in their own CI (via the published
// @farmslot/agent-runtime lint). Farmslot tests never read pack content.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workerTemplateDir = path.join(repoRoot, 'projects/farmslot-farm/templates/worker');

function assertRoleTemplateUsesTaskDirMark(abs) {
  const src = readFileSync(abs, 'utf8');
  assert.doesNotMatch(src, /mark-review/);
  assert.doesNotMatch(src, /packages\/skills\/scripts\/mark-checklist-step\.cjs/);
  assert.doesNotMatch(
    src,
    /node\s+\{\{farmslot_dir\}\}\/packages\/agent-runtime\/scripts\/mark-checklist-step\.cjs/,
  );
  if (path.basename(abs) === 'review-pr.static.md') {
    // Static review text is not rendered; the launch prompt supplies the task cwd.
    assert.doesNotMatch(src, /\{\{/);
    assert.match(
      src,
      /From the task directory supplied in the launch prompt, run `\.\/mark complete --mark-last`/,
    );
  } else {
    assert.match(src, /\{\{TASK_DIR\}\}\/mark/);
  }
}

const templates = existsSync(workerTemplateDir)
  ? readdirSync(workerTemplateDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => ({
        rel: `farmslot-farm/templates/worker/${name}`,
        abs: path.join(workerTemplateDir, name),
      }))
  : [];

test('role-template mark guard is not vacuous — farmslot-farm worker templates exist', () => {
  assert.ok(
    templates.length >= 5,
    `expected the tracked farmslot-farm worker templates under ${workerTemplateDir}; found ${templates.length}`,
  );
});

for (const { rel, abs } of templates) {
  test(`${rel}: role templates mark the selected task`, () => {
    assertRoleTemplateUsesTaskDirMark(abs);
  });
}

// A step a template tells the worker to skip must carry [OPTIONAL:], or `mark N --skip`
// is refused and the worker blocks (d2174be1). Pin the rows each conditional rule names.
const checklistOrder = createRequire(import.meta.url)(
  path.join(repoRoot, 'packages/agent-runtime/scripts/checklist-order.cjs'),
);
for (const [name, steps] of [
  ['dev.md', [6, 7, 11, 12, 13, 14, 15, 19]],
  ['fix-bug.md', [9, 10]],
  ['review-pr.md', [10, 11, 12, 13, 14, 15, 16, 18, 19]],
]) {
  test(`farmslot-farm/templates/worker/${name}: conditional steps are declared optional`, () => {
    const markdown = readFileSync(path.join(workerTemplateDir, name), 'utf8');
    assert.deepEqual(
      checklistOrder.declarations(markdown, 'CHECKLIST.md').map((step) => step.stepNumber),
      steps,
    );
  });
}

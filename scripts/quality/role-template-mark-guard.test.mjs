import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  assert.doesNotMatch(src, /mark-self-review/);
  assert.doesNotMatch(src, /packages\/skills\/scripts\/mark-checklist-step\.cjs/);
  assert.doesNotMatch(
    src,
    /node\s+\{\{farmslot_dir\}\}\/packages\/agent-runtime\/scripts\/mark-checklist-step\.cjs/,
  );
  assert.match(src, /\{\{TASK_DIR\}\}\/mark/);
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
  test(`${rel}: role templates use bare {{TASK_DIR}}/mark`, () => {
    assertRoleTemplateUsesTaskDirMark(abs);
  });
}

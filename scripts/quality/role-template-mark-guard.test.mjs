import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const roleTemplates = [
  'projects/metamask-extension-farm/templates/worker/self-review.md',
  'projects/metamask-extension-farm/templates/worker/self-review-fix.md',
  'projects/metamask-extension-farm/templates/worker/ci-fix.md',
  'projects/metamask-mobile-farm/templates/worker/self-review.md',
  'projects/metamask-mobile-farm/templates/worker/self-review-fix.md',
  'projects/metamask-mobile-farm/templates/worker/ci-fix.md',
  'projects/metamask-core-farm/templates/worker/self-review.md',
  'projects/metamask-core-farm/templates/worker/self-review-fix.md',
  'projects/metamask-core-farm/templates/worker/ci-fix.md',
];

for (const rel of roleTemplates) {
  test(`${rel}: role templates use bare {{TASK_DIR}}/mark and no explicit mark-checklist-step invocations`, () => {
    const abs = path.join(repoRoot, rel);
    const src = readFileSync(abs, 'utf8');
    assert.doesNotMatch(src, /mark-self-review/);
    assert.doesNotMatch(src, /packages\/skills\/scripts\/mark-checklist-step\.cjs/);
    assert.doesNotMatch(
      src,
      /node\s+\{\{farmslot_dir\}\}\/packages\/agent-runtime\/scripts\/mark-checklist-step\.cjs/,
    );
    assert.match(src, /\{\{TASK_DIR\}\}\/mark/);
  });
}

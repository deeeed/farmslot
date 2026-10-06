import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The projects dir is read once at config load, so point it at a fixture
// before the gateway modules are imported.
const projectsRoot = await mkdtemp(path.join(tmpdir(), 'farmslot-unhosted-projects-'));
await mkdir(path.join(projectsRoot, 'unhosted-farm'), { recursive: true });
await writeFile(path.join(projectsRoot, 'unhosted-farm', 'project.json'), '{}\n');
process.env.FARMSLOT_PROJECTS_DIR = projectsRoot;

const { buildDraftPrBody } = await import('./draft-pr.js');
const { sanitizePRBody, localPrBodyPathResidues } = await import('./publication-artifacts.js');
const { makeRun } = await import('./test-fixtures.js');

test.after(() => rm(projectsRoot, { recursive: true, force: true }));

test('buildDraftPrBody lists evidence names when the project has no artifacts repo', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-pr-body-unhosted-'));
  try {
    await mkdir(path.join(root, 'artifacts'), { recursive: true });
    const taskFile = path.join(root, 'task.md');
    await writeFile(taskFile, '# Task\n');
    await writeFile(
      path.join(root, 'artifacts', 'pr-description.md'),
      '## Summary\n\nDrawer.\n\n## **Screenshots/Recordings**\n\n<!-- [screenshots/recordings] -->\n',
    );

    const run = makeRun({
      id: 'b8f56192-cfe8-4f16-a924-2814e6b04fc2',
      project: 'unhosted-farm',
      taskFile,
    });
    const body = await buildDraftPrBody(run, null, [
      { path: 'artifacts/recipe-run/screenshots/recipe/01-drawer-open.png', purpose: 'screenshot' },
      { path: 'artifacts/recipe-run/screenshots/recipe/02-search.png', purpose: 'screenshot' },
    ]);

    assert.doesNotMatch(body, /<img/);
    assert.match(body, /Farmslot run `b8f56192` evidence/);
    assert.match(body, /^- `01-drawer-open\.png`$/m);
    assert.match(body, /^- `02-search\.png`$/m);
    // The publish pass must leave the list intact.
    assert.equal(sanitizePRBody(body), body);
    assert.deepEqual(localPrBodyPathResidues(body), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

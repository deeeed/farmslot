import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('the task wrapper runs twice with fresh packages and never overwrites promoted media', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wrapper-retained-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const task = path.join(dir, 'task');
  const artifacts = path.join(task, 'artifacts');
  const bin = path.join(dir, 'bin');
  await mkdir(artifacts, { recursive: true });
  await mkdir(bin);
  const recipe = path.join(artifacts, 'recipe.json');
  const document = JSON.stringify({
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Finish the isolated wrapper execution.',
    workflow: { entry: 'done', nodes: { done: { action: 'end', status: 'pass' } } },
  });
  await writeFile(recipe, document);
  await writeFile(path.join(artifacts, 'after.mp4'), 'old retained media');
  // Isolate UI/runner execution; exercise the real wrapper allocation,
  // selection helper and media sync. Runner admission has separate coverage.
  const driver = path.join(dir, 'driver.mjs');
  await writeFile(
    driver,
    `
    import {mkdir,writeFile} from 'node:fs/promises';
    import path from 'node:path';
    const argv=process.argv.slice(2);const artifactsDir=argv[argv.indexOf('--artifacts-dir')+1];
    await mkdir(path.join(artifactsDir,'videos'),{recursive:true});
    await writeFile(path.join(artifactsDir,'summary.json'),'{"status":"pass"}');
    await writeFile(path.join(artifactsDir,'videos/recipe-run.mp4'),'unit moov media '+artifactsDir);
  `,
  );
  const nodeShim = path.join(bin, 'node');
  await writeFile(
    nodeShim,
    `#!/usr/bin/env bash\nset -eu\nif [[ "$1" == */run-recipe.mjs ]]; then\n  shift\n  exec '${process.execPath}' '${driver}' "$@"\nfi\nexec '${process.execPath}' "$@"\n`,
  );
  await chmod(nodeShim, 0o755);
  await writeFile(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(bin, 'npm'), 0o755);
  const invoke = () =>
    execFileSync(
      'bash',
      [
        path.join(root, 'projects/farmslot-farm/setup/validate-recipe.sh'),
        '--recipe',
        recipe,
        '--artifacts-dir',
        path.join(artifacts, 'recipe-run'),
        '--record-video',
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          TSX_TSCONFIG_PATH: path.join(root, 'packages/recipe-runner/tsconfig.json'),
          CAPTURE_HELPER_PATH: process.execPath,
        },
        encoding: 'utf8',
        timeout: 5_000,
      },
    );
  invoke();
  const first = JSON.parse(
    await readFile(path.join(artifacts, 'latest-valid-recipe-run.json'), 'utf8'),
  );
  const firstRoot = path.join(artifacts, first.relativeArtifactRoot);
  const firstVideo = await readFile(path.join(firstRoot, 'videos/recipe-run.mp4'));
  const firstSummary = await readFile(path.join(firstRoot, 'summary.json'));
  invoke();
  const second = JSON.parse(
    await readFile(path.join(artifacts, 'latest-valid-recipe-run.json'), 'utf8'),
  );
  assert.notEqual(first.relativeArtifactRoot, second.relativeArtifactRoot);
  assert.deepEqual(await readFile(path.join(firstRoot, 'videos/recipe-run.mp4')), firstVideo);
  assert.deepEqual(await readFile(path.join(firstRoot, 'summary.json')), firstSummary);
  assert.equal(await readFile(path.join(artifacts, 'after.mp4'), 'utf8'), 'old retained media');
  assert.equal(await readFile(recipe, 'utf8'), document);
  execFileSync(
    'bash',
    [
      path.join(root, 'projects/farmslot-farm/setup/sync-recipe-evidence.sh'),
      '--task-dir',
      task,
      '--require-video',
    ],
    { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, timeout: 5_000 },
  );
  const manifest = JSON.parse(
    await readFile(path.join(artifacts, 'evidence-manifest.json'), 'utf8'),
  );
  assert.equal(
    manifest.videos.after,
    `artifacts/${second.relativeArtifactRoot}/videos/recipe-run.mp4`,
  );
});

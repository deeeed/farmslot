import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

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
  // selected engine manifest. Runner admission has separate coverage.
  const driver = path.join(dir, 'driver.mjs');
  await writeFile(
    driver,
    `
    import {mkdir,readFile,writeFile} from 'node:fs/promises';
    import {createRequire} from 'node:module';
    const require=createRequire(${JSON.stringify(path.join(root, 'packages/recipe-cli/package.json'))});
    const {digestRecipeDocument}=require('@farmslot/protocol/recipe');
    import path from 'node:path';
    const argv=process.argv.slice(2);const artifactsDir=argv[argv.indexOf('--artifacts-dir')+1];
    await mkdir(path.join(artifactsDir,'videos'),{recursive:true});
    const recipe=JSON.parse(await readFile(argv[0],'utf8'));
    await writeFile(path.join(artifactsDir,'recipe.json'),JSON.stringify(recipe));
    await writeFile(path.join(artifactsDir,'recipe-resolution.json'),JSON.stringify({schema_version:1,root:{ref:'task',digest:digestRecipeDocument(recipe)},dependencies:[],edges:[]}));
    await writeFile(path.join(artifactsDir,'artifact-manifest.json'),JSON.stringify({version:1,runStatus:'pass',artifacts:[]}));
    await writeFile(path.join(artifactsDir,'trace.json'),'[{"nodeId":"done","action":"end","ok":true}]');
    await writeFile(path.join(artifactsDir,'summary.json'),JSON.stringify({status:'pass',total:1,passed:1,failed:0,cause_counts:{subject:0,harness:0,environment:0,unknown:0}}));
    await writeFile(path.join(artifactsDir,'videos/recipe-run.mp4'),'unit moov media '+artifactsDir);
    await writeFile(path.join(artifactsDir,'evidence-manifest.json'),JSON.stringify({version:1,videos:{after:'videos/recipe-run.mp4',preferred:true}}));
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
  const firstManifest = await readFile(path.join(firstRoot, 'evidence-manifest.json'));
  invoke();
  const second = JSON.parse(
    await readFile(path.join(artifacts, 'latest-valid-recipe-run.json'), 'utf8'),
  );
  assert.notEqual(first.relativeArtifactRoot, second.relativeArtifactRoot);
  assert.deepEqual(await readFile(path.join(firstRoot, 'videos/recipe-run.mp4')), firstVideo);
  assert.deepEqual(await readFile(path.join(firstRoot, 'summary.json')), firstSummary);
  assert.deepEqual(await readFile(path.join(firstRoot, 'evidence-manifest.json')), firstManifest);
  assert.equal(await readFile(path.join(artifacts, 'after.mp4'), 'utf8'), 'old retained media');
  assert.equal(await readFile(recipe, 'utf8'), document);
  const manifest = JSON.parse(
    await readFile(
      path.join(artifacts, second.relativeArtifactRoot, 'evidence-manifest.json'),
      'utf8',
    ),
  );
  execFileSync(
    process.execPath,
    [path.join(root, 'packages/agent-runtime/scripts/check-task-artifact-contract.mjs'), task],
    { encoding: 'utf8', timeout: 5_000 },
  );
  assert.equal(manifest.videos.preferred, true);
  assert.equal(manifest.videos.after, 'videos/recipe-run.mp4');
});

// Codex r3 on #2337 found both of these against the first version of the
// declaration check, which read the library's `actions` map *or* the
// `manifests/` convention and parsed every JSON file it found there.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { digestRecipeLibrary, readRecipeLibraryManifest } from '@farmslot/recipe-runner';

import { taskActionInputsAvailable } from './task-action-inputs.js';

const manifestDocument = (actions: readonly string[]) => ({
  $schema: 'https://farmslot.io/schemas/action-manifest-v1.schema.json',
  actions: Object.fromEntries(
    actions.map((action) => [
      action,
      {
        description: `Run ${action}.`,
        examples: [{ action, intent: `Run ${action}.`, next: 'done' }],
        schema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ]),
  ),
});

/** A task directory holding one retained task-action library. */
async function library(
  t: test.TestContext,
  files: Readonly<Record<string, string>>,
): Promise<{ taskDir: string; digest: string }> {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'task-action-inputs-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  await mkdir(path.join(taskDir, 'artifacts/task-actions/actions'), { recursive: true });
  for (const [file, bytes] of Object.entries(files)) {
    const target = path.join(taskDir, 'artifacts/task-actions', file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const root = path.join(taskDir, 'artifacts/task-actions');
  return {
    taskDir,
    digest: await digestRecipeLibrary(root, await readRecipeLibraryManifest(root)),
  };
}

// A library may both map a platform-scoped manifest and keep the shared
// convention file. Reading only the mapped file refused a shared action whose
// digest matched — a valid proof rejected.
test('an actions map does not hide the manifests the convention declares', async (t) => {
  const { taskDir, digest } = await library(t, {
    'recipe-library.json': JSON.stringify({ actions: { web: 'manifests/current-web.json' } }),
    'manifests/current-web.json': JSON.stringify(manifestDocument(['task.web_probe'])),
    'manifests/shared.action-manifest.json': JSON.stringify(manifestDocument(['task.read_text'])),
    'actions/shared/read_text/read_text.mjs': 'export default () => "fixture";\n',
  });

  assert.equal(
    await taskActionInputsAvailable(taskDir, [
      { actionNames: ['task.read_text', 'task.web_probe'], expectedLibraryDigest: digest },
    ]),
    true,
  );
});

// The digest skips dotfiles, so a half-written scratch manifest changes nothing
// about the library. Parsing it anyway turned an unfinished local edit into a
// publication-blocking parse error.
test('a dotfile left in manifests does not block publication', async (t) => {
  const { taskDir, digest } = await library(t, {
    'manifests/task.action-manifest.json': JSON.stringify(manifestDocument(['task.read_text'])),
    'manifests/.scratch.json': '{ "actions": {',
    'actions/shared/read_text/read_text.mjs': 'export default () => "fixture";\n',
  });

  assert.equal(
    await taskActionInputsAvailable(taskDir, [
      { actionNames: ['task.read_text'], expectedLibraryDigest: digest },
    ]),
    true,
  );
});

// The check itself, so the two cases above cannot pass by not checking at all.
test('an action no manifest declares is still refused', async (t) => {
  const { taskDir, digest } = await library(t, {
    'manifests/task.action-manifest.json': JSON.stringify(manifestDocument(['task.read_text'])),
    'actions/shared/read_text/read_text.mjs': 'export default () => "fixture";\n',
  });

  await assert.rejects(
    taskActionInputsAvailable(taskDir, [
      { actionNames: ['task.read_text', 'task.dropped'], expectedLibraryDigest: digest },
    ]),
    /task\.dropped/,
  );
});

// Codex r4 and Grok r4 on #2337, same finding: unioning both sources read a
// manifest the library has already superseded. Discovery keeps one file per
// scope, so a replaced `web.action-manifest.json` declares nothing — and an
// action whose implementation was deleted with it must not pass on the strength
// of that leftover file.
test('a manifest the actions map replaced no longer declares its actions', async (t) => {
  const { taskDir, digest } = await library(t, {
    'recipe-library.json': JSON.stringify({ actions: { web: 'manifests/current-web.json' } }),
    'manifests/current-web.json': JSON.stringify(manifestDocument(['task.web_probe'])),
    // Superseded by the map entry above: same scope, older file.
    'manifests/web.action-manifest.json': JSON.stringify(manifestDocument(['task.read_text'])),
    'actions/shared/web_probe/web_probe.mjs': 'export default () => "fixture";\n',
  });

  await assert.rejects(
    taskActionInputsAvailable(taskDir, [
      { actionNames: ['task.read_text'], expectedLibraryDigest: digest },
    ]),
    /task\.read_text/,
  );
  assert.equal(
    await taskActionInputsAvailable(taskDir, [
      { actionNames: ['task.web_probe'], expectedLibraryDigest: digest },
    ]),
    true,
    'the mapped manifest is the live one for its scope',
  );
});

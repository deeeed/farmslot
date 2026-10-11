import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { SlotVars } from '../core/config.js';

await import('../runtime/mock-pty.test-support.js');

let repo = '';
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async (): Promise<SlotVars> => ({
      slotId: 'recipe-env',
      machine: 'fixture-node',
      host: 'localhost',
      repo,
      remoteRepo: repo,
      platform: 'web',
      sshUser: 'fixture',
      osType: 'linux',
      claudePath: '',
      codexPath: '',
      opencodePath: '',
      cursorPath: '',
      grokPath: '',
      dispatchCmd: '',
      recycleCmd: '',
      session: 'fixture',
      slotMode: 'dispatch',
      slotEnabled: true,
      sshTarget: '',
      projectName: 'fixture-project',
      resourceVars: {},
      machineEnv: { AUDIOLAB_NODE_BIN: path.join(repo, 'configured node') },
    }),
    loadProjectVars: async () => ({
      projectName: 'fixture-project',
      runtimeDir: '.agent',
      artifactDir: '.agent/artifacts',
      projectJson: {
        hooks: {
          recipe_doctor:
            'cd "{{repo}}" && test -x "$AUDIOLAB_NODE_BIN/node" && printf \'{"runner_protocol_version":1,"status":"pass","checks":[{"id":"configured-node","status":"pass"}]}\'',
        },
      },
    }),
  },
});
const { recipeProjectHookRun } = await import('./recipe.js');
test('recipe project hooks execute with configured pool tools before output validation', async (t) => {
  repo = await mkdtemp(path.join(tmpdir(), 'recipe pool env '));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const bin = path.join(repo, 'configured node');
  await mkdir(bin);
  await writeFile(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(bin, 'node'), 0o755);
  const result = await recipeProjectHookRun({
    slotId: 'recipe-env',
    project: 'fixture-project',
    hook: 'recipe_doctor',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.validation.status, 'pass');
  assert.equal(JSON.parse(result.stdout).checks[0].id, 'configured-node');
});

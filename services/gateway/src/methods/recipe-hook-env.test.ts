import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import type { SlotVars } from '../core/config.js';

await import('../runtime/mock-pty.test-support.js');

let repo = '';
let declared = false;
let cli = '';
let recipeRunHook: string | undefined;
let taskProof = false;
let row: Record<string, unknown> | null = { current_run_id: null, slot_epoch: 1 };
let throwAtExec: (() => never) | undefined;
let resetTracking: (slotId: string) => void;
const state = await import('../core/state.js');
mock.module('../core/state.js', {
  namedExports: {
    ...state,
    onSlotReset: (listener: typeof resetTracking) => {
      resetTracking = listener;
    },
    readSlotRow: async () => (row ? { ...row } : null),
    claimSlotStatusIf: async (
      slotId: string,
      predicate: (value: Record<string, unknown>) => boolean,
      fields: Record<string, unknown>,
    ) => {
      const candidate = row ?? { slot: slotId, slot_epoch: 0 };
      if (!predicate(candidate)) return { claimed: false, epoch: null };
      row = { ...candidate, ...fields, slot_epoch: Number(candidate.slot_epoch) + 1 };
      return { claimed: true, epoch: row.slot_epoch };
    },
    updateSlotStatusIf: async (
      _slotId: string,
      predicate: (value: Record<string, unknown>) => boolean,
      fields: Record<string, unknown>,
    ) => {
      if (!row || !predicate(row)) return false;
      Object.assign(row, fields);
      return true;
    },
  },
});
const execution = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...execution,
    execOnSlot: async (...args: Parameters<typeof execution.execOnSlot>) => {
      if (throwAtExec) throwAtExec();
      return execution.execOnSlot(...args);
    },
  },
});
const { NodeExecUnconfirmedError } = await import('../fleet/node-rpc.js');
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
      machineEnv: {
        AUDIOLAB_NODE_BIN: path.join(repo, 'configured node'),
        ...(cli ? { FARMSLOT_CLI: cli } : {}),
      },
    }),
    loadProjectVars: async () => ({
      projectName: 'fixture-project',
      projectConfig: path.join(repo, 'projects', 'fixture-project', 'project.json'),
      runtimeDir: '.agent',
      artifactDir: '.agent/artifacts',
      projectJson: {
        ...(taskProof
          ? { paths: { runtime_dir: '.agent', artifact_dir: '.agent/artifacts' } }
          : {}),
        ...(declared ? { recipe: { provider: { module: './provider.mjs' } } } : {}),
        hooks: {
          ...(recipeRunHook ? { recipe_run: recipeRunHook } : {}),
          recipe_doctor:
            'cd "{{repo}}" && test -x "$AUDIOLAB_NODE_BIN/node" && printf \'{"runner_protocol_version":1,"status":"pass","checks":[{"id":"configured-node","status":"pass"}]}\'',
        },
      },
    }),
  },
});
const { recipeProjectHookRun, recipeProjectHookCommand, recipeCommand, recipeCancel } =
  await import('./recipe.js');
const { farmslotRoot } = await import('../fleet/state.js');
const { shellQuote } = await import('../core/tmux.js');
const execFileAsync = promisify(execFile);

for (const hosted of [false, true]) {
  test(`${hosted ? 'hosted' : 'legacy'} task rerun binds its own worker task`, async (t) => {
    repo = await mkdtemp(path.join(tmpdir(), 'recipe task proof env '));
    declared = hosted;
    taskProof = true;
    cli = path.join(repo, 'cli');
    recipeRunHook =
      'cd "{{repo}}" && "$FARMSLOT_CLI" run {{recipe_path}} --target "{{repo}}" --artifacts-dir {{artifacts_dir}}';
    const { createRun, updateRun } = await import('../runs/store.js');
    const { deleteTestRunIfPresent } = await import('../run-engine/test-fixtures.js');
    const author = createRun({
      flowType: 'dev',
      mode: 'autonomous',
      project: 'fixture-project',
      ticketOrPr: 'recipe-task-binding',
      runner: 'scripted',
    });
    t.after(async () => {
      declared = false;
      taskProof = false;
      cli = '';
      recipeRunHook = undefined;
      await deleteTestRunIfPresent(author.id);
      await rm(repo, { recursive: true, force: true });
    });
    const raw = { paths: { runtime_dir: '.agent', artifact_dir: '.agent/artifacts' } };
    const taskFile = path.join(
      config.getOrchestratorTaskRoot('fixture-project', raw),
      'proof',
      'TASK.md',
    );
    updateRun(author.id, { taskFile, slotId: 'recipe-env' });
    const task = path.join(repo, config.resolveProjectTaskDirName(raw), 'proof');
    await mkdir(path.join(task, 'inputs'), { recursive: true });
    await mkdir(path.join(task, 'artifacts'), { recursive: true });
    await mkdir(path.join(repo, 'temp/tasks'), { recursive: true });
    await writeFile(
      path.join(task, 'inputs/handoff.json'),
      JSON.stringify({ task: { acceptanceCriteria: ['The task rerun is bound.'] } }),
    );
    const recipe = path.join(task, 'artifacts/recipe.json');
    await writeFile(recipe, '{}');
    const probe = path.join(repo, 'probe.mjs');
    const allocator = pathToFileURL(
      path.join(farmslotRoot(), 'packages/recipe-cli/src/harness/commands/run.ts'),
    ).href;
    await writeFile(
      probe,
      `import assert from 'node:assert/strict';
import {resolveRecipeExecutionArtifacts} from ${JSON.stringify(allocator)};
const args=process.argv.slice(2),target=args[args.indexOf('--target')+1],explicit=args[args.indexOf('--artifacts-dir')+1];
const value=resolveRecipeExecutionArtifacts(target,explicit,{fresh:'runs/task-proof'});
assert.equal(value.taskDir,${JSON.stringify(task)});assert.deepEqual(value.claims,[{id:'AC-1',claim:'The task rerun is bound.'}]);assert.notEqual(process.env.FARMSLOT_RECIPE_UNBOUND,'1');
console.log(JSON.stringify({taskDir:value.taskDir}));\n`,
    );
    await writeFile(
      cli,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} --import ${shellQuote(import.meta.resolve('tsx'))} ${shellQuote(probe)} "$@"\n`,
    );
    await chmod(cli, 0o755);
    const built = await recipeCommand({
      runId: author.id,
      slotId: 'recipe-env',
      recipeArtifactPath: 'artifacts/recipe.json',
    });
    const result = await execFileAsync('bash', ['--noprofile', '--norc', '-c', built.command], {
      cwd: repo,
      env: {
        ...process.env,
        RECIPE_TASK_DIR: undefined,
        FARMSLOT_TASK_DIR: undefined,
        FARMSLOT_RECIPE_UNBOUND: '1',
      },
    });
    assert.deepEqual(JSON.parse(result.stdout), { taskDir: task });
  });
}

for (const hosted of [false, true]) {
  for (const inheritedTask of [false, true]) {
    test(`${hosted ? 'hosted' : 'legacy'} project-hook recipe is diagnostic with ${inheritedTask ? 'inherited bindings' : 'retained task storage'}`, async (t) => {
      repo = await mkdtemp(path.join(tmpdir(), 'recipe diagnostic env '));
      declared = hosted;
      cli = path.join(repo, 'cli');
      recipeRunHook =
        'cd "{{repo}}" && "$FARMSLOT_CLI" run {{recipe_path}} --target "{{repo}}" --artifacts-dir {{artifacts_dir}}';
      t.after(async () => {
        declared = false;
        cli = '';
        recipeRunHook = undefined;
        await rm(repo, { recursive: true, force: true });
      });
      const task = path.join(repo, 'temp/tasks/author');
      await mkdir(path.join(task, 'inputs'), { recursive: true });
      await writeFile(
        path.join(task, 'inputs/handoff.json'),
        JSON.stringify({ task: { acceptanceCriteria: ['Author acceptance stays unchanged.'] } }),
      );
      const ledger = path.join(task, 'acceptance-status.json');
      await writeFile(ledger, '{"author":"unchanged"}');
      const probe = path.join(repo, 'probe.mjs');
      const allocator = pathToFileURL(
        path.join(farmslotRoot(), 'packages/recipe-cli/src/harness/commands/run.ts'),
      ).href;
      await writeFile(
        probe,
        `import assert from 'node:assert/strict';
import {resolveRecipeExecutionArtifacts} from ${JSON.stringify(allocator)};
const args=process.argv.slice(2),target=args[args.indexOf('--target')+1],explicit=args[args.indexOf('--artifacts-dir')+1];
const value=resolveRecipeExecutionArtifacts(target,explicit,{fresh:'runs/project-hook'});
assert.equal(value.taskDir,null);assert.equal(value.claims,undefined);
console.log(JSON.stringify({taskDir:value.taskDir,diagnostic:process.env.FARMSLOT_RECIPE_UNBOUND}));\n`,
      );
      await writeFile(
        cli,
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} --import ${shellQuote(import.meta.resolve('tsx'))} ${shellQuote(probe)} "$@"\n`,
      );
      await chmod(cli, 0o755);
      const built = await recipeProjectHookCommand({
        slotId: 'recipe-env',
        project: 'fixture-project',
        hook: 'recipe_run',
        recipePath: path.join(repo, 'recipe.json'),
        artifactsDir: path.join(repo, 'diagnostics'),
      });
      const result = await execFileAsync(
        'bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          `set -e\n${built.command}\nprintf 'PARENT=%s|%s' "\${RECIPE_TASK_DIR-}" "\${FARMSLOT_TASK_DIR-}"`,
        ],
        {
          cwd: repo,
          env: {
            ...process.env,
            FARMSLOT_CLI: cli,
            RECIPE_TASK_DIR: inheritedTask ? task : undefined,
            FARMSLOT_TASK_DIR: inheritedTask ? task : undefined,
            FARMSLOT_RECIPE_UNBOUND: undefined,
          },
        },
      );
      const [output, parent] = result.stdout.trim().split('\n');
      assert.deepEqual(JSON.parse(output!), { taskDir: null, diagnostic: '1' });
      assert.equal(parent, `PARENT=${inheritedTask ? task : ''}|${inheritedTask ? task : ''}`);
      assert.equal(await readFile(ledger, 'utf8'), '{"author":"unchanged"}');
    });
  }
}
test('undeclared projects keep readiness hooks and configured pool tools before output validation', async (t) => {
  declared = false;
  t.after(() => {
    declared = false;
  });
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

const actionManifest = {
  $schema: 'https://farmslot.io/schemas/action-manifest-v1.schema.json',
  actions: {
    end: { description: 'Finish the recipe.', examples: [{ action: 'end', status: 'pass' }] },
  },
};

for (const mode of ['manifest', 'readiness', 'conformance'] as const) {
  const hook = mode === 'manifest' ? 'recipe_action_manifest' : 'recipe_doctor';
  test(`declared ${mode} uses the shared CLI with exact checkout, registry, slot and pool environment`, async (t) => {
    repo = await mkdtemp(path.join(tmpdir(), "recipe 'hosted' env "));
    declared = true;
    cli = path.join(repo, 'cli');
    t.after(async () => {
      declared = false;
      cli = '';
      await rm(repo, { recursive: true, force: true });
    });
    const argvFile = path.join(repo, 'argv.json');
    const parameterText = 'hello, world; $(exit 19) "quoted" and \'single\'';
    const conformance =
      mode === 'conformance'
        ? {
            recipes: ['smoke'],
            params: { expected: parameterText, items: ['one', 'two'] },
            reportName: 'dispatch-check.json',
          }
        : undefined;
    const document =
      mode === 'conformance'
        ? {
            data: {
              report: {
                schemaVersion: 1,
                status: 'pass',
                mode: 'static',
                identity: { project: 'fixture-project', selection: { poolSlot: 'recipe-env' } },
                checks: [
                  {
                    id: 'recipe.smoke',
                    status: 'pass',
                    required: true,
                    evidence: {
                      plan: {
                        schemaVersion: 1,
                        digest: 'plan',
                        executionContextDigest: 'context',
                        source: { kind: 'library', trust: 'trusted' },
                        nodes: [],
                      },
                    },
                  },
                ],
              },
            },
          }
        : hook === 'recipe_doctor'
          ? {
              runner_protocol_version: 1,
              status: 'pass',
              checks: [{ id: 'configured-node', status: 'pass' }],
            }
          : actionManifest;
    await writeFile(
      cli,
      `#!${process.execPath}
require('node:assert/strict').equal(process.env.AUDIOLAB_NODE_BIN, ${JSON.stringify(path.join(repo, 'configured node'))});
require('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2))); process.stdout.write(${JSON.stringify(JSON.stringify(document))});
`,
    );
    await chmod(cli, 0o755);
    const result = await recipeProjectHookRun(
      {
        slotId: 'recipe-env',
        project: 'fixture-project',
        hook,
      },
      conformance,
    );
    assert.equal(Boolean(result.conformance), mode === 'conformance');
    assert.equal(result.validation.status, 'pass');
    assert.deepEqual(JSON.parse(await readFile(argvFile, 'utf8')), [
      ...(hook === 'recipe_doctor' ? ['doctor'] : ['recipe', 'actions']),
      '--target',
      repo,
      ...(conformance
        ? [
            '--conformance',
            '--recipe',
            'smoke',
            '--param',
            `expected=${JSON.stringify(parameterText)}`,
            '--param',
            'items=["one","two"]',
            '--report-name',
            'dispatch-check.json',
          ]
        : []),
      ...(hook === 'recipe_doctor' ? [] : ['--raw']),
      '--project',
      'fixture-project',
      '--slot',
      'recipe-env',
      '--json',
      '--projects-dir',
      path.join(repo, 'projects'),
    ]);
    if ('data' in document && document.data) {
      document.data.report.identity.selection.poolSlot = 'another-slot';
      await writeFile(
        cli,
        `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(document))});\n`,
      );
      await assert.rejects(
        recipeProjectHookRun(
          {
            slotId: 'recipe-env',
            project: 'fixture-project',
            hook,
          },
          conformance,
        ),
        /selected project and slot/,
      );
    }
  });
}

for (const changedOwner of [false, true]) {
  test(`unconfirmed closeout retains tracking and ${changedOwner ? 'preserves a new owner' : 'persists a hold across tracking reset'}`, async (t) => {
    row = { current_run_id: null, slot_epoch: 1, lifecycle: 'ready' };
    throwAtExec = () => {
      if (changedOwner) row = { current_run_id: 'new-owner', slot_epoch: 2, lifecycle: 'busy' };
      throw new NodeExecUnconfirmedError('fixture-node', 'lost-request', 'disconnected');
    };
    t.after(() => {
      throwAtExec = undefined;
      resetTracking('recipe-env');
      row = { current_run_id: null, slot_epoch: 1 };
    });
    const params = {
      slotId: 'recipe-env',
      project: 'fixture-project',
      hook: 'recipe_doctor' as const,
    };
    await assert.rejects(recipeProjectHookRun(params), NodeExecUnconfirmedError);
    assert.equal(row.lifecycle, changedOwner ? 'busy' : 'held');
    if (changedOwner)
      assert.deepEqual(row, { current_run_id: 'new-owner', slot_epoch: 2, lifecycle: 'busy' });
    else assert.match(String(row.held_reason), /Recipe process closeout unconfirmed/);
    assert.deepEqual(await recipeCancel({ slotId: 'recipe-env', requestId: 'another-request' }), {
      cancelled: false,
    });
    await assert.rejects(recipeProjectHookRun(params), /already active|closeout unconfirmed/);
    resetTracking('recipe-env');
    if (!changedOwner) await assert.rejects(recipeProjectHookRun(params), /closeout unconfirmed/);
  });
}

test('a fresh slot retains unconfirmed closeout after its in-memory tracking is cleared', async (t) => {
  row = null;
  throwAtExec = () => {
    throw new NodeExecUnconfirmedError('fixture-node', 'first-request', 'disconnected');
  };
  t.after(() => {
    throwAtExec = undefined;
    resetTracking('recipe-env');
    row = { current_run_id: null, slot_epoch: 1 };
  });
  const params = {
    slotId: 'recipe-env',
    project: 'fixture-project',
    hook: 'recipe_doctor' as const,
  };
  await assert.rejects(recipeProjectHookRun(params), NodeExecUnconfirmedError);
  const stored = (() => row as Record<string, unknown> | null)();
  assert(stored);
  assert.equal(stored.slot_epoch, 1);
  assert.equal(stored.lifecycle, 'held');
  resetTracking('recipe-env');
  await assert.rejects(recipeProjectHookRun(params), /closeout unconfirmed/);
});

// Isolated public run.create -> node task.runtime -> installed CLI -> dispatch.
// FARMSLOT_CATALOG_PROOF_ROOT selects a causal baseline; EXPECT_REFUSAL closes its expected failure.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Run } from '../../../packages/protocol/src/index.js';
import { cleanupOnExit, poll, startReaper } from '../lib/isolated-stack.mjs';
import { startRemoteNodeStack, type RemoteNodeStack } from '../lib/remote-node-stack.mjs';

const controllerRoot = fileURLToPath(new URL('../../../', import.meta.url));
const root = path.resolve(process.env.FARMSLOT_CATALOG_PROOF_ROOT ?? controllerRoot);
const evidence = path.resolve(
  process.argv[2] ??
    path.join(controllerRoot, 'temp/external-template-catalog', String(Date.now())),
);
await mkdir(evidence, { recursive: true });
execFileSync('git', ['diff', '--quiet', 'HEAD'], { cwd: root });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
await writeFile(
  path.join(evidence, 'CREATE-ONCE.json'),
  JSON.stringify({ head, at: new Date().toISOString() }),
  { flag: 'wx' },
);
const save = (name: string, value: unknown) =>
  writeFile(path.join(evidence, name), JSON.stringify(value, null, 2) + '\n');
const inputs = await mkdtemp('/tmp/catalog-inputs-');
const gatewayCatalog = path.join(inputs, 'gateway');
const nodeCatalog = path.join(inputs, 'node');
const markdown =
  '---\nid: dev/core\nflow: dev\nplatforms: [cli]\n---\n# Gateway checklist\n- [ ] Inspect the configured source.\n';
const nodeMarkdown = markdown.replace('Gateway checklist', 'Independently updated node checklist');
for (const dir of [gatewayCatalog, nodeCatalog])
  await mkdir(path.join(dir, 'dev'), { recursive: true });
await writeFile(path.join(gatewayCatalog, 'dev/core.md'), markdown);
await writeFile(path.join(nodeCatalog, 'dev/core.md'), nodeMarkdown);
const expectedSha = createHash('sha256').update(markdown).digest('hex');
const project = 'external-catalog-proof',
  slot = project + '-1';
const reaper = startReaper();
reaper.path(inputs);
let stack: RemoteNodeStack | undefined;
let stop: (() => Promise<string[]>) | undefined;
let run: Run | undefined;
const result: Record<string, unknown> = { head, modelCommands: 0, expectedSha, status: 'FAIL' };
const cleanup = cleanupOnExit(async () => {
  const errors: string[] = [];
  if (stack && run) {
    try {
      await save(
        'CANCEL.json',
        await stack.connection().call('run.cancel', { runId: run.id }, { timeoutMs: 180000 }),
      );
      await save(
        'ARCHIVE.json',
        await stack.connection().call('run.archive', { runId: run.id }, { timeoutMs: 180000 }),
      );
    } catch (error) {
      errors.push('run closeout: ' + String(error));
    }
  }
  errors.push(...((await stop?.()) ?? []));
  await rm(inputs, { recursive: true, force: true });
  if (!errors.length) reaper.done();
  await save('RESULT.json', {
    ...result,
    cleanupErrors: errors,
    status: result.status === 'PASS' && !errors.length ? 'PASS' : 'FAIL',
  });
  if (result.status !== 'PASS' || errors.length) process.exitCode = 1;
});
try {
  stack = await startRemoteNodeStack({
    root,
    evidence,
    machine: 'catalog-proof-node',
    slots: [slot],
    gatewayEnv: { COOK_TEMPLATE_ROOT: gatewayCatalog },
    nodeEnv: { COOK_TEMPLATE_ROOT: nodeCatalog },
    cliSnapshots: path.resolve(
      process.env.FARMSLOT_CATALOG_PROOF_CLI_CACHE ?? path.join(evidence, 'cli-snapshots'),
    ),
    ...(process.env.FARMSLOT_CATALOG_PROOF_CLI_SNAPSHOT
      ? { cliSnapshot: process.env.FARMSLOT_CATALOG_PROOF_CLI_SNAPSHOT }
      : {}),
    nodeBin: path.dirname(process.execPath),
    ownerTag: 'external-template-catalog',
    reaper,
    onCleanup: (callback) => {
      stop = callback;
    },
    log: async (event, detail) => {
      await appendFile(
        path.join(evidence, 'trace.jsonl'),
        JSON.stringify({ event, ...detail }) + '\n',
      );
      console.log(event);
    },
    projects: (holds) => {
      const fixture = path.dirname(holds);
      mkdirSync(path.join(fixture, 'scripts/lib'), { recursive: true });
      copyFileSync(
        path.join(root, 'scripts/lib/resolve-farmslot-cli.sh'),
        path.join(fixture, 'scripts/lib/resolve-farmslot-cli.sh'),
      );
      return [
        {
          name: project,
          projectJson: {
            default_branch: 'main',
            default_safety_tier: 'dangerous',
            paths: { runtime_dir: '.agent', artifact_dir: '.task' },
            review: { enabled: false },
            node_support: {
              paths: ['scripts/lib/resolve-farmslot-cli.sh', `projects/${project}/project.json`],
            },
            execution_templates: {
              sources: [
                { id: 'package:cook', kind: 'package', root: { env: 'COOK_TEMPLATE_ROOT' } },
              ],
              defaults: [{ when: { flow: 'dev' }, templateId: 'dev/core' }],
            },
            qa: {
              default_profile: 'smoke',
              profiles: [{ id: 'smoke', title: 'Smoke', template_id: 'qa/default' }],
            },
            scripted: {
              commands: {
                wait: { command: "node -e 'setInterval(() => {}, 1000)'", timeout_ms: 120000 },
              },
            },
            prepare: {
              default: 'fixture',
              compatibility_profile: 'fixture',
              profiles: { fixture: { label: 'Owned Git prepare', phases: ['git'] } },
            },
          },
          files: {
            'templates/worker/dev.md': '# Dev\n- [ ] Observe\n',
            'templates/prompts/worker-dispatch.md': 'Read {{TASK_FILE}}.\n',
          },
        },
      ];
    },
    seeds: {
      [project]: {
        'README.md': 'Private catalog dispatch proof.\n',
        '.gitignore': '.agent/\n.task/\ntasks/\ntemp/\n',
      },
    },
  });
  result.fixture = stack.fixture;
  run = (
    await stack.call<{ run: Run }>('run.create', {
      project,
      slotId: slot,
      flowType: 'dev',
      mode: 'autonomous',
      lane: 'validation',
      ticketOrPr: 'FIXTURE-1',
      runner: 'scripted',
      model: 'scripted',
      transport: 'tmux',
      scripted: { mode: 'command', commandRef: 'wait' },
      completionPolicy: 'artifact-only',
      safetyTier: 'dangerous',
      ticketData: {
        source: 'manual',
        title: 'Owned catalog dispatch proof',
        description: 'Dispatch only.',
        affectedArea: '',
        acceptanceCriteria: ['Hosted initialization uses the shipped catalog'],
        stepsToReproduce: [],
        screenshots: [],
        labels: [],
      },
    })
  ).run;
  result.runId = run.id;
  await save('CREATED.json', run);
  run = await poll(
    'dispatch uses gateway catalog despite node drift',
    async () => {
      const value = (await stack!.call<{ run: Run }>('run.get', { runId: run!.id })).run;
      await save('PROGRESS.json', value);
      if (['blocked', 'failed', 'cancelled'].includes(value.status))
        throw new Error(value.error ?? value.status);
      return value.steps.find((step) => step.name === 'dispatch')?.status === 'done'
        ? value
        : undefined;
    },
    600000,
  );
  for (const name of ['write-task', 'prepare', 'dispatch'])
    assert.equal(run.steps.find((step) => step.name === name)?.status, 'done');
  assert.equal(run.executionTemplate?.sha256, expectedSha);
  assert(run.taskFile);
  const taskDir = path.dirname(path.resolve(stack.slotRepo(slot), run.taskFile));
  const handoff = JSON.parse(await readFile(path.join(taskDir, 'inputs/handoff.json'), 'utf8'));
  assert.equal(handoff.executionTemplate.sha256, expectedSha);
  assert.equal(await readFile(path.join(nodeCatalog, 'dev/core.md'), 'utf8'), nodeMarkdown);
  await stat(path.join(taskDir, 'artifacts/harness-provenance.json'));
  await save('GREEN.json', { run, handoff, nodeCatalogUnchanged: true });
  result.status = 'PASS';
} catch (error) {
  result.error = error instanceof Error ? error.stack : String(error);
  await save('ERROR.json', result);
  if (process.env.FARMSLOT_CATALOG_EXPECT_REFUSAL !== '1') {
    console.log('Failure retained for same-run diagnosis; write CLOSE.json to close this fixture.');
    const deadline = Date.now() + 900000;
    while (Date.now() < deadline) {
      try {
        await stat(path.join(evidence, 'CLOSE.json'));
        break;
      } catch (missing) {
        if (!(missing instanceof Error && 'code' in missing && missing.code === 'ENOENT'))
          throw missing;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
} finally {
  await cleanup();
}

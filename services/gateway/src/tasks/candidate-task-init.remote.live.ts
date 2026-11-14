// Opt-in remote regression. Requires FARMSLOT_CANDIDATE_REMOTE_HOST and a managed CLI there.
// Uses an owned temporary CLI copy, pool, checkout and pin store. Starts no farm run or service.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  candidateExecutionTemplate,
  projectWorkerTemplateSource,
  selectExecutionTemplate,
} from '@farmslot/agent-runtime';

import { hostedTaskRequest } from './hosted-task-init.js';

const remoteHost = process.env.FARMSLOT_CANDIDATE_REMOTE_HOST;
assert(remoteHost, 'Set FARMSLOT_CANDIDATE_REMOTE_HOST to a different execution node.');

function remote<Value>(program: string, payload: unknown): Value {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const script = `const payload = JSON.parse(Buffer.from('${encoded}', 'base64').toString());\n${program}`;
  return JSON.parse(
    execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', remoteHost!, 'node -'], {
      input: script,
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
}

const prepare = String.raw`
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-init-remote-')));
try {
  const baseCli = fs.realpathSync(path.join(os.homedir(), '.local/bin/farmslot'));
  const base = path.resolve(path.dirname(baseCli), '../../..');
  const installation = path.join(root, 'installation');
  fs.cpSync(base, installation, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
  fs.writeFileSync(path.join(installation, 'packages/cli/src/commands/hosted-task-init.ts'), payload.initializer);
  const checkout = path.join(root, 'checkout'), pack = path.join(root, 'projects/fixture');
  for (const dir of [checkout, path.join(root, 'pool'), path.join(pack, 'templates/worker')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(pack, 'package.json'), JSON.stringify({ type: 'module', files: ['provider.mjs', 'project.json', 'templates'] }));
  fs.writeFileSync(path.join(pack, 'project.json'), JSON.stringify({
    name: 'fixture', task_dir: 'tasks', execution_templates: { sources: [] },
    paths: { runtime_dir: '.runtime', artifact_dir: 'artifacts' },
    ...(payload.binding === 'project' ? { recipe: { adapter: 'headless', provider: { module: 'provider.mjs' } } } : {}),
  }));
  fs.writeFileSync(path.join(pack, 'provider.mjs'), payload.provider);
  fs.writeFileSync(path.join(pack, 'templates/worker/fix-bug.md'), payload.normalMarkdown);
  fs.writeFileSync(path.join(root, 'pool/local.json'), JSON.stringify({ machine: 'local', host: 'localhost', project: 'fixture', platform: 'cli', slots: [{ id: 'fixture-1', repo: checkout }] }));
  process.stdout.write(JSON.stringify({ root, checkout, installation, hostname: os.hostname(), baseCli }));
} catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
`;

const initialize = String.raw`
const fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
(async () => {
  const { root, installation } = payload.fixture;
  const cli = path.join(installation, 'packages/cli');
  const fromCli = createRequire(path.join(cli, 'package.json'));
  fromCli('tsx/cjs');
  const { register } = await import(pathToFileURL(fromCli.resolve('tsx/esm/api')).href);
  register({ tsconfig: path.join(cli, 'tsconfig.json') });
  const { runTaskRuntime } = await import(pathToFileURL(path.join(installation, 'packages/slot-config/src/task-runtime.ts')).href);
  const env = { ...process.env, FARMSLOT_HOME: path.join(root, 'home'), FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs'), FARMSLOT_POOL_DIR: path.join(root, 'pool'), FARMSLOT_PROJECTS_DIR: path.join(root, 'projects') };
  delete env.FARMSLOT_ROOT;
  const stagingRoot = path.join(root, 'worker-tmp');
  fs.mkdirSync(stagingRoot);
  env.TMPDIR = stagingRoot;
  const request = JSON.parse(payload.request);
  const task = request.task.taskDir;
  fs.mkdirSync(task, { recursive: true });
  const wire = path.join(task, '.task-init-00000000-0000-4000-8000-000000000000.json');
  fs.writeFileSync(wire, payload.request);
  const input = { action: 'init', taskPath: wire, supportDir: root, env: {} };
  const stagingBefore = new Set(fs.readdirSync(stagingRoot).filter(name => name.startsWith('farmslot-candidate-template-')));
  const initialized = await runTaskRuntime(input, root, env);
  const stagingLeaks = fs.readdirSync(stagingRoot).filter(name => name.startsWith('farmslot-candidate-template-') && !stagingBefore.has(name));
  if (initialized.exitCode !== 0) { process.stdout.write(JSON.stringify({ initialized, stagingLeaks, transportRemoved: !fs.existsSync(wire) })); return; }
  const data = JSON.parse(initialized.stdout).data;
  const receipt = data.executionProvenance;
  const candidateInput = receipt.retainedInputs.find(entry => path.basename(entry.source).startsWith('farmslot-candidate-template-'));
  const retained = candidateInput && fs.readFileSync(path.join(candidateInput.path, 'candidate-template.md'), 'utf8');
  const verified = await runTaskRuntime({ ...input, action: 'verify', taskPath: task }, root, env);
  process.stdout.write(JSON.stringify({ initialized, verified, template: data.executionTemplate, binding: receipt.bindingIdentity,
    retained, candidateInput, stagingRemoved: candidateInput && !fs.existsSync(candidateInput.source),
    checklist: fs.readFileSync(path.join(task, 'CHECKLIST.md'), 'utf8'), transportRemoved: !fs.existsSync(wire),
  }));
})().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; });
`;

const provider = `export function createProvider() {
  return { runtime: { id: 'headless', sdkVersion: 1, headless: true,
    runtimeStatus: async () => ({ decision: 'ready', reasons: [] }), resolveSlotPorts() {},
    logSources: () => [], appLogSource: () => null, devServer: {}, hints: {}, runtimeContext: {},
    harness: { verify: async () => ({ ok: true }) },
    launch: async () => { throw new Error('Unexpected runtime launch'); },
    actions: { manifestPath: () => '', semantic: [], cdpTarget: { transport: 'none' } },
  }, commandOptions: { task: { stepGates: [] } } };
}`;

interface RemoteFixture {
  root: string;
  checkout: string;
  installation: string;
  hostname: string;
  baseCli: string;
}
interface RemoteResult {
  initialized: { exitCode: number; stdout: string; stderr: string };
  verified?: { exitCode: number; stdout: string; stderr: string };
  template?: { sha256: string; sourceId: string; renderedSha256: string };
  binding?: { project: string; adapter: string } | null;
  retained?: string;
  stagingRemoved?: boolean;
  stagingLeaks?: string[];
  transportRemoved?: boolean;
  checklist?: string;
}

for (const [binding, failProducer, useCandidate] of [
  ['project', false, true],
  ['static', false, true],
  ['project', true, true],
  ['project', false, false],
  ['static', false, false],
] as const) {
  test(
    `remote ${binding} task-init ${failProducer ? 'cleans staging after provider refusal' : useCandidate ? 'pins candidate bytes after the gateway source is deleted' : 'keeps normal catalog initialization unchanged'}`,
    { timeout: 600_000 },
    async (t) => {
      const gateway = await mkdtemp(path.join(os.tmpdir(), 'candidate-init-gateway-'));
      t.after(() => rm(gateway, { recursive: true, force: true }));
      const initializer = await readFile(
        new URL('../../../../packages/cli/src/commands/hosted-task-init.ts', import.meta.url),
        'utf8',
      );
      const normalMarkdown = '# Normal default\n\n- [ ] Observe the fixture.\n';
      const fixture = remote<RemoteFixture>(prepare, {
        initializer,
        provider: failProducer
          ? provider.replace('stepGates: []', 'stepGates: undefined')
          : provider,
        binding,
        normalMarkdown,
      });
      t.after(() =>
        remote(
          'require("node:fs").rmSync(payload.root, { recursive: true, force: true }); process.stdout.write("null");',
          { root: fixture.root },
        ),
      );
      assert.notEqual(
        fixture.hostname,
        os.hostname(),
        'This proof must use a genuinely remote node.',
      );
      const source = useCandidate
        ? path.join(gateway, 'B1.md')
        : path.join(gateway, 'templates/worker/fix-bug.md');
      if (!useCandidate) await mkdir(path.dirname(source), { recursive: true });
      const markdown = useCandidate
        ? '# Candidate checklist\n\n- [ ] Read TASK.md.\n- [ ] Prove the fixture behavior.\n'
        : normalMarkdown;
      await writeFile(source, markdown);
      const selected = useCandidate
        ? candidateExecutionTemplate({
            path: source,
            relativePath: 'fix-bug/B1.md',
            markdown,
            flow: 'fix-bug',
          })
        : selectExecutionTemplate({
            sources: [projectWorkerTemplateSource('fixture', path.join(gateway, 'templates'))],
            flow: 'fix-bug',
            platform: 'cli',
          });
      const request = hostedTaskRequest('fixture-1', {
        binding,
        template: selected,
        ...(useCandidate ? { candidateTemplateMarkdown: markdown } : {}),
        task: {
          taskDir: path.posix.join(fixture.checkout, 'tasks/fix/candidate'),
          flow: 'fix-bug',
          platform: 'cli',
          runMode: 'autonomous',
          task: {
            title: 'Candidate remote proof',
            sourceKind: 'text',
            acceptanceCriteria: ['Retain the candidate bytes.'],
          },
          handoff: { surface: 'farmslot', project: 'fixture', attemptId: 'candidate-remote-proof' },
          ...(useCandidate ? { artifactOnlyReplay: { base: 'a'.repeat(40) } } : {}),
        },
      });
      assert(
        !request.includes(gateway),
        'The node request must not depend on a gateway-local source path.',
      );
      await unlink(source);
      const result = remote<RemoteResult>(initialize, { fixture, request });
      if (failProducer) {
        assert.notEqual(result.initialized.exitCode, 0);
        assert.match(
          JSON.parse(result.initialized.stdout).error.message,
          /does not declare task gates/,
        );
        assert.deepEqual(result.stagingLeaks, []);
        assert.equal(result.transportRemoved, true);
        return;
      }
      assert.equal(
        result.initialized.exitCode,
        0,
        result.initialized.stdout + result.initialized.stderr,
      );
      assert.equal(
        result.verified?.exitCode,
        0,
        result.verified?.stdout + (result.verified?.stderr ?? ''),
      );
      assert.equal(result.template?.sourceId, useCandidate ? 'eval-candidate' : 'project:fixture');
      assert.equal(result.template?.sha256, selected.reference.sha256);
      assert.equal(
        result.template?.renderedSha256,
        createHash('sha256')
          .update(result.checklist ?? '')
          .digest('hex'),
      );
      if (useCandidate) {
        assert.equal(result.retained, markdown);
        assert.equal(result.stagingRemoved, true);
      } else assert.equal(result.retained, undefined);
      assert.equal(result.transportRemoved, true);
      if (binding === 'project') {
        assert.equal(result.binding?.project, 'fixture');
        assert.equal(result.binding?.adapter, 'headless');
      } else assert.equal(result.binding, null);
      t.diagnostic(
        JSON.stringify({
          remote: fixture.hostname,
          baseCli: fixture.baseCli,
          candidateHash: result.template?.sha256,
          initializerSha256: createHash('sha256').update(initializer).digest('hex'),
          pinVerified: true,
        }),
      );
    },
  );
}

#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { openSync, closeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, access, cp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  GatewayClient,
  GatewayConnectionError,
  GatewayRpcError,
  type GatewayConnection,
} from '../packages/cli/src/gateway-client.js';
import type {
  Run,
  FleetStatusResult,
  NativeSessionReadResult,
} from '../packages/protocol/src/index.js';
import { alive, matchesProcess } from '../packages/agent-runtime/src/native/storage.js';
import { getRunnerAdapter } from './runner-validation/runners/index.mjs';
import { prepareBrowserSlots } from './runner-validation/lib/browser-slots.mjs';
import {
  createRecipeRunner,
  createStandardCoreAdapters,
} from '../packages/recipe-harness/src/index.js';

// Uses the installed native reviewer and its existing account. Provider PR facts come
// from a read-only fixture; run creation, ownership and worker execution are real.
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv[2] === 'recipe') {
  const artifactsDir = path.resolve(
    root,
    process.argv[3] ?? `temp/workspace-review-recipe/${Date.now()}`,
  );
  const recipeDocument = JSON.parse(
    await readFile(
      path.join(root, 'docs/examples/recipes/farmslot/workspace-review-lifecycle.recipe.json'),
      'utf8',
    ),
  );
  for (const node of Object.values(recipeDocument.workflow.nodes) as Array<{ cmd?: string }>) {
    if (node.cmd)
      node.cmd = node.cmd.replace(
        /temp\/workspace-review-recipe\/([a-z-]+)/g,
        (_path, scenario) => {
          const target = path.join(artifactsDir, 'scenarios', scenario);
          return "'" + target.replaceAll("'", "'\\''") + "'";
        },
      );
  }
  const catalog = JSON.parse(
    await readFile(
      path.join(root, 'docs/examples/recipes/farmslot-v1.action-manifest.json'),
      'utf8',
    ),
  );
  const actions = ['command', 'end'];
  const runner = createRecipeRunner({
    actionManifest: {
      $schema: catalog.$schema,
      actions: Object.fromEntries(actions.map((name) => [name, catalog.actions[name]])),
    },
    adapters: createStandardCoreAdapters({ actions }),
    runner: {
      source: 'worktree',
      git_ref: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      name: 'Workspace review lifecycle validation',
    },
  });
  const result = await runner.run({
    recipeDocument,
    artifactsDir,
    projectRoot: root,
    source: { kind: 'operator', trust: 'trusted', name: 'Workspace review lifecycle validation' },
  });
  console.log(JSON.stringify(result));
  process.exit(result.status === 'pass' ? 0 : 1);
}
const evidence = path.resolve(
  root,
  process.argv[2] ?? `temp/workspace-review-lifecycle/${Date.now()}`,
);
const scenario = process.argv[3] ?? 'single';
assert(
  [
    'single',
    'tmux-fixture',
    'blocked',
    'concurrency',
    'runtime-concurrency',
    'cancel',
    'restart',
    'readonly',
    'repeat-review',
    'cancel-allocation',
    'restart-allocation',
    'restart-cleanup',
    'restart-launch',
    'cancel-launch',
    'cancel-cleanup',
  ].includes(scenario),
  'Unknown lifecycle scenario',
);
const writeProbe = 'printf probe > readonly-source-probe.txt';
const count = scenario.endsWith('concurrency') ? 3 : 1;
const multipleReviews = count > 1 || scenario === 'repeat-review';
await mkdir(evidence, { recursive: true });
const fixture = await mkdtemp(path.join(tmpdir(), 'workspace-review-live-'));
execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
const app = path.join(fixture, 'app');
await mkdir(app);
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: app, encoding: 'utf8', stdio: 'pipe' }).trim();
git('init');
await writeFile(path.join(app, 'message.txt'), 'hello\n');
git('add', 'message.txt');
if (scenario === 'repeat-review') {
  await writeFile(
    path.join(app, 'greeting.js'),
    'export function greeting() { return "hello"; }\n',
  );
  git('add', 'greeting.js');
}
git(
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.test',
  'commit',
  '-m',
  'test: seed fixture',
);
const baseSha = git('rev-parse', 'HEAD');
await writeFile(path.join(app, 'message.txt'), 'hello world\n');
git('add', 'message.txt');
if (scenario === 'repeat-review') {
  await writeFile(
    path.join(app, 'greeting.js'),
    'export function greeting() { return greetingText; }\n',
  );
  git('add', 'greeting.js');
}
git(
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.test',
  'commit',
  '-m',
  'test: change greeting',
);
const headSha = git('rev-parse', 'HEAD');
for (const name of ['scripts', 'services', 'packages', 'node_modules'])
  await symlink(path.join(root, name), path.join(fixture, name));
await writeFile(path.join(fixture, 'CLAUDE.md'), '# Isolated workspace validation\n');
const project = path.join(fixture, 'projects/review');
await mkdir(path.join(project, 'shared/review-pr'), { recursive: true });
await mkdir(path.join(project, 'shared/review-skill'), { recursive: true });
await writeFile(
  path.join(project, 'shared/review-skill/SKILL.md'),
  '---\nname: fixture-static-review\ndescription: Inspect the fixture diff without app execution.\n---\n\n# Fixture static review\n\nInspect the frozen diff and existing files. Do not install dependencies, build, run tests or use an app. Record findings in the task artifacts.\n',
);
await writeFile(
  path.join(project, 'shared/review-pr/shared.md'),
  '---\nplatforms: [cli]\nrunMode: autonomous\n---\n\n# Review greeting\n\n' +
    (scenario === 'readonly'
      ? `- [ ] Run the authorized fixture-only permission probe once in the checkout directory with exactly this shell command: \`${writeProbe}\`. Do not wrap it, request expanded permissions or retry. Record its actual exit outcome. If it succeeded, remove only the newly created readonly-source-probe.txt so the fixture checkout is restored. Continue the review either way; the validation driver checks the recorded outcome. This file is disposable test data.\n`
      : '') +
    (scenario === 'blocked'
      ? '- [ ] A required review input is unavailable in this fixture. After mark start, run the supplied task marker with blocked --reason "Fixture review input unavailable" and end the turn. Do not complete the review or invent missing input.\n'
      : '- [ ] Inspect the frozen diff and write the required static review artifacts. This small greeting-only change needs no build, runtime test or external lookup.\n'),
);
async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
}
await json(path.join(project, 'project.json'), {
  name: 'review',
  repo_url: app,
  ci: { repo: 'example/app' },
  default_branch: 'main',
  static_review: {
    template_id: 'review-pr/shared',
    support: {
      skills: [
        {
          name: 'fixture-static-review',
          root: { projectPath: 'shared/review-skill' },
          entry: 'SKILL.md',
        },
      ],
    },
  },
  execution_templates: {
    sources: [{ id: 'workspace:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
  },
  monitoring: { total_timeout_min: 5 },
});
const runtimeSlots =
  scenario === 'runtime-concurrency'
    ? await prepareBrowserSlots(root, fixture, evidence)
    : undefined;
await json(path.join(fixture, 'pool/review.json'), {
  machine: 'review-node',
  host: 'localhost',
  project: 'review',
  platform: 'cli',
  os: process.platform,
  slots:
    runtimeSlots?.slots ??
    (scenario === 'concurrency'
      ? [1, 2].map((index) => ({
          id: `busy-device-${index}`,
          enabled: true,
          repo: app,
          session: `fixture-device-${index}`,
          resources: {},
        }))
      : []),
  review_workspaces: { max_concurrent: 3 },
});
let occupiedSlots: string | undefined;
if (runtimeSlots)
  await json(path.join(fixture, '.farm-status.json'), {
    checked_at: new Date().toISOString(),
    slots: runtimeSlots.initialSlots,
  });
if (scenario === 'concurrency') {
  occupiedSlots = JSON.stringify({
    checked_at: new Date().toISOString(),
    slots: [1, 2].map((index) => ({
      slot: `busy-device-${index}`,
      machine: 'review-node',
      project: 'review',
      platform: 'cli',
      repo: app,
      lifecycle: 'busy',
      phase: 'working',
      agent: 'working',
      enabled: true,
      current_run_id: `fixture-runtime-${index}`,
    })),
  });
  await writeFile(path.join(fixture, '.farm-status.json'), occupiedSlots);
}
await mkdir(path.join(fixture, 'bin'));
if (scenario === 'tmux-fixture') {
  await writeFile(
    path.join(fixture, 'bin/cursor-agent'),
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const prompt=process.argv.at(-1),task=path.dirname(/Read '([^']+)'/.exec(prompt)[1]);
const mark=(...args)=>cp.execFileSync(path.join(task,'mark'),args,{cwd:task,stdio:'pipe'});
mark('start');
console.log('FIXTURE_READY');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 if(line==='workspace-proof')console.log('FIXTURE_CWD='+process.cwd());
 if(line!=='complete-fixture')return;
 const md=fs.readFileSync(path.join(task,'TASK.md'),'utf8'),subject=JSON.parse(fs.readFileSync(path.join(task,'inputs/review-subject.json'),'utf8')),signal=JSON.parse(fs.readFileSync(path.join(task,'SIGNAL.json'),'utf8'));
 const report='VERDICT: REQUEST_CHANGES\\nCOMMIT: '+subject.headSha+'\\nFixture inspected frozen inputs.\\n';
 for(const [name,content]of Object.entries({'review.md':report,'learnings.md':'Fixture proof','review-checklist.md':'- [x] Fixture reviewed','line-comments.json':JSON.stringify({comments:[{path:'message.txt',line:1,body:'Fixture inline finding',severity:'minor'}]}),'review-result.json':JSON.stringify({schemaVersion:1,verdict:'issues',issues:[{file:'message.txt',line:1,description:'Fixture inline finding',severity:'minor'}],runId:/Add runId "([^"]+)"/.exec(md)[1],workspaceId:path.basename(path.dirname(task)),headSha:subject.headSha,baseSha:subject.baseSha,attemptId:signal.attemptId,reportSha256:crypto.createHash('sha256').update(report).digest('hex')})}))fs.writeFileSync(path.join(task,'artifacts',name),content);
 mark('complete','--mark-last');console.log('FIXTURE_COMPLETE');
});
`,
    { mode: 0o700 },
  );
}

const launchBarrier = ['restart-launch', 'cancel-launch'].includes(scenario)
  ? getRunnerAdapter('codex').prepareLaunchBarrier(path.join(fixture, 'bin'))
  : undefined;
const gitBarrier = [
  'cancel-allocation',
  'restart-allocation',
  'restart-cleanup',
  'cancel-cleanup',
].includes(scenario)
  ? {
      marker: path.join(fixture, 'git-interruption.json'),
      release: path.join(fixture, 'git-release'),
    }
  : undefined;
if (gitBarrier) {
  const executable = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const operation = scenario.endsWith('cleanup') ? 'remove' : 'add';
  await writeFile(
    path.join(fixture, 'bin/git'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const marker = ${JSON.stringify(gitBarrier.marker)};
const release = ${JSON.stringify(gitBarrier.release)};
if (args.includes('worktree') && args.includes(${JSON.stringify(operation)}) && !fs.existsSync(marker) && !fs.existsSync(release)) {
  const helper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, helperPid: helper.pid, args }));
  const deadline = Date.now() + 360000;
  while (!fs.existsSync(release)) {
    if (Date.now() > deadline) throw new Error('Git interruption barrier timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}
const child = spawnSync(${JSON.stringify(executable)}, args, { stdio: 'inherit' });
if (child.error) throw child.error;
process.exit(child.status ?? 1);
`,
    { mode: 0o755 },
  );
}
const interruptionBarrier = gitBarrier ?? launchBarrier;
const prBody =
  scenario === 'repeat-review'
    ? 'Change the greeting function to return hello world. Inspect the changed greeting.js implementation as well as message.txt.'
    : 'Change hello to hello world. Review the text change only.';
await writeFile(
  path.join(fixture, 'bin/gh'),
  `#!/usr/bin/env node
const args=process.argv.slice(2);
const endpoint=args.find(value=>value.startsWith('repos/example/app/pulls/'));
if(args[0]==='api' && endpoint) {
 if(args.includes('--include')) process.stdout.write('HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n');
const data=${JSON.stringify({ number: 42, title: 'Greeting wording', body: prBody, html_url: 'https://github.com/example/app/pull/42', state: 'open', head: { sha: headSha, ref: 'greeting', repo: { full_name: 'example/app' } }, base: { sha: baseSha, ref: 'main' } })}; data.number=Number(endpoint.split('/').pop()); process.stdout.write(JSON.stringify(data)); process.exit(0);
}
if(args[0]==='pr' && args[1]==='view'){process.stdout.write(JSON.stringify({mergeable:'MERGEABLE',mergeStateStatus:'CLEAN'}));process.exit(0);}
process.stderr.write('Unsupported fixture provider request');process.exit(2);
`,
  { mode: 0o755 },
);
const portProbe = createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const port = (portProbe.address() as { port: number }).port;
await new Promise<void>((resolve, reject) =>
  portProbe.close((error) => (error ? reject(error) : resolve())),
);
const token = randomBytes(32).toString('hex');
const log = path.join(evidence, 'gateway.log');
function startGateway(recovery = false) {
  const fd = openSync(log, 'a', 0o600);
  const processHandle = spawn('yarn', ['workspace', '@farmslot/gateway', 'start'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: {
      ...process.env,
      PATH: `${path.join(fixture, 'bin')}${path.delimiter}${process.env.PATH}`,
      FARMSLOT_ROOT: fixture,
      FARMSLOT_HOME: path.join(fixture, 'home'),
      FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
      FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
      FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
      FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      FARMSLOT_GATEWAY_TOKEN: token,
      FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'legacy-env',
      FARMSLOT_NATIVE_STATE_DIR: path.join(fixture, 'home/native-sessions'),
      FARMSLOT_DISABLE_ORCHESTRATION: recovery ? '0' : '1',
      FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
    },
  });
  closeSync(fd);
  return processHandle;
}
let gateway = startGateway();
let connection: GatewayConnection | undefined;
let current: Run | undefined;
const runs: Run[] = [];
const discoveredSkills = new Set<string>();
let terminalProven = false;
let rejectedPublishProven = false;
let reviewUi:
  | { evaluate: (body: string) => any; cdp: (...args: string[]) => string; route: string }
  | undefined;
async function verifyReviewUi(stage: string, readOnly: boolean) {
  assert(reviewUi);
  let proof;
  for (let attempt = 0; attempt < 80; attempt++) {
    proof = reviewUi.evaluate(
      `const w=find('review-workspace');return {readOnly:w?.readOnly,phase:w?._recoveryPhase,error:w?._recoveryMessage,files:w?._diffFiles?.map(f=>f.path),diff:w?._fileDiff,report:w?.querySelector('.rw-md-section')?.textContent};`,
    );
    if (
      proof.readOnly === readOnly &&
      proof.phase === 'live' &&
      proof.diff?.includes('+hello world')
    )
      break;
    await delay(250);
  }
  await json(path.join(evidence, stage + '.json'), proof);
  assert.equal(proof.readOnly, readOnly);
  assert.equal(proof.phase, 'live', proof.error);
  assert(proof.files.includes('message.txt'));
  assert(proof.diff.includes('+hello world'));
  assert(proof.report.includes('Fixture inspected frozen inputs'));
  reviewUi.evaluate(`find('review-workspace').querySelector('.rw-ci').click();return true;`);
  let comment;
  for (let attempt = 0; attempt < 60; attempt++) {
    comment = reviewUi.evaluate(
      `const w=find('review-workspace');return {content:w?._commentFileContent,comments:w?._comments};`,
    );
    if (comment.content === 'hello world\n') break;
    await delay(100);
  }
  assert.equal(comment.content, 'hello world\n');
  assert.equal(comment.comments[0].body, 'Fixture inline finding');
  reviewUi.evaluate(
    `find('review-workspace').querySelector('step-artifacts').shadowRoot.querySelector('summary').click();return true;`,
  );
  reviewUi.evaluate(
    `find('review-workspace').querySelector('step-artifacts').shadowRoot.querySelector('.artifact-link').click();return true;`,
  );
  const artifact = reviewUi.evaluate(
    `const w=find('review-workspace');return {open:w.querySelector('media-lightbox').open,items:w.querySelector('media-lightbox').items};`,
  );
  assert(artifact.open);
  assert(artifact.items.length > 0);
  reviewUi.evaluate(
    `const box=find('review-workspace').querySelector('media-lightbox');Array.from(box.shadowRoot.querySelectorAll('button')).find(button=>button.textContent.trim()==='Close').click();return true;`,
  );

  reviewUi.evaluate(`find('review-workspace').scrollIntoView({block:'center'});return true;`);
  reviewUi.cdp('screenshot', reviewUi.route, path.join(evidence, stage + '.png'));
}
let terminalUi: ReturnType<typeof spawn> | undefined;
let failure: unknown;
let cleanupFailed = false;
let lifecycleInterrupted = false;
async function connectGateway() {
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    timeout: 30_000,
    credential: { token },
  });
  const readyBy = Date.now() + 30_000;
  for (;;) {
    if (gateway.exitCode !== null) throw new Error('Isolated gateway exited before readiness');
    try {
      return await client.connect();
    } catch (error) {
      if (!(error instanceof GatewayConnectionError) || Date.now() >= readyBy) throw error;
      await delay(200);
    }
  }
}
try {
  connection = await connectGateway();
  if (runtimeSlots) await runtimeSlots.start(connection);
  const parameters = {
    project: 'review',
    flowType: 'review-pr',
    reviewAutoFinish: scenario !== 'tmux-fixture',
    mode: 'autonomous',
    reviewWorkspaceTarget: { machine: 'review-node' },
    runner:
      scenario === 'tmux-fixture' ? 'cursor' : (process.env.FARMSLOT_REVIEW_TEST_RUNNER ?? 'codex'),
    model:
      scenario === 'tmux-fixture'
        ? 'cursor-grok-4.6-xhigh'
        : (process.env.FARMSLOT_REVIEW_TEST_MODEL ?? 'gpt-5.6-luna'),
    effort:
      scenario === 'tmux-fixture'
        ? undefined
        : (process.env.FARMSLOT_REVIEW_TEST_EFFORT ?? 'low') || undefined,
    transport: scenario === 'tmux-fixture' ? 'tmux' : 'native',
  };
  for (let index = 0; index < count; index++) {
    const created = await connection.call<{ run: Run }>('run.create', {
      ...parameters,
      ticketOrPr: `example/app#${42 + index}`,
    });
    runs.push(created.run);
  }
  if (count === 3) {
    await assert.rejects(
      connection.call('run.create', { ...parameters, ticketOrPr: 'example/app#45' }),
      (error: unknown) =>
        error instanceof GatewayRpcError && error.code === 'REVIEW_WORKSPACE_CAPACITY',
    );
  }
  const deadline = Date.now() + (scenario === 'repeat-review' ? 12 : 6) * 60_000;
  while (Date.now() < deadline) {
    for (let index = 0; index < runs.length; index++) {
      runs[index] = (await connection.call<{ run: Run }>('run.get', { runId: runs[index].id })).run;
      if (
        !discoveredSkills.has(runs[index].id) &&
        runs[index].reviewWorkspace?.support &&
        runs[index].agentContexts?.some(
          (context) => context.nativeSession?.launchRequestedAt || context.promptDeliveryStartedAt,
        ) &&
        !runs[index].reviewWorkspace?.cleanedAt
      ) {
        for (const surface of ['.agents', '.cursor', '.claude']) {
          const skill = path.join(
            runs[index].reviewWorkspace!.checkoutPath,
            surface,
            'skills/fixture-static-review/SKILL.md',
          );
          assert.match(await readFile(skill, 'utf8'), /Fixture static review/);
        }
        discoveredSkills.add(runs[index].id);
        await json(path.join(evidence, 'skill-discovery.json'), {
          verified: true,
          surfaces: ['.agents', '.cursor', '.claude'],
          workspace: runs[index].reviewWorkspace!.workspaceId,
        });
      }

      if (scenario === 'tmux-fixture' && runs[index].status === 'blocked' && terminalProven) {
        const decision = runs[index].decisions.find(
          (d) => d.type === 'engine_review_posting' && !d.resolvedAt,
        );
        if (decision) {
          await verifyReviewUi('review-gate-ui', false);
          const params = { slotId: '', runId: runs[index].id };
          await connection.call('terminal.subscribe', {
            ...params,
            interactive: true,
            cols: 100,
            rows: 30,
          });
          await connection.call('terminal.input', { ...params, data: 'workspace-proof\r' });
          await delay(300);
          const followup = await connection.call<{ lines: string[] }>('terminal.snapshot', params);
          assert(followup.lines.join('\n').includes('FIXTURE_CWD='));
          await json(path.join(evidence, 'gate-followup.json'), {
            status: runs[index].status,
            decision: decision.type,
            followup,
            worktree: runs[index].reviewWorkspace!.workspaceId,
          });
          if (!rejectedPublishProven) {
            // This isolated farm has no publishing account. A failed request must keep the gate and worker.
            await connection.call('run.resolveDecision', {
              runId: runs[index].id,
              decisionId: decision.id,
              actionId: 'post',
              selectionData: { recommendation: 'COMMENT', includedIndices: [] },
            });
            rejectedPublishProven = true;
            await connection.call('terminal.unsubscribe', params);
            continue;
          }
          assert.match(runs[index].error ?? '', /owned PR team/);
          await connection.call('run.resolveDecision', {
            runId: runs[index].id,
            decisionId: decision.id,
            actionId: 'dismiss',
          });
          await connection.call('terminal.unsubscribe', params);
        }
      }
      if (scenario === 'tmux-fixture' && runs[index].status === 'monitoring' && !terminalProven) {
        const params = { slotId: '', runId: runs[index].id };
        const uiProbe = createServer().listen(0, '127.0.0.1');
        await once(uiProbe, 'listening');
        const uiPort = (uiProbe.address() as { port: number }).port;
        await new Promise<void>((resolve, reject) =>
          uiProbe.close((error) => (error ? reject(error) : resolve())),
        );
        const uiLog = openSync(path.join(evidence, 'ui.log'), 'w', 0o600);
        terminalUi = spawn(
          'yarn',
          [
            'workspace',
            '@farmslot/command-center-ui',
            'dev',
            '--host',
            '127.0.0.1',
            '--port',
            String(uiPort),
            '--strictPort',
          ],
          {
            cwd: root,
            detached: true,
            stdio: ['ignore', uiLog, uiLog],
            env: { ...process.env, VITE_FARMSLOT_GATEWAY_URL: `ws://127.0.0.1:${port}` },
          },
        );
        closeSync(uiLog);
        const route = `runs?run=${runs[index].id}`;
        const cdp = (...args: string[]) =>
          execFileSync(
            process.execPath,
            [path.join(root, 'apps/command-center/scripts/cdp.mjs'), ...args],
            {
              cwd: root,
              encoding: 'utf8',
              env: { ...process.env, FARMSLOT_GATEWAY_TOKEN: token },
              timeout: 30000,
            },
          ).trim();
        await delay(2000);
        cdp('goto', `http://127.0.0.1:${uiPort}/#${route}`, '--new');
        cdp('login', route);
        const walk = `function find(selector,root=document){const e=root.querySelector(selector);if(e)return e;for(const child of root.querySelectorAll('*'))if(child.shadowRoot){const e=find(selector,child.shadowRoot);if(e)return e;}}`;
        const evaluate = (body: string) => JSON.parse(cdp('eval', route, walk + body));
        reviewUi = { cdp, evaluate, route };
        evaluate(
          `find('whats-new-modal')?.shadowRoot.querySelector('button.primary')?.click();return true;`,
        );
        const until = Date.now() + 20000;
        while (Date.now() < until) {
          if (evaluate(`return Boolean(find('[data-testid="run-terminal-toggle"]'));`)) break;
          await delay(200);
        }
        evaluate(`find('[data-testid="run-terminal-toggle"]').click();return true;`);
        const readyBy = Date.now() + 20000;
        let uiProof;
        while (Date.now() < readyBy) {
          uiProof = evaluate(
            `const t=find('terminal-view'),p=find('run-pipeline');return {phase:t?._attachPhase,progress:p?.taskProgress,transport:find('run-detail')?.run?.transport};`,
          );
          if (uiProof.phase === 'live' && uiProof.progress?.totalSteps) break;
          await delay(250);
        }
        assert.equal(uiProof.phase, 'live');
        assert(uiProof.progress.totalSteps > 0);
        await json(path.join(evidence, 'terminal-ui.json'), uiProof);
        evaluate(`find('terminal-view').scrollIntoView({block:'center'});return true;`);
        cdp('screenshot', route, path.join(evidence, 'terminal-ui.png'));

        await connection.call('terminal.subscribe', {
          ...params,
          interactive: true,
          cols: 100,
          rows: 30,
        });
        await delay(500);
        await connection.call('terminal.input', { ...params, data: 'workspace-proof\r' });
        await delay(500);
        const snapshot = await connection.call<{ lines: string[] }>('terminal.snapshot', params);
        await json(path.join(evidence, 'terminal-snapshot.json'), snapshot);
        assert(
          snapshot.lines
            .join('\n')
            .includes(
              'FIXTURE_CWD=' +
                runs[index].reviewWorkspace!.checkoutPath.replace(/^\/var\//, '/private/var/'),
            ) ||
            snapshot.lines
              .join('\n')
              .includes('FIXTURE_CWD=' + runs[index].reviewWorkspace!.checkoutPath),
        );
        const progress = await connection.call<{ structured: { totalSteps: number } }>(
          'task.progress',
          params,
        );
        assert(progress.structured.totalSteps > 0);
        await json(path.join(evidence, 'terminal-progress.json'), {
          snapshot,
          progress,
          modelWorkers: 0,
        });
        await connection.call('terminal.input', { ...params, data: 'complete-fixture\r' });
        await connection.call('terminal.unsubscribe', params);
        terminalProven = true;
      }
      await json(
        path.join(evidence, multipleReviews ? `run-${index + 1}.json` : 'run.json'),
        runs[index],
      );
    }
    current = runs[0];
    let reachedGitBarrier = false;
    if (interruptionBarrier && !lifecycleInterrupted) {
      try {
        await access(interruptionBarrier.marker);
        reachedGitBarrier = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (
      !lifecycleInterrupted &&
      (reachedGitBarrier ||
        (['cancel', 'restart'].includes(scenario) && current.status === 'monitoring'))
    ) {
      const binding = current.agentContexts?.find(
        (context) => context.id === 'review',
      )?.nativeSession;
      if (!interruptionBarrier)
        assert(binding?.acceptedAt, 'Interrupt only an accepted real reviewer');
      if (launchBarrier)
        assert(binding && !binding.acceptedAt, 'Launch interruption must precede acceptance');
      lifecycleInterrupted = true;
      await json(path.join(evidence, 'before-interruption.json'), current);
      if (interruptionBarrier)
        await cp(interruptionBarrier.marker, path.join(evidence, 'interruption.json'));
      if (scenario.startsWith('cancel')) {
        const started = Date.now();
        try {
          await connection.call(
            'run.cancel',
            {
              runId: current.id,
              reason: 'Verify reviewer lifecycle cancellation',
            },
            { timeoutMs: interruptionBarrier ? 15_000 : 30_000 },
          );
        } catch (error) {
          if (
            launchBarrier &&
            error instanceof GatewayConnectionError &&
            Date.now() - started >= 15_000
          )
            throw new Error('Native launch cancellation must not wait for initialization', {
              cause: error,
            });
          if (
            gitBarrier &&
            error instanceof GatewayConnectionError &&
            Date.now() - started >= 15_000
          )
            throw new Error('Allocation cancellation must not wait for the Git deadline', {
              cause: error,
            });
          throw error;
        }
        const elapsedMs = Date.now() - started;
        if (launchBarrier) {
          assert(elapsedMs < 15_000, 'Native launch cancellation must not wait for initialization');
          const barrier = JSON.parse(await readFile(launchBarrier.marker, 'utf8'));
          assert(!alive(barrier.pid), 'Cancelled native initialization left its process alive');
        }
        if (gitBarrier) {
          assert(elapsedMs < 15_000, 'Allocation cancellation must not wait for the Git deadline');
          const barrier = JSON.parse(await readFile(gitBarrier.marker, 'utf8'));
          assert(!alive(barrier.pid), 'Cancelled allocation left its Git command alive');
          assert(!alive(barrier.helperPid), 'Cancelled allocation left a Git helper alive');
        }
        await json(path.join(evidence, 'cancellation.json'), { elapsedMs });
      } else {
        connection.close();
        const exited = once(gateway, 'exit');
        process.kill(-gateway.pid!, 'SIGKILL');
        await exited;
        if (interruptionBarrier) await writeFile(interruptionBarrier.release, 'release\n');
        if (scenario === 'restart') {
          const configuration = JSON.parse(
            await readFile(path.join(project, 'project.json'), 'utf8'),
          );
          delete configuration.static_review.support;
          await json(path.join(project, 'project.json'), configuration);
          await rm(path.join(project, 'shared/review-skill'), { recursive: true });
        }
        gateway = startGateway(true);
        connection = await connectGateway();
        const recovered = (await connection.call<{ run: Run }>('run.get', { runId: current.id }))
          .run;
        const recoveredBinding = recovered.agentContexts?.find(
          (context) => context.id === 'review',
        )?.nativeSession;
        if (binding)
          for (const field of ['sessionId', 'leaseId', 'commandId', 'generation'] as const) {
            if (field === 'generation' && !binding.generation) continue;
            assert.equal(recoveredBinding?.[field], binding[field], `Restart changed ${field}`);
          }
        await json(path.join(evidence, 'after-restart.json'), recovered);
      }
      continue;
    }
    if (scenario === 'repeat-review' && runs.length === 1 && current.status === 'done') {
      const repeated = await connection.call<{ run: Run }>('run.create', {
        ...parameters,
        ticketOrPr: 'example/app#42',
        reviewScope: 'incremental',
      });
      runs.push(repeated.run);
      continue;
    }
    if (
      scenario === 'blocked' &&
      ['done', 'failed', 'blocked', 'cancelled'].includes(current.status) &&
      !current.reviewWorkspace?.cleanedAt
    ) {
      await delay(1000);
      continue;
    }
    if (
      runs.every((run) =>
        [
          'done',
          'failed',
          'cancelled',
          ...(scenario === 'tmux-fixture' ? [] : ['blocked']),
        ].includes(run.status),
      )
    )
      break;
    await delay(1000);
  }
  for (const [index, run] of runs.entries()) {
    if (scenario === 'blocked') {
      assert.equal(run.status, 'blocked', 'Blocked signal must remain a blocked run');
      assert.match(run.error ?? '', /Fixture review input unavailable/);
      assert.equal(run.slotId, null);
      assert.equal(run.reviewResult, undefined);
      assert(run.reviewWorkspace?.cleanedAt);
      assert(
        run.agentContexts?.find((context) => context.id === 'review')?.nativeSession?.closedAt,
      );
      await assert.rejects(access(run.reviewWorkspace!.checkoutPath));
      const signal = JSON.parse(
        await readFile(path.join(path.dirname(run.taskFile!), 'SIGNAL.json'), 'utf8'),
      );
      assert.equal(signal.status, 'blocked');
      assert.equal(signal.reason, 'Fixture review input unavailable');
      await cp(path.dirname(run.taskFile!), path.join(evidence, 'blocked-task'), {
        recursive: true,
      });
      continue;
    }
    if (scenario.startsWith('cancel')) {
      assert(lifecycleInterrupted);
      assert.equal(run.status, 'cancelled');
      assert.equal(run.slotId, null);
      assert(run.reviewWorkspace?.cleanedAt);
      const session = run.agentContexts?.find((context) => context.id === 'review')?.nativeSession;
      if (scenario === 'cancel' || scenario === 'cancel-cleanup') assert(session?.closedAt);
      else
        assert(
          !session?.acceptedAt,
          'Cancellation before dispatch must not accept a reviewer command',
        );
      if (scenario === 'cancel-cleanup')
        assert(
          run.reviewResult?.reviewMd.trim(),
          'Cancellation during cleanup must retain the completed review report',
        );
      await assert.rejects(access(run.reviewWorkspace!.checkoutPath));
      continue;
    }
    if (scenario.startsWith('restart')) assert(lifecycleInterrupted);
    assert.equal(run.status, 'done', run.error ?? 'Review did not complete');
    if (scenario === 'tmux-fixture') {
      await verifyReviewUi('saved-review-ui', true);
      const code = await connection.call<{ content: string }>('git.show', {
        slotId: '',
        runId: run.id,
        ref: headSha,
        path: 'message.txt',
      });
      assert.equal(code.content, 'hello world\n');
      await assert.rejects(
        connection.call('git.show', {
          slotId: '',
          runId: run.id,
          ref: baseSha,
          path: 'message.txt',
        }),
        /frozen review commits/,
      );
      reviewUi!.evaluate(`find('[data-testid="run-review-result"] button').click();return true;`);
      await verifyReviewUi('reopened-review-gate-ui', false);
      const reopened = (await connection.call<{ run: Run }>('run.get', { runId: run.id })).run;
      assert.equal(
        reopened.steps.find((step) => step.name === 'dispatch')?.completedAt,
        run.steps.find((step) => step.name === 'dispatch')?.completedAt,
      );
      const gate = reopened.decisions.find(
        (d) => d.type === 'engine_review_posting' && !d.resolvedAt,
      )!;
      assert(gate);
      await connection.call('run.resolveDecision', {
        runId: run.id,
        decisionId: gate.id,
        actionId: 'dismiss',
      });
      await verifyReviewUi('saved-review-after-reopen-ui', true);
      reviewUi!.cdp('close', reviewUi!.route);
    }
    assert.equal(run.slotId, null);
    assert(run.reviewWorkspace?.support?.sha256, 'Review must retain its admitted skill digest');
    assert.equal(
      await readFile(run.reviewWorkspace.support.skills[0].path, 'utf8'),
      '---\nname: fixture-static-review\ndescription: Inspect the fixture diff without app execution.\n---\n\n# Fixture static review\n\nInspect the frozen diff and existing files. Do not install dependencies, build, run tests or use an app. Record findings in the task artifacts.\n',
    );
    assert.equal(run.reviewResult?.reviewSnapshot?.headSha, headSha);
    assert(run.reviewResult?.reviewMd.trim());
    assert(run.reviewWorkspace?.cleanedAt);
    await assert.rejects(access(run.reviewWorkspace!.checkoutPath));
    assert.equal(
      await readFile(path.join(path.dirname(run.taskFile!), 'artifacts/review.md'), 'utf8'),
      run.reviewResult!.reviewMd,
    );
    const checklist = await readFile(
      path.join(path.dirname(run.taskFile!), 'CHECKLIST.md'),
      'utf8',
    );
    assert(!checklist.includes('- [ ]'), 'Retained checklist must show completed review work');
    const signal = JSON.parse(
      await readFile(path.join(path.dirname(run.taskFile!), 'SIGNAL.json'), 'utf8'),
    );
    assert(['done', 'complete'].includes(signal.status));
    assert.equal(signal.outcome, 'success');
    if (scenario === 'readonly' || scenario.startsWith('restart')) {
      const binding = run.agentContexts!.find((context) => context.id === 'review')!.nativeSession!;
      const history = await connection.call<NativeSessionReadResult>('native.session.read', {
        sessionId: binding.sessionId,
        executionNodeId: binding.executionNodeId,
        worker: {
          runId: run.id,
          contextId: 'review',
          leaseId: binding.leaseId,
          generation: binding.generation,
        },
        limit: 500,
      });
      await json(path.join(evidence, 'native-history.json'), history);
      assert.equal(history.commands.length, 1, 'Recovery must not dispatch another review command');
      assert.equal(history.commands[0].commandId, binding.commandId);
      assert.equal(history.commands[0].accepted, true);
      assert.equal(history.commands[0].outcome, 'completed');
      assert.equal(history.session.processStopped, true);
      if (scenario === 'readonly') {
        const attempt = history.events.find(
          (event) =>
            event.type === 'tool.completed' &&
            event.data?.cwd === run.reviewWorkspace!.checkoutPath &&
            Array.isArray(event.data?.commandActions) &&
            event.data.commandActions.some(
              (action: { command?: string }) => action.command === writeProbe,
            ),
        );
        assert.equal(history.session.cwd, run.reviewWorkspace!.checkoutPath);
        const structuredTool = history.events.find(
          (event) =>
            event.type === 'tool.completed' &&
            (event.tool?.input as { command?: string } | undefined)?.command === writeProbe,
        );
        const proof = attempt
          ? { exitCode: attempt.data?.exitCode, source: 'native event' }
          : structuredTool
            ? {
                exitCode: (structuredTool.tool?.output as { exitCode?: number } | undefined)
                  ?.exitCode,
                source: 'structured tool event',
              }
            : getRunnerAdapter(run.metrics.runner!).readCommandProbe({
                repo: run.reviewWorkspace!.checkoutPath,
                sessionId: run.metrics.runnerSessionId,
                command: writeProbe,
              });
        assert(
          typeof proof.exitCode === 'number' && proof.exitCode !== 0,
          'Source write probe must be rejected',
        );
        await json(path.join(evidence, 'source-write-denial.json'), proof);
      }
    }
    await cp(
      path.dirname(run.taskFile!),
      path.join(evidence, multipleReviews ? `task-${index + 1}` : 'task'),
      { recursive: true, dereference: false },
    );
  }
  if (scenario === 'repeat-review') {
    assert.equal(runs.length, 2, 'Repeat proof needs two completed native reviewers');
    const [prior, repeated] = runs;
    assert(
      prior.reviewResult?.lineComments?.some((comment) => comment.path === 'greeting.js'),
      'Repeat review must carry at least one actual finding',
    );
    const context = repeated.repeatReviewContext;
    assert.equal(context?.priorRunId, prior.id);
    assert.equal(context?.priorReviewedHeadSha, headSha);
    assert.equal(context?.currentHeadSha, headSha);
    assert.equal(
      context?.session?.continuity,
      'fallback-fresh',
      'Repeat review must disclose a fresh-session fallback',
    );
    assert.equal(context?.session?.fallbackReason, 'session-unavailable');
    assert.equal(context?.reviewScope, 'full');
    assert.equal(context?.sessionIntent, 'reset');
    assert.equal(repeated.reviewScope, 'full');
    assert(context?.incrementalUnavailableReason);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(path.dirname(repeated.taskFile!), 'inputs/prior-review.json'),
          'utf8',
        ),
      ),
      context,
      'The new task must carry the saved review context',
    );
    assert.deepEqual(
      context.unresolvedFindings,
      (prior.reviewResult?.lineComments ?? []).map((comment) => ({
        file: comment.path,
        line: comment.line,
        description: comment.body,
      })),
    );
    const sessions = runs.map(
      (run) => run.agentContexts?.find((entry) => entry.id === 'review')?.nativeSession,
    );
    assert(sessions.every((session) => session?.acceptedAt && session.closedAt));
    assert.notEqual(
      sessions[0]?.sessionId,
      sessions[1]?.sessionId,
      'A fresh workspace must not reuse old permissions',
    );
    assert.notEqual(prior.reviewWorkspace?.checkoutPath, repeated.reviewWorkspace?.checkoutPath);
    await json(path.join(evidence, 'repeat-review.json'), { context, sessions });
  }
  if (count === 3) {
    const starts = runs.map((run) =>
      Date.parse(run.steps.find((step) => step.name === 'monitor')!.startedAt!),
    );
    const ends = runs.map((run) =>
      Date.parse(run.steps.find((step) => step.name === 'monitor')!.completedAt!),
    );
    assert(
      Math.max(...starts) < Math.min(...ends),
      'All three actual reviewer executions must overlap',
    );
    const { fleet } = await connection.call<FleetStatusResult>('fleet.status');
    assert.equal(fleet.slots.length, 2);
    if (runtimeSlots) await runtimeSlots.verify(connection);
    else {
      assert(
        fleet.slots.every(
          (slot) => slot.lifecycle === 'busy' && slot.currentRunId?.startsWith('fixture-runtime-'),
        ),
      );
      assert.equal(await readFile(path.join(fixture, '.farm-status.json'), 'utf8'), occupiedSlots);
    }
    await json(path.join(evidence, 'concurrency.json'), {
      starts,
      ends,
      overlapMs: Math.min(...ends) - Math.max(...starts),
      occupiedSlotsUnchanged: true,
      occupancySource: runtimeSlots
        ? 'two dispatched project commands exercising live browser apps'
        : 'pre-seeded busy device-slot records',
      capacityRejection: true,
    });
  }
  console.log(
    JSON.stringify({
      passed: true,
      runIds: runs.map((run) => run.id),
      scenario,
      headSha,
      slotsUsed: 0,
      runner: current?.metrics.runner,
      evidence,
    }),
  );
} catch (error) {
  failure = error;
  await json(path.join(evidence, 'failure.json'), {
    error: String(error),
    runId: current?.id,
    fixture,
  });
} finally {
  // A failed assertion must not leave the fixture's artificial Git barrier held.
  if (interruptionBarrier && failure) await writeFile(interruptionBarrier.release, 'cleanup\n');
  try {
    await runtimeSlots?.stop();
  } catch (error) {
    cleanupFailed = true;
    failure = new AggregateError(
      [...(failure ? [failure] : []), error],
      'Runtime occupancy cleanup failed',
    );
  }
  let cleanupRuns = runs;
  if (connection) {
    try {
      const listed = await connection.call<{ runs: Run[] }>('run.list', { limit: 100 });
      cleanupRuns = listed.runs.filter(
        (run) => run.flowType === 'review-pr' && run.reviewWorkspaceTarget,
      );
    } catch (error) {
      cleanupFailed = true;
      failure = new AggregateError(
        [...(failure ? [failure] : []), error],
        'Workspace cleanup inventory failed',
      );
    }
  }
  for (const current of cleanupRuns.filter((run) => run.status !== 'done')) {
    if (!connection) break;
    try {
      const cancelled = await connection.call<{
        effects: Array<{ status: string; detail?: string }>;
      }>('run.cancel', { runId: current.id, reason: 'Workspace lifecycle validation cleanup' });
      await json(path.join(evidence, 'cancel.json'), cancelled);
      if (cancelled.effects.some((effect) => effect.status === 'failed'))
        throw new Error('Workspace validation cleanup has failed effects');
    } catch (error) {
      cleanupFailed = true;
      failure = new AggregateError(
        [...(failure ? [failure] : []), error],
        'Workspace validation or cleanup failed',
      );
      await json(path.join(evidence, 'cleanup-failure.json'), { error: String(error), fixture });
    }
  }
  if (terminalUi?.pid && terminalUi.exitCode === null) {
    const exited = once(terminalUi, 'exit');
    process.kill(-terminalUi.pid, 'SIGTERM');
    await exited;
  }
  connection?.close();
  const nativeRoot = path.join(fixture, 'home/native-sessions');
  try {
    let host: { pid: number } | undefined;
    try {
      host = JSON.parse(await readFile(path.join(nativeRoot, 'host.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (host && alive(host.pid)) {
      assert(matchesProcess(host.pid, nativeRoot), 'Fixture native supervisor identity changed');
      process.kill(host.pid, 'SIGTERM');
      const stoppedBy = Date.now() + 10_000;
      while (alive(host.pid) && Date.now() < stoppedBy) await delay(100);
      assert(!alive(host.pid), 'Fixture native supervisor did not stop');
    }
  } catch (error) {
    cleanupFailed = true;
    failure = new AggregateError(
      [...(failure ? [failure] : []), error],
      'Fixture native cleanup failed',
    );
    await json(path.join(evidence, 'native-cleanup-failure.json'), {
      error: String(error),
      fixture,
    });
  }
  if (gateway.exitCode === null && gateway.pid) {
    const exited = once(gateway, 'exit');
    process.kill(-gateway.pid, 'SIGTERM');
    if (!(await Promise.race([exited.then(() => true), delay(5000).then(() => false)]))) {
      process.kill(-gateway.pid, 'SIGKILL');
      await exited;
    }
  }
  // Preserve failed fixture state for diagnosis and any unconfirmed native cleanup.
  if (!failure) await rm(fixture, { recursive: true, force: true });
}
await json(path.join(evidence, 'outcome.json'), {
  passed: !failure,
  cleanupComplete: !cleanupFailed,
  error: failure ? String(failure) : null,
});
if (failure) throw failure;

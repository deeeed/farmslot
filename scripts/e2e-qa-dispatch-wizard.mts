#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { NativeProcessTree } from '../packages/agent-runtime/src/native/process-tree.js';
import { matchesProcess } from '../packages/agent-runtime/src/native/storage.js';
import {
  GatewayClient,
  GatewayConnectionError,
  type GatewayConnection,
} from '../packages/cli/src/gateway-client.js';
import type { QueueItem } from '../packages/protocol/src/index.js';
import {
  createRecipeRunner,
  createStandardCoreAdapters,
} from '../packages/recipe-harness/src/index.js';
import { startReviewInterfaceServers } from './e2e-static-review-interface.mts';

const root = fileURLToPath(new URL('../', import.meta.url));
const recipePath = path.join(root, 'docs/examples/recipes/farmslot/qa-dispatch-wizard.recipe.json');
if (process.argv[2] === 'recipe') {
  const evidence = path.resolve(
    root,
    process.argv[3] ?? `temp/qa-dispatch-wizard-recipe/${Date.now()}`,
  );
  process.env.FARMSLOT_QA_WIZARD_EVIDENCE = path.join(evidence, 'browser');
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
      name: 'General dispatch Review and QA interface',
    },
  });
  const result = await runner.run({
    recipeDocument: JSON.parse(await readFile(recipePath, 'utf8')),
    artifactsDir: evidence,
    projectRoot: root,
    source: { kind: 'operator', trust: 'trusted', name: 'General dispatch interface validation' },
  });
  console.log(JSON.stringify(result));
  process.exit(result.status === 'pass' ? 0 : 1);
}

const evidence = path.resolve(
  root,
  process.argv[2] ??
    process.env.FARMSLOT_QA_WIZARD_EVIDENCE ??
    `temp/qa-dispatch-wizard/${Date.now()}`,
);
await mkdir(evidence, { recursive: true });
const fixture = await mkdtemp(path.join(tmpdir(), 'qa-dispatch-wizard-'));
let servers: ReturnType<typeof startReviewInterfaceServers> | undefined;
let connection: GatewayConnection | undefined;
let failure: unknown;
let token = '';
let environment: NodeJS.ProcessEnv;
const checkpoints: string[] = [];
const sourceSnapshot = async () => {
  const directory = 'apps/command-center/ui/src/components/dispatch';
  const files = (await readdir(path.join(root, directory)))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
    .map((name) => `${directory}/${name}`);
  files.push(
    'scripts/e2e-qa-dispatch-wizard.mts',
    'apps/command-center/ui/src/components/shared/qa-input-fields.ts',
    'apps/command-center/ui/src/components/shared/qa-profile-control.ts',
  );
  return Promise.all(
    files.map(async (file) => ({
      path: file,
      sha256: createHash('sha256')
        .update(await readFile(path.join(root, file)))
        .digest('hex'),
    })),
  );
};
let initialSource: Awaited<ReturnType<typeof sourceSnapshot>> = [];
const observedQueue = new Map<string, QueueItem>();
let screenshot: ((name: string) => void) | undefined;
async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
async function port() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return value;
}
try {
  initialSource = await sourceSnapshot();
  execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
  for (const name of ['scripts', 'services', 'packages', 'node_modules'])
    await symlink(path.join(root, name), path.join(fixture, name));
  await writeFile(path.join(fixture, 'CLAUDE.md'), '# Isolated browser validation fixture\n');
  const [gatewayPort, uiPort, cdpPort] = await Promise.all([port(), port(), port()]);
  token = randomBytes(32).toString('hex');
  const models = [{ runner: 'codex', model: 'gpt-5.6-luna', effort: 'low' }];
  for (const name of ['wizard-farm', 'workspace-only']) {
    const project = path.join(fixture, 'projects', name);
    for (const flow of ['review-pr', 'validation', 'dev']) {
      await mkdir(path.join(project, 'shared', flow), { recursive: true });
      await writeFile(
        path.join(project, 'shared', flow, 'shared.md'),
        `---\nplatforms: [cli]\n---\n\n# ${flow}\n\n- [ ] Perform the selected task and report the result.\n`,
      );
    }
    await json(path.join(project, 'project.json'), {
      name,
      repo_url: `https://github.com/example/${name}.git`,
      ci: { repo: `example/${name}` },
      execution_templates: {
        sources: [{ id: 'workspace:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
        defaults: [
          { when: { flow: 'validation', domain: 'payments' }, templateId: 'validation/shared' },
        ],
      },
      static_review: { template_id: 'review-pr/shared' },
      qa: {
        default_profile: 'daily',
        profiles: [
          {
            id: 'pr',
            title: 'PR checks',
            description: 'Validate one proposed change.',
            template_id: 'validation/shared',
            inputs: { scope: 'pr', smoke: true },
          },
          {
            id: 'daily',
            title: 'Daily changes',
            description: 'Validate changes from the previous day.',
            template_id: 'validation/shared',
            inputs: { window: '24h', smoke: true },
            input_fields: [
              {
                path: 'window',
                title: 'Change window',
                type: 'select',
                options: [
                  { value: '24h', title: 'Last24 hours' },
                  { value: '48h', title: 'Last48 hours' },
                ],
              },
            ],
          },
          {
            id: 'release',
            title: 'Release validation',
            description: 'Validate a chosen release scope and proof lane.',
            template_id: 'validation/shared',
            input_fields: [
              { path: 'scope', title: 'Scope', type: 'text', required: true },
              {
                path: 'lane',
                title: 'Proof lane',
                type: 'select',
                required: true,
                options: [
                  { value: 'source', title: 'Development build' },
                  { value: 'official', title: 'Official artifact' },
                ],
              },
            ],
          },
        ],
      },
      workflow_defaults: {
        'review-pr': {
          execution: {
            workspacePolicy:
              name === 'workspace-only'
                ? { kind: 'exact', machine: 'zero-node' }
                : { kind: 'exact', machine: 'review-other' },
            transport: 'native',
            models: [{ runner: 'cursor', model: 'cursor-grok-4.6-xhigh' }],
          },
        },
        ...(name === 'wizard-farm'
          ? {
              qa: {
                execution: {
                  slotPolicy: { kind: 'pool', allowedSlots: ['qa-runtime', 'qa-runtime-other'] },
                  models,
                },
              },
            }
          : {}),
      },
    });
  }
  const slot = {
    id: 'qa-runtime',
    enabled: true,
    repo: fixture,
    session: 'qa-wizard-unused',
    resources: {},
  };
  const secondSlot = { ...slot, id: 'qa-runtime-other', session: 'qa-wizard-unused-other' };
  const filterSlot = { ...slot, id: 'filter-only', session: 'qa-wizard-unused-filter' };
  for (const [machine, project, slots] of [
    ['review-node', 'wizard-farm', [slot, secondSlot]],
    ['review-other', 'wizard-farm', [filterSlot]],
    ['zero-node', 'workspace-only', []],
  ] as const) {
    await json(path.join(fixture, 'pool', `${machine}.json`), {
      machine,
      host: 'localhost',
      ssh_user: process.env.USER ?? 'operator',
      project,
      platform: 'cli',
      os: process.platform,
      review_workspaces: { max_concurrent: 3 },
      slots,
    });
  }
  await json(path.join(fixture, '.farm-status.json'), {
    checked_at: new Date().toISOString(),
    slots: [slot, secondSlot, filterSlot].map((slot) => ({
      slot: slot.id,
      machine: slot === filterSlot ? 'review-other' : 'review-node',
      project: 'wizard-farm',
      platform: 'cli',
      repo: fixture,
      session: slot.session,
      lifecycle: 'ready',
      phase: null,
      agent: 'idle',
      enabled: true,
      health: { ssh: 'LOCAL', device: '-', devserver: 'OK', fixtures: '-' },
    })),
  });
  await mkdir(path.join(fixture, 'bin'));
  await writeFile(
    path.join(fixture, 'bin/gh'),
    String.raw`#!/usr/bin/env node
const args=process.argv.slice(2); let body;
if(args[0]==='auth'&&args[1]==='token'){process.stdout.write('fixture-provider-token\n');process.exit(0);}
if(args[0]==='api'&&args.includes('user')) body={login:'fixture-reviewer'};
else if(args[0]==='api'&&args.includes('graphql')) {
 const field=name=>args.find(v=>v.startsWith(name+'='))?.slice(name.length+1);
 const number=Number(field('number')??42), repo=(field('owner')??'example')+'/'+(field('name')??'wizard-farm');
 const query=field('query')??'';
 const pr={id:'fixture-'+number,number,title:'Fixture change',state:'OPEN',isDraft:false,headRefOid:'a'.repeat(40),baseRefOid:'b'.repeat(40),baseRefName:'main',headRefName:'fixture-change',author:{login:'fixture-author'},repository:{nameWithOwner:repo},reviewDecision:null,viewerLatestReview:null,viewerLatestReviewRequest:null,labels:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}};
 body={data:{repository:query.includes('pullRequests(')?{pullRequests:{nodes:[pr],pageInfo:{hasNextPage:false,endCursor:null}}}:{pullRequest:pr},rateLimit:{cost:1,remaining:4999,resetAt:'2099-01-01T00:00:00Z'}}};
} else throw new Error('Unsupported fixture provider operation');
if(args.includes('--include'))process.stdout.write('HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n');
process.stdout.write(JSON.stringify(body));
`,
    { mode: 0o700 },
  );
  environment = {
    ...process.env,
    PATH: `${path.join(fixture, 'bin')}:${process.env.PATH}`,
    FARMSLOT_ROOT: fixture,
    FARMSLOT_HOME: path.join(fixture, 'home'),
    FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
    FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
    FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
    FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(gatewayPort),
    VITE_PORT: String(uiPort),
    FARMSLOT_GATEWAY_TOKEN: token,
    FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'legacy-env',
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    NODE_TEST_CONTEXT: '1',
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
    FARMSLOT_CDP_PORT: String(cdpPort),
    FARMSLOT_CDP_PROFILE: path.join(fixture, 'chrome'),
    FARMSLOT_UI_URL: `http://127.0.0.1:${uiPort}/#dispatch`,
    FARMSLOT_CDP_HEADLESS: '1',
  };
  servers = startReviewInterfaceServers({ root, evidence, environment });
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${gatewayPort}`,
    timeout: 10000,
    credential: { token },
  });
  const deadline = Date.now() + 30000;
  while (!connection && Date.now() < deadline) {
    try {
      connection = await client.connect();
    } catch (error) {
      if (!(error instanceof GatewayConnectionError)) throw error;
      await delay(200);
    }
  }
  assert(connection, 'Fixture gateway did not start');
  const cdpFile = path.join(root, 'apps/command-center/scripts/cdp.mjs');
  let activeRoute = 'dispatch';
  const cdp = (...args: string[]) =>
    execFileSync(process.execPath, [cdpFile, ...args], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const walk = `function find(selector,root=document,prefix=''){const found=root.querySelector(selector);if(found)return {element:found,path:prefix+selector};for(const element of root.querySelectorAll('*'))if(element.shadowRoot){const result=find(selector,element.shadowRoot,prefix+element.tagName.toLowerCase()+' >>> ');if(result)return result;}return null;}`;
  const evaluate = (body: string) =>
    JSON.parse(
      cdp('eval', activeRoute, walk + `const value=await(async()=>{${body}})();return {value};`),
    ).value;
  const selector = (id: string) => `[data-testid="${id}"]`;
  const click = (id: string) =>
    evaluate(
      `const e=find(${JSON.stringify(selector(id))})?.element;if(!e||e.disabled||!e.getClientRects().length)throw new Error('Missing/disabled control: '+${JSON.stringify(id)});e.click();return true;`,
    );
  const fill = (id: string, value: string, select = false) => {
    const target = evaluate(`return find(${JSON.stringify(selector(id))})?.path;`);
    assert(target, `Missing control ${id}`);
    cdp(select ? 'select' : 'fill', activeRoute, target, value);
  };
  const waitUI = async (body: string) => {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      if (evaluate(body)) return;
      await delay(250);
    }
    throw new Error(`UI checkpoint missing: ${body}`);
  };
  const choose = async (id: string, value: string) => {
    evaluate(
      `find(${JSON.stringify(selector(id))}).element.shadowRoot.querySelector('.trigger').click();return true;`,
    );
    const option = `[data-choice-value=${JSON.stringify(value)}]`;
    await waitUI(
      `return Boolean(find(${JSON.stringify(selector(id))}).element.shadowRoot.querySelector(${JSON.stringify(option)}));`,
    );
    evaluate(
      `find(${JSON.stringify(selector(id))}).element.shadowRoot.querySelector(${JSON.stringify(option)}).click();return true;`,
    );
  };
  const exists = (id: string) => `Boolean(find(${JSON.stringify(selector(id))}))`;
  const observe = (items: QueueItem[]) => {
    for (const item of items)
      if (!observedQueue.has(item.id)) observedQueue.set(item.id, structuredClone(item));
  };
  connection.onEvent((event) => {
    if (event.event === 'queue.updated') observe((event.payload as { items: QueueItem[] }).items);
  });
  const queue = async () => {
    observe((await connection!.call<{ items: QueueItem[] }>('dispatch.queue.list')).items);
    return [...observedQueue.values()];
  };
  const noExecution = async () => {
    const { runs } = await connection!.call<{
      runs: Array<{
        status: string;
        steps: Array<{ status: string }>;
        agentContexts?: Array<{ nativeSession?: unknown; runnerSessionId?: unknown }>;
      }>;
    }>('run.list');
    for (const run of runs) {
      assert.equal(run.status, 'created', 'The explicit test gate must prevent every worker start');
      assert(run.steps.every((step) => step.status === 'pending'));
      assert(
        !run.agentContexts?.some((context) => context.nativeSession || context.runnerSessionId),
      );
    }
  };
  const waitQueue = async (count: number) => {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const items = await queue();
      if (items.length === count) {
        await noExecution();
        return items;
      }
      await delay(250);
    }
    throw new Error(`Expected ${count} queued tasks`);
  };
  screenshot = (name: string) => {
    cdp('screenshot', activeRoute, path.join(evidence, `${name}.png`));
  };
  const navigate = async (hash: string) => {
    cdp('goto', '#fleet');
    activeRoute = 'fleet';
    await waitUI(`return !find('dispatch-wizard');`);
    cdp('goto', hash);
    activeRoute = hash.replace(/^#/, '').split('?')[0];
    await waitUI(
      `return Boolean(find('[data-testid="dispatch-flow-qa"]')?.element.getClientRects().length);`,
    );
  };
  const uiDeadline = Date.now() + 30000;
  let uiReady = false;
  while (Date.now() < uiDeadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${uiPort}`)).ok) {
        uiReady = true;
        break;
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await delay(200);
  }
  assert(uiReady, 'Fixture UI did not start');
  execFileSync('bash', [path.join(root, 'apps/command-center/scripts/debug-chrome.sh')], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 30000,
  });
  cdp('viewport', activeRoute, '1440', '1200');
  await waitUI(`return Boolean(document.querySelector('.auth-input'));`);
  cdp('fill', activeRoute, '.auth-input', token);
  evaluate(`document.querySelector('.auth-card').requestSubmit();return true;`);
  await waitUI(
    `return Boolean(find('[data-testid="dispatch-flow-qa"]')?.element.getClientRects().length);`,
  );
  evaluate(
    `find('whats-new-modal')?.element.shadowRoot?.querySelector('button.primary')?.click();return true;`,
  );
  await noExecution();

  // Same handoff as Review from the PR list: no runner/transport overrides.
  await navigate('#dispatch?flow=review-pr&project=wizard-farm&ticket=example%2Fwizard-farm%23199');
  await waitUI(
    `return find('runner-model-effort-picker')?.element.runner === 'cursor' && find('runner-model-effort-picker')?.element.model === 'cursor-grok-4.6-xhigh';`,
  );
  assert.deepEqual(
    evaluate(
      `return [...find('runner-model-effort-picker').element.shadowRoot.querySelector('.pill-row').querySelectorAll('button')].map(button=>button.textContent.trim());`,
    ),
    ['claude', 'codex', 'cursor', 'grok'],
  );
  evaluate(
    `find('[data-testid="dispatch-execution-options"]').element.querySelector('summary').click();find('runner-model-effort-picker').element.shadowRoot.querySelector('details summary').click();return true;`,
  );
  fill('runner-custom-model', 'composer-2.5-fast');
  evaluate(`find('[data-testid="dispatch-ticket"]').element.focus();return true;`);
  await waitUI(`return find('runner-model-effort-picker').element.model === 'composer-2.5-fast';`);
  for (const machine of ['review-node', 'review-other']) {
    evaluate(
      `const bar=find('global-filter-bar').element.shadowRoot;const button=[...bar.querySelectorAll('[data-testid="global-filter-machines"] button')].find(button=>button.textContent.trim()===${JSON.stringify(machine)});if(!button)throw new Error('Missing machine filter');button.click();return true;`,
    );
  }
  await waitUI(
    `return find('dispatch-wizard').element.shadowRoot.textContent.includes('Automatic · review-other');`,
  );
  await waitUI(`return !find('[data-testid="dispatch-submit"]').element.disabled;`);
  click('dispatch-submit');
  let createdReview;
  for (let attempt = 0; attempt < 100; attempt++) {
    const listed = await connection.call<{
      runs: Array<{
        id: string;
        ticketOrPr: string;
        transport: string;
        slotId: string | null;
        reviewWorkspaceTarget?: { machine: string };
        effort: string;
        metrics: { runner: string; model: string };
      }>;
    }>('run.list');
    createdReview = listed.runs.find((run) => run.ticketOrPr === 'example/wizard-farm#199');
    if (createdReview) break;
    await delay(100);
  }
  assert(createdReview, 'PR-list Review must dispatch using a supported farm default');
  assert.equal(createdReview.transport, 'native');
  assert.equal(createdReview.metrics.runner, 'cursor');
  assert.equal(createdReview.metrics.model, 'composer-2.5-fast');
  assert.equal(createdReview.effort, undefined);
  assert.equal(createdReview.slotId, null);
  assert.equal(
    createdReview.reviewWorkspaceTarget?.machine,
    'review-other',
    'Automatic must preserve the matching farm machine under multiple filters',
  );
  await noExecution();
  await json(path.join(evidence, 'review-handoff.json'), createdReview);
  checkpoints.push('pr-list-review-default-dispatches-without-worker');
  await navigate('#dispatch');
  evaluate(
    `find('global-filter-bar').element.shadowRoot.querySelector('.clear-btn').click();return true;`,
  );

  click('dispatch-flow-qa');
  await waitUI(`return ${exists('dispatch-project-wizard-farm')};`);
  click('dispatch-project-wizard-farm');
  await waitUI(`return find('[data-testid="dispatch-qa-profile"]')?.element.value==='';`);
  assert.match(
    evaluate(`return find('dispatch-wizard').element.shadowRoot.textContent;`),
    /Validate changes from the previous day/,
  );
  assert(evaluate(`return Boolean(find('slot-prepare-options'));`));
  assert(!evaluate(`return ${exists('dispatch-review-machine')};`));
  fill('dispatch-ticket', 'example/wizard-farm#101');
  await waitUI(`return !find('[data-testid="dispatch-queue"]').element.disabled;`);
  screenshot('qa-farm-default');
  checkpoints.push('farm-default-and-runtime-controls');

  assert.equal(
    evaluate(`return find('[data-testid=dispatch-qa-advanced]').element.open;`),
    false,
    'QA input overrides must start collapsed',
  );
  evaluate(
    `find('[data-testid=dispatch-qa-advanced]').element.querySelector('summary').click();return true;`,
  );
  for (const invalid of ['{', '[1,2]']) {
    fill('dispatch-qa-inputs', invalid);
    await waitUI(
      `return find('[data-testid="dispatch-queue"]').element.disabled && find('[data-testid="dispatch-submit"]').element.disabled;`,
    );
    assert.equal((await queue()).length, 0);
    assert.match(
      evaluate(`return find('[data-testid="dispatch-qa-profile-controls"]').element.textContent;`),
      /JSON|object/,
    );
  }
  screenshot('qa-invalid-inputs');
  checkpoints.push('invalid-json-refused-before-queue');
  fill('dispatch-qa-inputs', '');
  await waitUI(`return !find('[data-testid="dispatch-queue"]').element.disabled;`);
  click('dispatch-queue');
  let items = await waitQueue(1);
  assert.equal(items[0].flowType, 'qa');
  assert.equal(items[0].qaProfileId, 'daily');
  assert.deepEqual(items[0].qaInputs, { window: '24h', smoke: true });
  assert.equal(items[0].slotId, 'qa-runtime');
  assert.equal(items[0].reviewWorkspaceTarget, undefined);
  await json(path.join(evidence, 'qa-default-item.json'), items[0]);

  await choose('dispatch-qa-profile', 'pr');
  const inputs = { scope: { from: 'base', to: 'head' }, recipes: ['smoke'], optional: null };
  fill('dispatch-qa-inputs', JSON.stringify(inputs));
  fill('dispatch-ticket', 'example/wizard-farm#102');
  await waitUI(`return !find('[data-testid="dispatch-queue"]').element.disabled;`);
  click('dispatch-queue');
  items = await waitQueue(2);
  const custom = items.find((item) => item.ticketOrPr.endsWith('#102'))!;
  assert.equal(custom.qaProfileId, 'pr');
  assert.deepEqual(custom.qaInputs, { ...inputs, smoke: true });
  await json(path.join(evidence, 'qa-custom-item.json'), custom);
  checkpoints.push('typed-default-and-custom-queue-fields');

  click('dispatch-flow-review-pr');
  await waitUI(
    `return ${exists('dispatch-review-machine')} && !${exists('dispatch-qa-profile-controls')};`,
  );
  assert(!evaluate(`return Boolean(find('slot-prepare-options') || find('slot-choice-list'));`));
  assert(
    !evaluate(
      `return find('dispatch-wizard').element.shadowRoot.textContent.includes('Review Tier');`,
    ),
  );
  await choose('dispatch-review-machine', 'review-other');
  fill('dispatch-ticket', 'example/wizard-farm#103');
  await waitUI(`return !find('[data-testid="dispatch-queue"]').element.disabled;`);
  screenshot('static-after-qa');
  click('dispatch-queue');
  items = await waitQueue(3);
  const review = items.find((item) => item.ticketOrPr.endsWith('#103'))!;
  assert.equal(review.flowType, 'review-pr');
  assert.deepEqual(review.reviewWorkspaceTarget, { machine: 'review-other' });
  assert.equal(review.slotId ?? null, null);
  assert.equal(review.allowedSlots ?? null, null);
  assert.equal(review.qaProfileId, undefined);
  assert.equal(review.qaInputs, undefined);
  await json(path.join(evidence, 'review-after-qa-item.json'), review);
  checkpoints.push('review-switch-clears-runtime-profile-fields');

  click('dispatch-project-workspace-only');
  fill('dispatch-ticket', 'example/workspace-only#104');
  await waitUI(`return !find('[data-testid="dispatch-queue"]').element.disabled;`);
  screenshot('zero-slot-farm');
  click('dispatch-queue');
  items = await waitQueue(4);
  const zero = items.find((item) => item.project === 'workspace-only')!;
  assert.deepEqual(zero.reviewWorkspaceTarget, { machine: 'zero-node' });
  assert.equal(zero.slotId ?? null, null);
  await json(path.join(evidence, 'zero-slot-item.json'), zero);
  checkpoints.push('zero-slot-farm-queues-static-review');

  await navigate(
    '#dispatch?flow=review-pr&validationDepth=full-live&project=wizard-farm&slot=qa-runtime-other&ticket=example%2Fwizard-farm%23105',
  );
  await waitUI(
    `return find('[data-testid="dispatch-flow-qa"]').element.classList.contains('selected') && find('[data-testid="dispatch-qa-profile"]')?.element.value==='';`,
  );
  assert(!evaluate(`return ${exists('dispatch-review-machine')};`));
  await waitUI(`return !find('[data-testid="dispatch-queue"]').element.disabled;`);
  click('dispatch-queue');
  items = await waitQueue(5);
  const legacy = items.find((item) => item.ticketOrPr.endsWith('#105'))!;
  assert.equal(legacy.flowType, 'qa');
  assert.equal(legacy.slotId, 'qa-runtime-other');
  assert.equal(legacy.reviewWorkspaceTarget, undefined);
  await json(path.join(evidence, 'legacy-link-item.json'), legacy);
  checkpoints.push('legacy-full-live-link-preserves-runtime-slot');

  await navigate(
    '#dispatch?flow=review-pr&project=wizard-farm&slot=qa-runtime&ticket=example%2Fwizard-farm%23106',
  );
  await waitUI(
    `return ${exists('dispatch-review-machine')} && find('[data-testid="dispatch-queue"]').element.disabled;`,
  );
  assert.match(
    evaluate(`return find('dispatch-wizard').element.shadowRoot.textContent;`),
    /link selects a runtime slot/,
  );
  assert.equal((await queue()).length, 5);
  click('dispatch-flow-review-pr');
  await waitUI(`return !find('[data-testid="dispatch-queue"]').element.disabled;`);
  checkpoints.push('ambiguous-slot-link-requires-explicit-flow-choice');
  click('dispatch-flow-qa');
  await waitUI(
    `return ${exists('dispatch-qa-profile-controls')} && Boolean(find('slot-prepare-options'));`,
  );
  assert.equal(evaluate(`return find('[data-testid="dispatch-qa-inputs"]').element.value;`), '');
  click('dispatch-flow-dev');
  await waitUI(
    `return Boolean(find('slot-prepare-options')) && find('dispatch-wizard').element.shadowRoot.textContent.includes('Interactive dev');`,
  );
  assert(
    !evaluate(
      `return ${exists('dispatch-qa-profile-controls')} || ${exists('dispatch-review-machine')};`,
    ),
  );
  screenshot('existing-dev-controls');
  checkpoints.push('qa-return-and-existing-dev-controls');
  await navigate('#dispatch?flow=qa&project=wizard-farm&ticket=changes-since-yesterday');
  await waitUI(`return Boolean(find('[data-testid="dispatch-qa-domain"]'));`);
  await choose('dispatch-qa-domain', 'payments');
  const chooseField = async (field: string, value: string) => {
    const selector = `[data-qa-input="${field}"]`;
    evaluate(
      `find(${JSON.stringify(selector)}).element.shadowRoot.querySelector('.trigger').click();return true;`,
    );
    await waitUI(
      `return Boolean(find(${JSON.stringify(selector)}).element.shadowRoot.querySelector('[data-choice-value="${value}"]'));`,
    );
    evaluate(
      `find(${JSON.stringify(selector)}).element.shadowRoot.querySelector('[data-choice-value="${value}"]').click();return true;`,
    );
  };
  await chooseField('window', '48h');
  let count = (await queue()).length;
  await waitUI(`return !find('[data-testid="dispatch-queue"]').element.disabled;`);
  click('dispatch-queue');
  let actionItems = await waitQueue(count + 1);
  const daily = actionItems.at(-1)!;
  assert.equal(daily.domain, 'payments');
  assert.equal(daily.qaInputs?.window, '48h');
  assert.equal(daily.ticketOrPr, 'changes-since-yesterday');
  await choose('dispatch-qa-profile', 'release');
  fill('dispatch-ticket', 'release/1.2.3');
  await waitUI(`return find('[data-testid="dispatch-queue"]').element.disabled;`);
  const scopeControl = evaluate(`return find('[data-qa-input="scope"]').path;`);
  cdp('fill', activeRoute, scopeControl, '   ');
  await chooseField('lane', 'source');
  assert(
    evaluate(`return find('[data-testid="dispatch-queue"]').element.disabled;`),
    'Whitespace is not a release scope',
  );
  cdp('fill', activeRoute, scopeControl, 'payments');
  await chooseField('lane', 'source');
  await waitUI(`return !find('[data-testid="dispatch-queue"]').element.disabled;`);
  screenshot('qa-release-inputs');
  count = (await queue()).length;
  click('dispatch-queue');
  actionItems = await waitQueue(count + 1);
  const release = actionItems.at(-1)!;
  assert.equal(release.qaProfileId, 'release');
  assert.equal(release.ticketOrPr, 'release/1.2.3');
  assert.equal(release.domain, 'payments');
  assert.deepEqual(release.qaInputs, { scope: 'payments', lane: 'source' });
  await json(path.join(evidence, 'qa-dynamic-actions.json'), { daily, release });
  checkpoints.push('farm-fields-domain-and-non-pr-qa-actions');

  await noExecution();
  await json(path.join(evidence, 'queue.json'), {
    observedItems: await queue(),
    current: await connection.call('dispatch.queue.list'),
    admittedButUnstarted: await connection.call('run.list'),
  });
  const finalSource = await sourceSnapshot();
  assert.deepEqual(finalSource, initialSource, 'Wizard source changed during the proof');
  await json(path.join(evidence, 'source.json'), {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    files: initialSource,
  });
} catch (error) {
  failure = error;
  await json(path.join(evidence, 'failure.json'), {
    error: String(error).replaceAll(token || 'NO_TOKEN', '[fixture-token]'),
    checkpoints,
    observedQueue: [...observedQueue.values()],
  });
  try {
    screenshot?.('failure');
  } catch (captureError) {
    await json(path.join(evidence, 'screenshot-error.json'), {
      error: String(captureError).replaceAll(token || 'NO_TOKEN', '[fixture-token]'),
    });
  }
} finally {
  connection?.close();
  const cleanupErrors: unknown[] = [];
  try {
    const marker = `--user-data-dir=${path.join(fixture, 'chrome')}`;
    const processes = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' });
    for (const line of processes.split('\n').filter((line) => line.includes(marker))) {
      const pid = Number(line.trim().split(/\s+/, 1)[0]);
      if (!Number.isInteger(pid) || !matchesProcess(pid, marker)) continue;
      const tree = new NativeProcessTree(pid);
      tree.terminate();
      let until = Date.now() + 5000;
      while (!tree.empty() && Date.now() < until) await delay(100);
      if (!tree.empty()) tree.stop();
      until = Date.now() + 5000;
      while (!tree.empty() && Date.now() < until) await delay(100);
      assert(tree.empty(), 'Fixture browser cleanup unconfirmed');
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await servers?.stop();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await rm(fixture, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      'Wizard fixture cleanup failed',
    );
  await json(path.join(evidence, 'outcome.json'), {
    passed: !failure,
    cleanupComplete: cleanupErrors.length === 0,
    modelRuns: 0,
    checkpoints,
    ...(failure
      ? {
          error: String(failure).replaceAll(token || 'NO_TOKEN', '[fixture-token]'),
          cleanupErrors: cleanupErrors.map((error) =>
            String(error).replaceAll(token || 'NO_TOKEN', '[fixture-token]'),
          ),
        }
      : {}),
  });
}
if (failure) throw new Error(String(failure).replaceAll(token || 'NO_TOKEN', '[fixture-token]'));
console.log(
  JSON.stringify({ passed: true, evidence, checkpoints, modelRuns: 0, cleanupComplete: true }),
);

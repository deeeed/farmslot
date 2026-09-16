#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { openSync, closeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, readlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NativeProcessTree } from '../packages/agent-runtime/src/native/process-tree.js';
import { matchesProcess } from '../packages/agent-runtime/src/native/storage.js';
import {
  GatewayClient,
  GatewayConnectionError,
  type GatewayConnection,
} from '../packages/cli/src/gateway-client.js';
import type { PRRulesListResult, PRTeamProfile } from '../packages/protocol/src/index.js';
import {
  createRecipeRunner,
  createStandardCoreAdapters,
} from '../packages/recipe-harness/src/index.js';

/** Start the checkout's production gateway and Vite UI with caller-owned isolated paths/ports. */
export function startReviewInterfaceServers(options: {
  root: string;
  evidence: string;
  environment: NodeJS.ProcessEnv;
}) {
  const { root, evidence, environment } = options;
  function start(workspace: string, file: string) {
    const fd = openSync(path.join(evidence, file), 'w', 0o600);
    const child = spawn(
      'yarn',
      [
        'workspace',
        workspace,
        workspace === '@farmslot/gateway' ? 'start' : 'dev',
        ...(workspace === '@farmslot/command-center-ui' ? ['--host', '127.0.0.1'] : []),
      ],
      {
        cwd: root,
        detached: true,
        stdio: ['ignore', fd, fd],
        env: environment,
      },
    );
    closeSync(fd);
    return child;
  }

  const gateway = start('@farmslot/gateway', 'gateway.log');
  const ui = start('@farmslot/command-center-ui', 'ui.log');
  return {
    gateway,
    ui,
    async stop() {
      for (const child of [ui, gateway])
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          const stopped = once(child, 'exit');
          process.kill(-child.pid, 'SIGTERM');
          if (!(await Promise.race([stopped.then(() => true), delay(5000).then(() => false)]))) {
            process.kill(-child.pid, 'SIGKILL');
            await stopped;
          }
        }
    },
  };
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (process.argv[2] === 'recipe') {
    const catalog = JSON.parse(
      await readFile(
        path.join(root, 'docs/examples/recipes/farmslot-v1.action-manifest.json'),
        'utf8',
      ),
    );
    const names = ['command', 'end'];
    const runner = createRecipeRunner({
      actionManifest: {
        $schema: catalog.$schema,
        actions: Object.fromEntries(names.map((name) => [name, catalog.actions[name]])),
      },
      adapters: createStandardCoreAdapters({ actions: names }),
      runner: {
        source: 'worktree',
        git_ref: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        name: 'Static review interface validation',
      },
    });
    const result = await runner.run({
      recipeDocument: JSON.parse(
        await readFile(
          path.join(root, 'docs/examples/recipes/farmslot/static-review-interface.recipe.json'),
          'utf8',
        ),
      ),
      artifactsDir: path.resolve(
        root,
        process.argv[3] ?? `temp/static-review-interface-recipe/${Date.now()}`,
      ),
      projectRoot: root,
      source: { kind: 'operator', trust: 'trusted', name: 'Static review interface validation' },
    });
    console.log(JSON.stringify(result));
    process.exit(result.status === 'pass' ? 0 : 1);
  }
  const evidence = path.resolve(
    root,
    process.argv[2] ?? `temp/static-review-interface/${Date.now()}`,
  );
  await mkdir(evidence, { recursive: true });
  const fixture = await mkdtemp(path.join(tmpdir(), 'static-review-interface-'));
  execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
  for (const name of ['scripts', 'services', 'packages', 'node_modules'])
    await symlink(path.join(root, name), path.join(fixture, name));
  await writeFile(path.join(fixture, 'CLAUDE.md'), '# Isolated interface validation\n');
  async function json(file: string, value: unknown) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  }
  async function port() {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const value = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    return value;
  }
  const gatewayPort = await port(),
    uiPort = await port(),
    cdpPort = await port();
  const token = randomBytes(32).toString('hex');
  const project = path.join(fixture, 'projects/review');
  await mkdir(path.join(project, 'shared/review-pr'), { recursive: true });
  await mkdir(path.join(project, 'shared/validation'), { recursive: true });
  await writeFile(
    path.join(project, 'shared/review-pr/shared.md'),
    '---\nplatforms: [cli]\nrunMode: autonomous\n---\n\n# Review\n\n- [ ] Review frozen source.\n',
  );
  await writeFile(
    path.join(project, 'shared/validation/shared.md'),
    '---\nplatforms: [cli]\nrunMode: autonomous\n---\n\n# Validate changes\n\n- [ ] Execute selected recipes and report coverage.\n',
  );
  const models = [{ runner: 'codex', model: 'gpt-5.6-luna', effort: 'low' }];
  const workspaceExecution = {
    workspacePolicy: { kind: 'exact', machine: 'review-one' },
    transport: 'native',
    models,
  };
  await json(path.join(project, 'project.json'), {
    name: 'review',
    repo_url: 'https://github.com/example/app.git',
    ci: { repo: 'example/app' },
    execution_templates: {
      sources: [{ id: 'workspace:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
    },
    static_review: { template_id: 'review-pr/shared' },
    qa: {
      default_profile: 'pr',
      profiles: [
        { id: 'pr', title: 'PR validation', template_id: 'validation/shared' },
        {
          id: 'daily',
          title: 'Daily changes',
          template_id: 'validation/shared',
          inputs: { window: '24h' },
        },
      ],
    },
    workflow_defaults: {
      'review-pr': {
        execution: workspaceExecution,
        review: {
          validationDepth: 'static-code',
          sessionIntent: 'reset',
          scope: 'full',
          publishReview: true,
        },
      },
    },
  });
  for (const machine of ['review-one', 'review-two'])
    await json(path.join(fixture, 'pool', `${machine}.json`), {
      machine,
      host: 'localhost',
      project: 'review',
      platform: 'cli',
      os: process.platform,
      review_workspaces: { max_concurrent: 3 },
      slots:
        machine === 'review-one'
          ? [
              {
                id: 'qa-disabled',
                enabled: false,
                repo: fixture,
                session: 'interface-qa-disabled',
                resources: {},
              },
            ]
          : [],
    });
  await json(path.join(fixture, '.farm-status.json'), {
    checked_at: new Date().toISOString(),
    slots: [],
  });
  await mkdir(path.join(fixture, 'bin'));
  await writeFile(
    path.join(fixture, 'bin/gh'),
    String.raw`#!/usr/bin/env node
const args=process.argv.slice(2);let body;
if(args[0]==='auth'&&args[1]==='token'){process.stdout.write('fixture-provider-token\n');process.exit(0);}
if(args[0]==='api'&&args.includes('user'))body={login:'fixture-reviewer'};
else if(args[0]==='api'&&args.includes('graphql')){
 const query=args.find(value=>value.startsWith('query='))||'';
 if(!query.startsWith('query=query('))throw new Error('Unknown provider operation');
 const number=Number(args.find(value=>value.startsWith('number='))?.slice(7)??args.find(value=>value.startsWith('id=fixture-pr-'))?.split('-').pop()??42);
 const pr={id:'fixture-pr-'+number,number,title:'Fixture change',state:'OPEN',isDraft:false,headRefOid:'a'.repeat(40),baseRefOid:'b'.repeat(40),baseRefName:'main',headRefName:'fixture-change',author:{login:'fixture-author'},repository:{nameWithOwner:'example/app'},reviewDecision:null,viewerLatestReview:null,viewerLatestReviewRequest:null,labels:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}};
 body={data:{...(query.includes('node(id:')?{node:pr}:{repository:query.includes('pullRequests(')?{pullRequests:{nodes:[pr],pageInfo:{hasNextPage:false,endCursor:null}}}:{pullRequest:pr}}),rateLimit:{cost:1,remaining:4999,resetAt:'2099-01-01T00:00:00Z'}}};
}else throw new Error('Unsupported fixture gh command');
if(args.includes('--include'))process.stdout.write('HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n');
process.stdout.write(JSON.stringify(body));
`,
    { mode: 0o700 },
  );
  const environment = {
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
    FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
    FARMSLOT_CDP_PORT: String(cdpPort),
    FARMSLOT_CDP_PROFILE: path.join(fixture, 'chrome'),
    FARMSLOT_UI_URL: `http://127.0.0.1:${uiPort}/#prs`,
    FARMSLOT_CDP_HEADLESS: '1',
  };
  // Setup provider observations before gateway startup; production store derivation creates the incident.
  const { PRMonitorStore } = await import('../services/gateway/src/pr-monitoring/store.js');
  const monitorStore = await PRMonitorStore.load(path.join(fixture, '.pr-monitors.json'));
  const repairExecution = { slotPolicy: { kind: 'exact' as const, slotId: 'qa-disabled' }, models };
  let seededMonitor = await monitorStore.subscribe('legacy-env', {
    pr: { host: 'github.com', repo: 'example/app', number: 44 },
    account: { host: 'github.com', login: 'fixture-reviewer' },
    project: 'review',
    policy: { mode: 'automatic-repair', execution: repairExecution },
    watchedChecks: [],
    pollIntervalMs: 86_400_000,
    automaticAttemptLimit: 1,
    cooldownMs: 60_000,
  });
  await monitorStore.observe(seededMonitor.id, 'legacy-env', seededMonitor.revision, {
    observation: {
      checkedAt: new Date().toISOString(),
      headSha: 'a'.repeat(40),
      title: 'Repair form fixture',
      author: 'fixture-author',
      state: 'open',
      draft: false,
      mergeability: 'mergeable',
      reviewDecision: 'changes-requested',
      signals: [
        {
          key: 'fixture-review',
          revision: 'one',
          kind: 'review',
          summary: 'Fixture requested changes',
          url: 'https://github.com/example/app/pull/44#pullrequestreview-1',
        },
      ],
    },
  });
  const qaSelection = {
    profile: { id: 'daily', title: 'Daily changes', template_id: 'validation/shared' },
    inputs: { window: '24h' },
  };
  const runBase = {
    familyId: 'ui-family',
    parentRunId: null,
    familyRootTicketOrPr: 'example/app#42',
    lane: 'production',
    variant: null,
    mode: 'autonomous',
    project: 'review',
    ticketOrPr: 'example/app#42',
    slotId: null,
    branch: null,
    taskFile: null,
    createdByPrincipalId: 'legacy-env',
    steps: [],
    decisions: [],
    metrics: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await json(path.join(fixture, 'runs/ui-qa-profile.json'), {
    ...runBase,
    id: 'ui-qa-profile',
    flowType: 'qa',
    status: 'blocked',
    qa: qaSelection,
  });
  await json(path.join(fixture, 'runs/ui-automatic-qa.json'), {
    ...runBase,
    id: 'ui-automatic-qa',
    flowType: 'review-pr',
    status: 'done',
    qaAfterReview: {
      version: 1,
      capturedAt: runBase.createdAt,
      selection: qaSelection,
      review: { workflow: 'qa', sessionIntent: 'reset', scope: 'full' },
      state: 'blocked',
      error: 'Automatic QA is disabled for this farm',
    },
    prWork: {
      kind: 'review',
      id: 'ui-publication',
      sourceId: 'missing-intent',
      pr: { host: 'github.com', repo: 'example/app', number: 42 },
      headSha: 'a'.repeat(40),
      review: {
        profile: 'fixture',
        ownerId: 'legacy-env',
        options: { sessionIntent: 'reset', scope: 'full', publishReview: true },
      },
      publication: {
        enabled: true,
        source: 'farm',
        teamId: 'fixture-team',
        account: { host: 'github.com', login: 'fixture-reviewer' },
      },
    },
    reviewPublication: { error: 'Fixture publication needs retry', checkedAt: runBase.updatedAt },
  });
  const publicationSeed = JSON.parse(
    await readFile(path.join(fixture, 'runs/ui-automatic-qa.json'), 'utf8'),
  );
  await json(path.join(fixture, 'runs/ui-publication-published.json'), {
    ...publicationSeed,
    id: 'ui-publication-published',
    prWork: undefined,
    qaAfterReview: undefined,
    reviewPublication: {
      direct: {
        ownerId: 'legacy-env',
        pr: { host: 'github.com', repo: 'example/app', number: 42 },
        policy: publicationSeed.prWork.publication,
      },
      checkedAt: runBase.updatedAt,
      receipt: {
        version: 1,
        state: 'published',
        runId: 'ui-publication-published',
        ownerId: 'legacy-env',
        account: { host: 'github.com', login: 'fixture-reviewer' },
        pr: { host: 'github.com', repo: 'example/app', number: 42 },
        headSha: 'a'.repeat(40),
        contentSha256: 'b'.repeat(64),
        marker: 'fixture-publication-marker',
        event: 'COMMENT',
        attemptedAt: runBase.createdAt,
        reviewId: 77,
        url: 'https://github.com/example/app/pull/42#pullrequestreview-77',
        publishedAt: runBase.updatedAt,
      },
    },
  });
  let servers = startReviewInterfaceServers({ root, evidence, environment });
  let connection: GatewayConnection | undefined;
  let failure: unknown;
  const cdpFile = path.join(root, 'apps/command-center/scripts/cdp.mjs');
  function cdp(...args: string[]) {
    return execFileSync(process.execPath, [cdpFile, ...args], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }
  // Read-only shadow-root traversal returns existing controls. Writes below are real clicks/input.
  const walk = `function find(selector,root=document,prefix=''){const found=root.querySelector(selector);if(found)return {element:found,path:prefix+selector};for(const element of root.querySelectorAll('*'))if(element.shadowRoot){const result=find(selector,element.shadowRoot,prefix+element.tagName.toLowerCase()+' >>> ');if(result)return result;}return null;}`;
  function evaluate(body: string) {
    return JSON.parse(
      cdp('eval', 'prs', walk + `const value=await (async()=>{${body}})();return {value};`),
    ).value;
  }
  async function waitUI(body: string) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (evaluate(body)) return;
      await delay(250);
    }
    throw new Error(`UI checkpoint missing: ${body}`);
  }
  function click(selector: string) {
    return evaluate(
      `const target=find(${JSON.stringify(selector)})?.element;if(!target||target.disabled||!target.getClientRects().length)throw new Error('Missing or disabled click target');target.click();return true;`,
    );
  }
  function selector(testid: string) {
    return `[data-testid="${testid}"]`;
  }
  function fill(testid: string, value: string) {
    const target = evaluate(`return find(${JSON.stringify(selector(testid))})?.path;`);
    assert(target);
    cdp('fill', 'prs', target, value);
  }
  async function screenshot(name: string) {
    cdp('screenshot', 'prs', path.join(evidence, `${name}.png`));
  }
  async function submissions() {
    return (await connection!.call<PRRulesListResult>('prRules.list')).submissions ?? [];
  }
  async function waitSubmission(count: number) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const values = await submissions();
      if (values.length === count && values.every((value) => value.checkedAt)) {
        for (const value of values) {
          assert.equal(value.error, undefined);
          assert(value.intentId);
        }
        return values;
      }
      await delay(250);
    }
    throw new Error(`Expected ${count} persisted PR submissions`);
  }
  try {
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
    assert(connection);
    const { team } = await connection.call<{ team: PRTeamProfile }>('prRules.teamSave', {
      config: {
        name: 'Example review team',
        account: { host: 'github.com', login: 'fixture-reviewer' },
        sources: [{ kind: 'repository', repo: 'example/app' }],
        predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
        repositories: [
          { repo: 'example/app', project: 'review', reviewProfile: 'standard', excludedLabels: [] },
        ],
        githubTeams: [],
        notificationPrincipalIds: [],
      },
    });
    await json(path.join(evidence, 'team.json'), team);
    await connection.call('prRules.ruleSave', {
      config: {
        name: 'Repair draft validation',
        teamId: team.id,
        predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
        actions: [
          { kind: 'monitor', policy: { mode: 'automatic-repair', execution: repairExecution } },
        ],
        pollIntervalMs: 300_000,
        maxAdmissionsPerScan: 1,
        rereviewOnHeadChange: true,
      },
    });
    const uiReady = Date.now() + 30000;
    while (Date.now() < uiReady) {
      try {
        if ((await fetch(`http://127.0.0.1:${uiPort}`)).ok) break;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
      await delay(200);
    }
    execFileSync('bash', [path.join(root, 'apps/command-center/scripts/debug-chrome.sh')], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      timeout: 30000,
    });
    cdp('viewport', 'prs', '1440', '1100');
    await waitUI(`return Boolean(document.querySelector('.auth-input'));`);
    // Login also uses the same actual browser input helper; no storage or DOM value injection.
    cdp('fill', 'prs', '.auth-input', token);
    evaluate(`document.querySelector('.auth-card').requestSubmit();return true;`);
    await waitUI(`return Boolean(find(${JSON.stringify(selector('pr-automation-tab-reviews'))}));`);
    evaluate(
      `const modal=find('whats-new-modal')?.element;modal?.shadowRoot?.querySelector('button.primary')?.click();return true;`,
    );
    click(selector('pr-automation-tab-reviews'));
    await waitUI(
      `return Boolean(find(${JSON.stringify(selector('pr-workspace-request-review'))}));`,
    );
    click(selector('pr-workspace-request-review'));
    await waitUI(`return Boolean(find(${JSON.stringify(selector('pr-review-request-url'))}));`);
    fill('pr-review-request-url', 'https://github.com/example/app/pull/42');
    await waitUI(
      `return find('pr-review-request-form')?.element.shadowRoot.textContent.includes('Execution:')&&find(${JSON.stringify(selector('pr-review-machine-review-one'))})?.element.checked===true;`,
    );
    const inherited = evaluate(
      `const form=find('pr-review-request-form').element;return {text:form.shadowRoot.textContent,team:find(${JSON.stringify(selector('pr-review-request-team'))}).element.value,machine:find(${JSON.stringify(selector('pr-review-machine-review-one'))}).element.checked};`,
    );
    assert.equal(inherited.team, team.id);
    assert.match(inherited.text, /Execution:\s*farm/);
    assert.equal(inherited.machine, true);
    assert.equal(
      evaluate(`return find('[data-testid="pr-review-publication"]').element.value;`),
      'inherit',
    );
    assert.match(
      evaluate(
        `return find('[data-testid="pr-review-publication-resolved"]').element.textContent;`,
      ),
      /Publish review to PR.*farm/s,
    );

    await json(path.join(evidence, 'inherited.json'), inherited);
    await screenshot('inherited-review');
    click(selector('pr-review-request-submit'));
    const first = (await waitSubmission(1))[0];
    assert.equal(first.request.teamId, team.id);
    assert.equal(first.request.autoStart, false);
    assert.equal(first.request.execution, undefined);
    assert.equal(first.request.review, undefined);
    await json(path.join(evidence, 'inherited-request.json'), first);
    const updatedTeam = await connection.call<{ team: PRTeamProfile }>('prRules.teamSave', {
      id: team.id,
      revision: team.revision,
      config: {
        ...team.config,
        review: {
          sessionIntent: 'reset',
          scope: 'full',
          validationDepth: 'static-code',
          publishReview: true,
        },
      },
    });
    // Policy edits intentionally withdraw old pending authority. Explicitly refresh this request.
    await connection.call('prReview.submit', { request: first.request });
    for (let attempt = 0; attempt < 50; attempt++) {
      const current = await connection.call<PRRulesListResult>('prRules.list');
      const source = current.intents
        .flatMap((intent) => intent.contributions)
        .find((entry) => entry.submissionId === first.id);
      if (source?.eligible && source.teamRevision === updatedTeam.team.revision) break;
      await delay(100);
    }

    // Reopen through the real request button and choose another machine.
    await waitUI(`return Boolean(find(${JSON.stringify(selector('pr-workspace-back'))}));`);
    click(selector('pr-workspace-back'));
    await waitUI(
      `return Boolean(find(${JSON.stringify(selector('pr-workspace-request-review'))})?.element.getClientRects().length);`,
    );
    click(selector('pr-workspace-request-review'));
    await waitUI(`return Boolean(find(${JSON.stringify(selector('pr-review-request-url'))}));`);
    fill('pr-review-request-url', 'https://github.com/example/app/pull/43');
    await waitUI(`return Boolean(find('[data-testid="pr-review-publication"]'));`);
    cdp(
      'select',
      'prs',
      evaluate(`return find('[data-testid="pr-review-publication"]').path;`),
      'publish',
    );
    click(selector('pr-review-workflow-qa'));
    assert.equal(
      evaluate(
        `return find('[data-testid="pr-review-publication"]').element.closest('label').hidden;`,
      ),
      true,
    );
    click(selector('pr-review-workflow-review'));
    await waitUI(`return find('[data-testid="pr-review-publication"]').element.value==='inherit';`);
    cdp(
      'select',
      'prs',
      evaluate(`return find('[data-testid="pr-review-publication"]').path;`),
      'results-only',
    );
    await waitUI(
      `return find('[data-testid="pr-review-publication-resolved"]').element.textContent.includes('Farmslot results only');`,
    );
    await screenshot('publication-override');

    evaluate(
      `const form=find('pr-review-request-form').element.shadowRoot;form.querySelector('[data-testid="pr-review-advanced"]').click();const label=[...form.querySelectorAll('label')].find(label=>label.textContent.includes('Override inherited execution'));if(!label)throw new Error('Missing execution override');label.querySelector('input').click();return true;`,
    );
    click(selector('pr-review-machine-review-two'));
    click(selector('pr-review-machine-review-one'));
    await screenshot('machine-override');
    click(selector('pr-review-request-submit'));
    const second = (await waitSubmission(2)).find((item) => item.id !== first.id)!;
    assert.deepEqual(second.request.execution?.workspacePolicy, {
      kind: 'exact',
      machine: 'review-two',
    });
    assert.equal(second.request.autoStart, false);
    assert.equal(second.request.review?.publishReview, false);
    await json(path.join(evidence, 'machine-request.json'), second);
    // Seed historical shared-review ownership while the fixture gateway is stopped.
    connection.close();
    await servers.stop();
    const storeFile = path.join(fixture, '.pr-rules.json');
    const historical = JSON.parse(await readFile(storeFile, 'utf8'));
    const sourceRule = historical.rules.find((rule: any) => rule.ownerId === 'legacy-env');
    assert(sourceRule);
    for (const number of [42, 43]) {
      for (const owner of ['owned', 'foreign']) {
        const id = `ui-ownership-${owner}-${number}`;
        const updatedAt =
          owner === 'foreign' ? '2026-09-16T00:00:02.000Z' : '2026-09-16T00:00:01.000Z';
        historical.intents.push({
          id,
          pr: { host: 'github.com', repo: 'example/app', number },
          headSha: 'a'.repeat(40),
          reviewProfile: id,
          status: 'completed',
          runId: id,
          createdAt: updatedAt,
          updatedAt,
          contributions: [
            {
              ruleId: sourceRule.id,
              ruleRevision: sourceRule.revision,
              teamId: sourceRule.config.teamId,
              teamRevision: 1,
              ownerId: 'legacy-env',
              reasons: ['Historical shared review fixture'],
              autoStart: false,
              eligible: false,
              configurationErrors: [],
              project: 'review',
              review: { workflow: 'review', sessionIntent: 'reset', scope: 'full' },
            },
          ],
        });
        await json(path.join(fixture, `runs/${id}.json`), {
          ...runBase,
          id,
          ticketOrPr: `example/app#${number}`,
          flowType: 'review-pr',
          status: 'done',
          createdByPrincipalId: owner === 'owned' ? 'legacy-env' : 'another-principal',
          updatedAt,
          reviewResult: {
            recommendation: 'COMMENT',
            reviewMd: 'Historical fixture review',
            lineComments: [],
            reviewSnapshot: { source: 'github-pr', headSha: 'a'.repeat(40), capturedAt: updatedAt },
          },
        });
      }
    }
    await json(storeFile, historical);
    servers = startReviewInterfaceServers({ root, evidence, environment });
    connection = undefined;
    const restartDeadline = Date.now() + 30000;
    while (!connection && Date.now() < restartDeadline) {
      try {
        connection = await client.connect();
      } catch (error) {
        if (!(error instanceof GatewayConnectionError)) throw error;
        await delay(200);
      }
    }
    assert(connection);
    await waitUI(
      `return find('pr-automation-panel')?.element.controller?.reviews?.intents?.some(intent=>intent.id==='ui-ownership-foreign-43');`,
    );
    // Explicit Run QA opens the selected PR with QA preselected.
    await waitUI(`return Boolean(find(${JSON.stringify(selector('pr-run-qa'))}));`);
    click(selector('pr-run-qa'));
    await waitUI(`return Boolean(find(${JSON.stringify(selector('pr-review-request-url'))}));`);
    const selectedOwnedSource = evaluate(
      `return find('pr-review-request-form').element.sourceReviewRunId;`,
    );
    assert.match(
      selectedOwnedSource,
      /^ui-ownership-owned-(42|43)$/,
      'Run QA must select the owned review instead of the newer foreign review',
    );
    await json(path.join(evidence, 'qa-source-ownership.json'), { selectedOwnedSource });
    fill('pr-review-request-url', 'https://github.com/example/app/pull/42');
    assert.equal(
      evaluate(`return find('pr-review-request-form').element.sourceReviewRunId ?? null;`),
      null,
      'Editing the PR clears source review linkage',
    );
    assert.equal(
      evaluate(
        `return find('[data-testid="pr-review-workflow-qa"]').element.getAttribute('aria-pressed');`,
      ),
      'true',
    );
    await waitUI(
      `return find('pr-review-request-form')?.element.shadowRoot.textContent.includes('Needs configuration');`,
    );
    assert.equal(evaluate(`return Boolean(find('[data-testid="pr-review-qa-profile"]'));`), true);
    const profilePath = evaluate(`return find('[data-testid="pr-review-qa-profile"]')?.path;`);
    cdp('select', 'prs', profilePath, 'daily');
    evaluate(
      `find('[data-testid="pr-qa-inputs"]').element.closest('details').querySelector('summary').click();return true;`,
    );
    fill('pr-qa-inputs', '[1]');
    click(selector('pr-review-request-submit'));
    await waitUI(
      `return find('pr-review-request-form').element.shadowRoot.textContent.includes('QA inputs must be a JSON object');`,
    );
    assert.equal((await connection.call<PRRulesListResult>('prRules.list')).submissions?.length, 2);
    fill('pr-qa-inputs', '{"window":"48h"}');

    await screenshot('farm-qa-profile');
    click(selector('pr-review-request-submit'));
    const third = (await waitSubmission(3)).find(
      (item) => item.id !== first.id && item.id !== second.id,
    )!;
    assert.equal(third.request.review?.workflow, 'qa');
    assert.equal(third.request.review?.qaProfileId, 'daily');
    assert.deepEqual(third.request.review?.qaInputs, { window: '48h' });
    assert.equal(third.request.review?.validationDepth, undefined);
    assert.equal(third.request.autoStart, false);
    await json(path.join(evidence, 'runtime-request.json'), third);
    await waitUI(
      `return Boolean(find('[data-testid="pr-workspace-back"]')?.element.getClientRects().length);`,
    );
    click(selector('pr-workspace-back'));
    click(selector('pr-workspace-request-review'));
    await waitUI(`return Boolean(find('[data-testid="pr-review-request-url"]'));`);
    fill('pr-review-request-url', 'https://github.com/example/app/pull/45');
    cdp(
      'select',
      'prs',
      evaluate(`return find('[data-testid="pr-review-publication"]').path;`),
      'publish',
    );
    await waitUI(
      `return /Publish review to PR.*request/s.test(find('[data-testid="pr-review-publication-resolved"]').element.textContent);`,
    );
    click(selector('pr-review-request-submit'));
    const fourth = (await waitSubmission(4)).find(
      (item) => ![first.id, second.id, third.id].includes(item.id),
    )!;
    assert.equal(fourth.request.review?.publishReview, true);
    assert.equal(fourth.request.autoStart, false);
    await json(path.join(evidence, 'publication-positive-request.json'), fourth);
    const state = await connection.call<PRRulesListResult>('prRules.list');
    await json(path.join(evidence, 'pr-state.json'), state);
    const contributions = state.intents.flatMap((intent) => intent.contributions);
    const inheritedContribution = contributions.find((item) => item.submissionId === first.id)!;
    const overrideContribution = contributions.find((item) => item.submissionId === second.id)!;
    const runtimeContribution = contributions.find((item) => item.submissionId === third.id)!;
    assert.deepEqual(inheritedContribution.execution, workspaceExecution);
    assert.equal(inheritedContribution.review?.validationDepth, 'static-code');
    assert.deepEqual(overrideContribution.execution?.workspacePolicy, {
      kind: 'exact',
      machine: 'review-two',
    });
    assert.equal(runtimeContribution.review?.workflow, 'qa');
    assert.equal(runtimeContribution.review?.qaProfileId, 'daily');
    assert.deepEqual(runtimeContribution.review?.qaInputs, { window: '48h' });
    assert.equal(runtimeContribution.execution, undefined);
    await waitUI(`return find('pr-board').element.shadowRoot.textContent.includes('QA pending');`);
    await screenshot('qa-pending-group');
    assert.notEqual(first.intentId, third.intentId);
    assert(
      state.intents
        .filter((intent) => intent.id !== third.intentId && !intent.id.startsWith('ui-ownership-'))
        .every((intent) => intent.status === 'held'),
    );
    assert.equal(
      state.intents.find((intent) => intent.id === third.intentId)?.status,
      'needs-configuration',
    );
    assert.deepEqual(
      (await connection.call<{ runs: Array<{ id: string }> }>('run.list')).runs
        .map((run) => run.id)
        .filter((id) => !id.startsWith('ui-ownership-'))
        .sort(),
      ['ui-automatic-qa', 'ui-publication-published', 'ui-qa-profile'],
    );
    // Clearing the last slot is an incomplete draft, not a rejected edit.
    async function clearRepairDraft(kind: string) {
      click(selector('pr-execution-choose-slots'));
      await waitUI(
        `return Boolean(find('slot-selector-modal')?.element.shadowRoot.querySelector('footer button.secondary')?.getClientRects().length);`,
      );
      evaluate(
        `find('slot-selector-modal').element.shadowRoot.querySelector('footer button.secondary').click();return true;`,
      );
      click(selector('slot-selector-done'));
      await waitUI(
        `const picker=find('pr-execution-picker')?.element;return picker?.value.slotPolicy.kind==='pool'&&picker.value.slotPolicy.allowedSlots.length===0;`,
      );
      await screenshot(kind + '-empty-slots');
    }
    click(selector('pr-workspace-back'));
    click(selector('pr-workspace-automation'));
    await waitUI(`return Boolean(find(${JSON.stringify(selector('pr-rule-edit'))}));`);
    click(selector('pr-rule-edit'));
    await waitUI(`return Boolean(find('pr-rule-form'));`);
    click(selector('pr-rule-action-review'));
    await waitUI(`return Boolean(find('[data-testid="pr-policy-review-override"]'));`);
    click(selector('pr-policy-review-override'));
    assert.equal(
      evaluate(`return find('[data-testid="pr-policy-publication"]').element.value;`),
      'inherit',
    );
    cdp(
      'select',
      'prs',
      evaluate(`return find('[data-testid="pr-policy-publication"]').path;`),
      'results-only',
    );
    await screenshot('rule-publication');
    click(selector('pr-rule-save'));
    await waitUI(
      `return Boolean(find('[data-testid="pr-rule-edit"]')?.element.getClientRects().length);`,
    );
    const savedPublicationRules = await connection.call<PRRulesListResult>('prRules.list');
    const savedPublicationRule = savedPublicationRules.rules.find(
      (rule) => rule.config.name === 'Repair draft validation',
    )!;
    assert.equal(
      savedPublicationRule.config.actions.find((action) => action.kind === 'review')?.review
        ?.publishReview,
      false,
    );
    await json(path.join(evidence, 'rule-publication.json'), savedPublicationRule);
    click(selector('pr-rule-edit'));
    await waitUI(`return Boolean(find('pr-rule-form'));`);
    await clearRepairDraft('rule');
    click(selector('pr-rule-save'));
    await waitUI(
      `return find('pr-rule-form')?.element.shadowRoot.textContent.includes('must be an array');`,
    );
    click(selector('pr-automation-editor-close'));
    click(selector('pr-workspace-prs'));
    click(selector('pr-automation-tab-monitors'));
    await waitUI(`return Boolean(find('[data-monitor-ids="${seededMonitor.id}"]'));`);
    click(`[data-monitor-ids="${seededMonitor.id}"]`);
    await waitUI(
      `return Boolean(find(${JSON.stringify(selector('pr-monitor-edit'))})?.element.getClientRects().length);`,
    );
    click(selector('pr-monitor-edit'));
    await waitUI(`return Boolean(find('pr-monitor-form'));`);
    await clearRepairDraft('monitor');
    click(selector('pr-monitor-save'));
    await waitUI(
      `return find('pr-monitor-form')?.element.shadowRoot.textContent.includes('must be an array');`,
    );
    click(selector('pr-automation-editor-close'));
    click(selector('pr-monitor-repair'));
    await waitUI(`return Boolean(find(${JSON.stringify(selector('pr-agent-repair-form'))}));`);
    await clearRepairDraft('repair');
    evaluate(
      `find(${JSON.stringify(selector('pr-agent-repair-form'))}).element.querySelector('button[type="submit"]').click();return true;`,
    );
    await waitUI(
      `return find('pr-automation-panel')?.element.shadowRoot.textContent.includes('must be an array');`,
    );
    assert.deepEqual(
      (await connection.call<{ runs: Array<{ id: string }> }>('run.list')).runs
        .map((run) => run.id)
        .filter((id) => !id.startsWith('ui-ownership-'))
        .sort(),
      ['ui-automatic-qa', 'ui-publication-published', 'ui-qa-profile'],
    );
    for (const [id, testid, expected] of [
      ['ui-qa-profile', 'run-qa-profile', 'Daily changes'],
      ['ui-automatic-qa', 'run-automatic-qa', 'Automatic QA is disabled'],
    ]) {
      cdp('goto', `http://127.0.0.1:${uiPort}/#runs?run=${id}`);
      const deadline = Date.now() + 30000;
      let text = '';
      while (Date.now() < deadline) {
        text = JSON.parse(
          cdp(
            'eval',
            'runs',
            walk +
              `return { value: find('[data-testid="${testid}"]')?.element.textContent ?? '' };`,
          ),
        ).value;
        if (text.includes(expected)) break;
        await delay(200);
      }
      assert(text.includes(expected), `Missing run context ${testid}: ${text}`);
      if (id === 'ui-qa-profile') {
        const badge = JSON.parse(
          cdp(
            'eval',
            'runs',
            walk + `return {label:find('[data-testid="runs-flow"]').element.textContent.trim()};`,
          ),
        );
        assert.equal(badge.label, 'QA');
        const filter = JSON.parse(
          cdp(
            'eval',
            'runs',
            walk + `return {path:find('[data-testid="runs-flow-filter"]').path};`,
          ),
        );
        cdp('select', 'runs', filter.path, 'qa');
        const selected = JSON.parse(
          cdp(
            'eval',
            'runs',
            walk +
              `return {value:find('[data-testid="runs-flow-filter"]').element.value,hash:location.hash};`,
          ),
        );
        assert.equal(selected.value, 'qa');
        assert.match(selected.hash, /flow=qa/);
        cdp('screenshot', 'runs', path.join(evidence, 'qa-flow-filter.png'));
        cdp('select', 'runs', filter.path, '');
      }

      cdp('screenshot', 'runs', path.join(evidence, testid + '.png'));
    }

    const publicationEvents: unknown[] = [];
    const unsubscribePublication = connection.onEvent((event) => {
      const run = (
        event.payload as { run?: { id: string; reviewPublication?: unknown } } | undefined
      )?.run;
      if (event.event === 'run.updated' && run?.id === 'ui-automatic-qa')
        publicationEvents.push(run.reviewPublication);
    });
    const publicationBefore = JSON.parse(
      cdp(
        'eval',
        'runs',
        walk + `return {text:find('[data-testid="run-review-publication"]').element.textContent};`,
      ),
    ).text;
    assert.match(publicationBefore, /Needs attention/);
    assert.match(publicationBefore, /fixture-reviewer/);
    cdp(
      'eval',
      'runs',
      walk +
        `const button=find('[data-testid="run-review-publication-retry"]').element;if(button.disabled)throw new Error('Retry is disabled');button.click();return true;`,
    );
    let publicationText = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      publicationText = JSON.parse(
        cdp(
          'eval',
          'runs',
          walk +
            `return {text:find('[data-testid="run-review-publication"]').element.textContent};`,
        ),
      ).text;
      if (publicationText.includes('Only a completed workspace static review')) break;
      await delay(200);
    }
    assert.match(publicationText, /Only a completed workspace static review/);
    const publicationRun = await connection.call<any>('run.get', { runId: 'ui-automatic-qa' });
    assert.match(
      publicationRun.run.reviewPublication.error,
      /Only a completed workspace static review/,
    );
    unsubscribePublication();
    assert(publicationEvents.length > 0, 'Publication update event missing');
    await json(path.join(evidence, 'publication-events.json'), publicationEvents);
    await json(path.join(evidence, 'publication-retry-error.json'), {
      ui: publicationText,
      stored: publicationRun.run.reviewPublication,
    });
    cdp('screenshot', 'runs', path.join(evidence, 'publication-retry-error.png'));
    cdp('eval', 'runs', `location.hash='#runs?run=ui-publication-published';return true;`);
    let publishedText = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      publishedText = JSON.parse(
        cdp(
          'eval',
          'runs',
          walk +
            `return {text:find('[data-testid="run-review-publication"]')?.element.textContent ?? ''};`,
        ),
      ).text;
      if (publishedText.includes('Published')) break;
      await delay(200);
    }
    assert.match(publishedText, /Published/);
    const publishedControls = JSON.parse(
      cdp(
        'eval',
        'runs',
        walk +
          `return {retry:Boolean(find('[data-testid="run-review-publication-retry"]')),url:find('[data-testid="run-review-publication"]')?.element.querySelector('a')?.href};`,
      ),
    );
    assert.equal(publishedControls.retry, false);
    assert.equal(
      publishedControls.url,
      'https://github.com/example/app/pull/42#pullrequestreview-77',
    );
    cdp('screenshot', 'runs', path.join(evidence, 'publication-published.png'));

    console.log(
      JSON.stringify({
        passed: true,
        evidence,
        submissions: [first.id, second.id, third.id, fourth.id],
        teamId: team.id,
      }),
    );
  } catch (error) {
    failure = error;
    await json(path.join(evidence, 'failure.json'), {
      error: String(error),
      fixture,
      uiPort,
      gatewayPort,
      cdpPort,
    });
    try {
      await screenshot('failure');
    } catch (screenshotError) {
      await json(path.join(evidence, 'screenshot-error.json'), { error: String(screenshotError) });
    }
  } finally {
    connection?.close();
    try {
      const lock = await readlink(path.join(fixture, 'chrome/SingletonLock'));
      const pid = Number(lock.split('-').at(-1));
      assert(Number.isInteger(pid) && pid > 0);
      assert(
        matchesProcess(pid, '--user-data-dir=' + path.join(fixture, 'chrome')),
        'Chrome no longer owns the fixture profile',
      );
      const tree = new NativeProcessTree(pid);
      tree.terminate();
      const deadline = Date.now() + 5000;
      while (!tree.empty() && Date.now() < deadline) await delay(100);
      if (!tree.empty()) tree.stop();
      const killedBy = Date.now() + 5000;
      while (!tree.empty() && Date.now() < killedBy) await delay(100);
      assert(tree.empty(), 'Fixture Chrome process cleanup is unconfirmed');
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
        (error as NodeJS.ErrnoException).code !== 'ESRCH'
      )
        failure = new AggregateError(
          [...(failure ? [failure] : []), error],
          'Chrome cleanup failed',
        );
    }
    await servers.stop();
    await rm(fixture, { recursive: true, force: true });
  }
  if (failure) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();

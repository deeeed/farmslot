import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

import { withOwnedGatewayOffline } from './owned-gateway-outage.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const probe = fileURLToPath(new URL('./probes/offline-planning.js', import.meta.url));
assert.equal(await realpath(process.cwd()), await realpath(root), 'Run from the reviewed checkout');
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
for (const key of ['GATEWAY_PORT', 'VITE_PORT', 'FARMSLOT_CDP_PORT'])
  assert(/^\d+$/.test(process.env[key] ?? ''), `Select the isolated ${key}`);
assert(
  process.env.FARMSLOT_HOME && process.env.FARMSLOT_ROOT && process.env.FARMSLOT_GATEWAY_PROFILE,
);
assert(process.env.FARMSLOT_PLANNING_PROOF_ARTIFACTS, 'Select a fresh planning evidence directory');
const home = await realpath(process.env.FARMSLOT_HOME);
const farmRoot = await realpath(process.env.FARMSLOT_ROOT);
assert.notEqual(farmRoot, root, 'Never use the implementation checkout as the proof farm');
assert.notEqual(home, path.parse(home).root, 'Select an isolated proof home');
assert.notEqual(farmRoot, path.parse(farmRoot).root, 'Select an isolated proof farm');
const profile = await automationGatewayTarget();
const gatewayUrl = new URL(profile.url);
assert(['localhost', '127.0.0.1', '[::1]'].includes(gatewayUrl.hostname));
assert.equal(Number(gatewayUrl.port), Number(process.env.GATEWAY_PORT));
const listener = await execute('lsof', ['-nP', '-t', `-iTCP:${gatewayUrl.port}`, '-sTCP:LISTEN']);
const pid = Number(listener.stdout.trim());
assert(Number.isSafeInteger(pid) && pid > 0, 'Expected one isolated gateway listener');
const cwd = await execute('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
assert(
  cwd.stdout.split('\n').includes(`n${root}/services/gateway`),
  'Use the gateway for this checkout',
);
const artifacts = path.resolve(process.env.FARMSLOT_PLANNING_PROOF_ARTIFACTS);
await mkdir(artifacts, { recursive: true });
const project = process.env.FARMSLOT_PLANNING_PROOF_PROJECT;
assert(/^offline-planning-[a-z0-9-]+$/.test(project), 'Select a disposable configured project');
const stateFile = path.join(artifacts, 'planning-proof-state.json');
const cdpFile = path.join(root, 'apps/command-center/scripts/cdp.mjs');
const cdp = async (...args) =>
  JSON.parse(
    (
      await execute(process.execPath, [cdpFile, ...args], {
        timeout: 65000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout,
  );
const rpc = (method, params = {}) => cdp('gateway', method, JSON.stringify(params));
let route;
async function navigate(hash, { freshDocument = false } = {}) {
  route = hash;
  const url = new URL(process.env.FARMSLOT_UI_URL);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(Number(url.port), Number(process.env.VITE_PORT));
  url.searchParams.set('planning-proof', path.basename(artifacts));
  if (freshDocument) url.searchParams.set('planning-cold-document', randomUUID());
  url.hash = route;
  await cdp('goto', url.href);
  await cdp('focus', route);
}
const snapshot = () => cdp('eval', route, '--file', probe);
async function until(accepts, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await snapshot();
    if (accepts(value)) return value;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
const observation = (value, method) => value.observations?.[method];
const row = (value, method, id) =>
  observation(value, method)?.rows.find((entry) => entry.id === id);
const ready = (method) =>
  until((value) => observation(value, method)?.ready, `${method} must be current`);
async function screenshot(name) {
  await cdp('screenshot', route, path.join(artifacts, `${name}.png`));
}
const fixtures = {};
const receipts = {};
async function setup() {
  assert(
    !(await rpc('backlog.list')).items.some((item) => item.project === project),
    'Use an empty disposable project',
  );
  fixtures.backlog = (
    await rpc('backlog.create', {
      project,
      title: `Planning ${randomUUID()}`,
      sourceKind: 'manual',
      flowType: 'dev',
    })
  ).item;
  fixtures.roadmap = (
    await rpc('roadmap.save', {
      item: { project, title: `Roadmap ${randomUUID()}`, body: 'Owned planning proof body.' },
    })
  ).item;
  fixtures.graph = (
    await rpc('workGraph.create', { project, title: `Graph ${randomUUID()}` })
  ).graph.graph;
  fixtures.queue = (
    await rpc('dispatch.queue.add', {
      project,
      flowType: 'dev',
      ticketOrPr: fixtures.backlog.sourceRef,
      priority: 7,
    })
  ).item;
  await rpc('workGraph.addNode', {
    graphId: fixtures.graph.id,
    id: 'backlog-proof',
    kind: 'backlog',
    backlogItemId: fixtures.backlog.id,
  });
  await writeFile(stateFile, JSON.stringify(fixtures, null, 2), { flag: 'wx', mode: 0o600 });
}
async function writers() {
  await navigate(`backlog?projects=${project}&item=${fixtures.backlog.id}`);
  await ready('backlog.list');
  const title = `External backlog ${randomUUID()}`;
  await rpc('backlog.update', { itemId: fixtures.backlog.id, title });
  await until(
    (value) =>
      row(value, 'backlog.list', fixtures.backlog.id)?.title === title &&
      value.renderedRows.some((entry) => entry.text.includes(title)),
    'External backlog write must update the existing planning row',
  );
  await screenshot('backlog-external-write');
  await navigate(`backlog?projects=${project}&backlogStatus=archived&item=${fixtures.backlog.id}`);
  await ready('backlog.list');
  const filtered = await snapshot();
  assert(
    row(filtered, 'backlog.list', fixtures.backlog.id),
    'Filtering must not replace the persisted full backlog collection',
  );
  assert(
    !filtered.renderedRows.some((entry) => entry.id === fixtures.backlog.id),
    'The active status filter must exclude the unarchived candidate',
  );
  assert.equal(
    filtered.selectedId,
    fixtures.backlog.id,
    'A filter cannot confirm deletion or discard the URL selection',
  );
  receipts.filteredMembership = true;
  await navigate(`roadmap?projects=${project}&item=${fixtures.roadmap.id}`);
  await ready('roadmap.list');
  const item = (await rpc('roadmap.get', { itemId: fixtures.roadmap.id })).item;
  const updated = (
    await rpc('roadmap.save', {
      expectedHash: item.fileHash,
      item: { ...item, title: `External roadmap ${randomUUID()}` },
    })
  ).item;
  await until(
    (value) =>
      row(value, 'roadmap.list', item.id)?.fileHash === updated.fileHash &&
      value.renderedRows.some((entry) => entry.text.includes(updated.title)),
    'External roadmap save must update authored content and rendered membership',
  );
  fixtures.roadmap = updated;
  await screenshot('roadmap-external-write');
  await navigate(`work-graphs?projects=${project}&graph=${fixtures.graph.id}`);
  await ready('workGraph.list');
  await rpc('workGraph.addNode', {
    graphId: fixtures.graph.id,
    id: 'reference-proof',
    kind: 'reference',
    reference: { kind: 'manual', ref: 'proof-only', title: 'Owned dependency', status: 'pending' },
  });
  await cdp('click', route, '[data-testid="work-graph-diagram-node-reference-proof"]');
  await until(
    (value) =>
      row(value, 'workGraph.list', fixtures.graph.id)?.nodeIds.includes('reference-proof') &&
      value.graphNode?.rendered &&
      value.graphNode.text.includes('Owned dependency'),
    'External graph structure must update the canonical collection and rendered dependency node',
  );
  // Read the source projection as well as the rendered canonical collection.
  assert(
    (await rpc('workGraph.get', { graphId: fixtures.graph.id })).graph.nodes.some(
      (node) => node.id === 'reference-proof',
    ),
  );
  await rpc('workGraph.pause', { graphId: fixtures.graph.id });
  await until(
    (value) =>
      row(value, 'workGraph.list', fixtures.graph.id)?.status === 'paused' &&
      value.graphStatus === 'paused' &&
      value.graphNode?.rendered,
    'External graph lifecycle must update the canonical graph and rendered paused badge',
  );
  await screenshot('graph-external-write');
  await navigate(`dispatch?projects=${project}`);
  await ready('dispatch.queue.list');
  await rpc('dispatch.queue.update', { itemId: fixtures.queue.id, priority: 3 });
  const queued = await until(
    (value) =>
      row(value, 'dispatch.queue.list', fixtures.queue.id)?.priority === 3 &&
      value.queueRows.some(
        (entry) =>
          entry.text.includes(project) &&
          entry.text.includes(fixtures.queue.ticketOrPr) &&
          entry.priority === '3',
      ),
    'External queue update must replace the canonical row and rendered priority control',
  );
  const queueIndex = queued.queueRows.find(
    (entry) => entry.text.includes(project) && entry.text.includes(fixtures.queue.ticketOrPr),
  ).index;
  // The committed click helper scrolls the real label into view before dispatching input.
  await cdp('click', route, `.queue-shell .rows .row:nth-child(${queueIndex + 1}) .label`);
  await until(
    (value) =>
      value.queueRows.some(
        (entry) => entry.index === queueIndex && entry.priority === '3' && entry.viewportVisible,
      ),
    'The changed queue row must be visible in the screenshot viewport',
  );
  await screenshot('queue-external-write');
  const idle = await cdp(
    'idle-reads',
    route,
    '11000',
    JSON.stringify([
      'backlog.list',
      'roadmap.list',
      'roadmap.get',
      'workGraph.list',
      'dispatch.queue.list',
    ]),
  );
  assert.equal(idle.total, 0, 'A settled planning client must send no periodic reads');
  receipts.externalRpcWriters = true;
}
async function draftError() {
  await navigate(`roadmap?projects=${project}&item=${fixtures.roadmap.id}&mode=edit`);
  await ready('roadmap.list');
  const draft = `Unsaved operator draft ${randomUUID()}`;
  await cdp('fill', route, 'roadmap-panel >>> [data-testid="roadmap-edit-body"]', draft);
  const before = await snapshot();
  const file = path.resolve(farmRoot, fixtures.roadmap.filePath);
  assert(
    file.startsWith(`${process.env.FARMSLOT_ROADMAP_DIR ?? path.join(farmRoot, '.roadmap')}/`),
  );
  const mode = (await stat(file)).mode & 0o777;
  try {
    await chmod(file, 0);
    await rpc('backlog.update', {
      itemId: fixtures.backlog.id,
      notes: `Force real delivery I/O ${randomUUID()}`,
    });
    await until(
      (value) =>
        observation(value, 'roadmap.list')?.error &&
        value.errorText &&
        value.selectedId === fixtures.roadmap.id &&
        value.editorBody === draft &&
        value.editorHash === before.editorHash,
      'A real projection read error must retain selection, draft, and conditional-save base',
    );
    await screenshot('roadmap-read-error-draft');
    await withOwnedGatewayOffline(async () => {
      await until(
        (value) =>
          value.connection !== 'connected' &&
          value.selectedId === fixtures.roadmap.id &&
          value.editorBody === draft &&
          value.mutationButtons.length > 0 &&
          value.mutationButtons.every((button) => button.disabled),
        'Disconnect after failed I/O must preserve the draft and block actual mutation buttons',
      );
      await screenshot('roadmap-disconnected-draft');
      await chmod(file, mode);
    });
    await ready('roadmap.list');
    assert.equal(
      (await snapshot()).editorBody,
      draft,
      'Reconnect cannot replace an unsaved editor draft',
    );
  } finally {
    await chmod(file, mode);
  }
  receipts.readErrorDraftAndDisconnect = true;
}
async function cold() {
  const observations = {};
  const views = [
    ['backlog', 'backlog.list', fixtures.backlog.id],
    ['roadmap', 'roadmap.list', fixtures.roadmap.id],
    ['work-graphs', 'workGraph.list', fixtures.graph.id],
    ['dispatch', 'dispatch.queue.list', fixtures.queue.id],
  ];
  for (const [name, method, id] of views) {
    const hash = `${name}?projects=${project}${name === 'backlog' || name === 'roadmap' ? `&item=${id}` : name === 'work-graphs' ? `&graph=${id}&node=backlog-proof` : ''}`;
    await navigate(hash);
    await ready(method);
    const stored = await cdp(
      'eval',
      route,
      `function find(root){const panel=root.querySelector('backlog-panel,roadmap-panel,work-graph-panel,dispatch-queue-panel');if(panel)return panel;for(const node of root.querySelectorAll('*'))if(node.shadowRoot){const nested=find(node.shadowRoot);if(nested)return nested;}} const panel=find(document); const field=${JSON.stringify({ backlog: '_backlogQuery', roadmap: '_listQuery', 'work-graphs': 'graphQuery', dispatch: '_queueQuery' }[name])}; return (await import('/src/dev/resource-authority-proof.ts')).inspectResourceAuthority(undefined,Reflect.get(Reflect.get(panel,field),'query'));`,
    );
    assert(
      stored.persistent && stored.storedObservedAt === stored.cacheObservedAt,
      'A real SQLite row must be durable before cold proof',
    );
    observations[name] = { stored, before: await snapshot() };
    await writeFile(
      path.join(artifacts, 'planning-cold-observations.json'),
      JSON.stringify(observations, null, 2),
    );
    await withOwnedGatewayOffline(async () => {
      await navigate(hash, { freshDocument: true });
      observations[name].cold = await until(
        (value) =>
          value.timeOrigin !== observations[name].before.timeOrigin &&
          observation(value, method)?.status === 'stale' &&
          observation(value, method)?.observedAt === stored.storedObservedAt &&
          row(value, method, id) &&
          value.staleText.includes('Saved') &&
          value.mutationButtons.length > 0 &&
          value.mutationButtons.every((button) => button.disabled),
        'Cold offline planning must render saved rows and age with commands disabled',
      );
      await screenshot(`${name}-cold-offline`);
    });
    observations[name].recovered = await ready(method);
    await writeFile(
      path.join(artifacts, 'planning-cold-observations.json'),
      JSON.stringify(observations, null, 2),
    );
  }
  receipts.coldFourCollections = true;
}
async function rawFile() {
  await navigate(`roadmap?projects=${project}&item=${fixtures.roadmap.id}`);
  await ready('roadmap.list');
  const file = path.resolve(farmRoot, fixtures.roadmap.filePath);
  const bytes = await readFile(file, 'utf8');
  const id = `ri_${randomUUID().replaceAll('-', '')}`;
  const external = path.join(path.dirname(file), `${id}.md`);
  const temporary = `${external}.tmp`;
  const before = await snapshot();
  const observations = { before };
  const document = (title) =>
    bytes
      .replace(/^id: .*$/m, `id: ${JSON.stringify(id)}`)
      .replace(/^title: .*$/m, `title: ${JSON.stringify(title)}`);
  let created = false;
  let temporaryCreated = false;
  const rendered = (value, title) =>
    value.connectionId === before.connectionId &&
    observation(value, 'roadmap.list')?.ready &&
    row(value, 'roadmap.list', id)?.title === title &&
    value.renderedRows.some((entry) => entry.id === id && entry.text.includes(title));
  try {
    const title = `Raw source create ${id}`;
    await writeFile(external, document(title), { flag: 'wx' });
    created = true;
    // No RPC, restart, retry, navigation or other invalidation may help these assertions.
    observations.created = await until(
      (value) => rendered(value, title),
      'A raw roadmap file create must reach the open collection and rendered row',
      5000,
    );
    await screenshot('roadmap-raw-create');
    receipts.rawRoadmapCreate = true;
    const edited = `Raw source edit ${id}`;
    await writeFile(external, document(edited));
    observations.edited = await until(
      (value) => rendered(value, edited),
      'A raw roadmap file edit must reach the same mounted collection and rendered row',
      5000,
    );
    await screenshot('roadmap-raw-edit');
    receipts.rawRoadmapEdit = true;
    const replaced = `Raw atomic replacement ${id}`;
    await writeFile(temporary, document(replaced), { flag: 'wx' });
    temporaryCreated = true;
    await rename(temporary, external);
    temporaryCreated = false;
    observations.replaced = await until(
      (value) => rendered(value, replaced),
      'An atomic roadmap file replacement must reach the same mounted collection and rendered row',
      5000,
    );
    await screenshot('roadmap-raw-replace');
    receipts.rawRoadmapReplace = true;
    await rm(external);
    created = false;
    observations.deleted = await until(
      (value) =>
        value.connectionId === before.connectionId &&
        observation(value, 'roadmap.list')?.ready &&
        !row(value, 'roadmap.list', id) &&
        !value.renderedRows.some((entry) => entry.id === id),
      'A raw roadmap file deletion must remove the canonical and rendered row without Refresh',
      5000,
    );
    await screenshot('roadmap-raw-delete');
    receipts.rawRoadmapDelete = true;
  } finally {
    if (temporaryCreated) await rm(temporary);
    if (created) await rm(external);
    await writeFile(
      path.join(artifacts, 'raw-file-observations.json'),
      JSON.stringify(observations, null, 2),
    );
  }
}
async function configuration() {
  const directory = await realpath(process.env.FARMSLOT_PROJECTS_DIR);
  const file = path.join(directory, project, 'project.json');
  const original = await readFile(file, 'utf8');
  const source = JSON.parse(original);
  assert.equal(source.name, project, "Only change this case's disposable project");
  const temporary = `${file}.tmp`;
  const budgetProject = `${project}-budget`;
  const budgetDirectory = path.join(directory, budgetProject);
  const budgetFile = path.join(budgetDirectory, 'project.json');
  const canary = randomUUID();
  const evidence = {};
  const backups = new Set();
  const hash = `config/project/${project}`;
  const inspect = () =>
    cdp(
      'eval',
      route,
      "const panel=document.querySelector('config-panel');if(!panel)throw Error('Mount actual configuration');return (await import('/src/dev/resource-authority-proof.ts')).inspectResourceAuthority(undefined,Reflect.get(Reflect.get(panel,'_projectsQuery'),'query'));",
    );
  const durable = async (accepts, label) => {
    const deadline = Date.now() + 15000;
    let value;
    do {
      value = await inspect();
      if (accepts(value)) return value;
      await delay(100);
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(value)}`);
  };
  const renderBranch = (branch, connectionId) =>
    until(
      (value) =>
        value.connectionId === connectionId &&
        observation(value, 'config.projects')?.ready &&
        row(value, 'config.projects', project)?.defaultBranch === branch &&
        value.configuration?.info.includes(branch),
      'An external project file must update the mounted configuration without Refresh',
    );
  let budgetCreated = false;
  try {
    await navigate(hash);
    if (
      await cdp(
        'eval',
        route,
        "return Boolean(document.querySelector('global-filter-bar')?.shadowRoot?.querySelector('.clear-btn'))",
      )
    )
      await cdp('click', route, 'global-filter-bar >>> .clear-btn');
    const before = await ready('config.projects');
    evidence.before = before;
    const edited = {
      ...source,
      default_branch: `external-${randomUUID()}`,
      webhooks: { ...source.webhooks, github_secret: canary, jira_secret: canary },
    };
    await writeFile(file, JSON.stringify(edited));
    evidence.edited = await renderBranch(edited.default_branch, before.connectionId);
    await screenshot('configuration-external-project-edit');
    edited.default_branch = `atomic-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(edited), { flag: 'wx' });
    await rename(temporary, file);
    evidence.replaced = await renderBranch(edited.default_branch, before.connectionId);
    await screenshot('configuration-atomic-project-replace');
    const mutation = await rpc('config.project.autoRecovery.update', {
      project,
      autoRecovery: { enabled: true },
    });
    assert.equal(path.dirname(mutation.backup), path.dirname(file));
    assert(path.basename(mutation.backup).startsWith('project.json.bak.'));
    backups.add(mutation.backup);
    for (const reply of [
      mutation,
      await rpc('config.projects'),
      await rpc('config.project', { project }),
    ])
      assert(
        !JSON.stringify(reply).includes(canary),
        'Client project replies must omit declared webhook credentials',
      );
    evidence.secretExcludedFromRpc = true;
    evidence.policy = await until(
      (value) =>
        value.connectionId === before.connectionId &&
        observation(value, 'config.projects')?.ready &&
        row(value, 'config.projects', project)?.autoRecoveryEnabled === true &&
        value.configuration?.autoRecoveryEnabled === true,
      'A second-client policy write must update the actual clean configuration form',
    );
    await screenshot('configuration-second-client-policy');
    await cdp('click', route, '.cp-auto-recovery-section input[type="checkbox"]');
    await until(
      (value) =>
        value.configuration?.autoRecoveryEnabled === false &&
        value.mutationButtons.some(
          (button) => button.text === 'Save Auto-Recovery' && !button.disabled,
        ),
      'Edit the actual policy control before testing draft retention',
    );
    const repeated = await rpc('config.project.autoRecovery.update', {
      project,
      autoRecovery: { enabled: true },
    });
    assert.equal(path.dirname(repeated.backup), path.dirname(file));
    assert(path.basename(repeated.backup).startsWith('project.json.bak.'));
    backups.add(repeated.backup);
    evidence.draft = await until(
      (value) =>
        observation(value, 'config.projects')?.ready &&
        observation(value, 'config.projects').observedAt >
          observation(evidence.policy, 'config.projects').observedAt &&
        row(value, 'config.projects', project)?.autoRecoveryEnabled === true &&
        value.configuration?.autoRecoveryEnabled === false,
      'An external configuration update must preserve an actual unsaved policy draft',
    );
    await screenshot('configuration-unsaved-policy-retained');
    await cdp('click', route, '.cp-sidebar-item.active');
    await until(
      (value) =>
        value.configuration?.autoRecoveryEnabled === true &&
        value.mutationButtons.every((button) => button.disabled),
      'Selecting the project again discards the draft through its normal UI action',
    );
    receipts.configurationWriters = true;

    await mkdir(budgetDirectory);
    budgetCreated = true;
    const budget = 2 * 1024 * 1024;
    const writeBudget = (bytes) =>
      writeFile(
        budgetFile,
        JSON.stringify({
          name: budgetProject,
          default_branch: 'main',
          hooks: { health_check: `# ${'x'.repeat(bytes)}` },
        }),
      );
    await writeBudget(budget - 64 * 1024);
    await until(
      (value) =>
        observation(value, 'config.projects')?.ready &&
        row(value, 'config.projects', budgetProject) &&
        value.configuration?.labels.includes(budgetProject),
      'A newly configured project must appear in the open selector',
    );
    evidence.below = await durable(
      (value) =>
        value.persistent &&
        value.storedBytes > budget - 64 * 1024 &&
        value.storedBytes <= budget &&
        value.storedDataSha256 === value.cacheDataSha256,
      'Persist the actual complete project collection below the aggregate 2 MiB bound',
    );
    evidence.warm = await snapshot();
    await withOwnedGatewayOffline(async () => {
      await navigate(hash, { freshDocument: true });
      evidence.cold = await until(
        (value) =>
          value.timeOrigin !== evidence.warm.timeOrigin &&
          observation(value, 'config.projects')?.status === 'stale' &&
          observation(value, 'config.projects')?.observedAt === evidence.below.storedObservedAt &&
          row(value, 'config.projects', project) &&
          row(value, 'config.projects', budgetProject) &&
          value.configuration?.info.includes(edited.default_branch) &&
          value.staleText.includes('Saved projects') &&
          value.mutationButtons.length > 0 &&
          value.mutationButtons.every((button) => button.disabled),
        'A new offline document must render exact saved projects and age with actual writes disabled',
      );
      evidence.coldSqlite = await inspect();
      assert.equal(evidence.coldSqlite.cacheDataSha256, evidence.below.storedDataSha256);
      await screenshot('configuration-cold-below-bound');
    });
    await ready('config.projects');
    await writeBudget(budget + 64 * 1024);
    const online = await rpc('config.projects');
    assert(
      Buffer.byteLength(JSON.stringify(online)) > budget,
      'Use an actual oversized configuration collection',
    );
    evidence.above = await durable(
      (value) =>
        value.cacheStatus === 'ready' &&
        value.cacheHasData &&
        value.cacheDataSha256 !== evidence.below.cacheDataSha256 &&
        value.storedObservedAt === undefined,
      'An oversized online project result must evict its previous SQLite collection',
    );
    const aboveWarm = await snapshot();
    await withOwnedGatewayOffline(async () => {
      await navigate(hash, { freshDocument: true });
      evidence.aboveCold = await until(
        (value) =>
          value.timeOrigin !== aboveWarm.timeOrigin &&
          observation(value, 'config.projects') &&
          !observation(value, 'config.projects').dataPresent &&
          !row(value, 'config.projects', project) &&
          !value.configuration?.labels.includes(budgetProject),
        'The evicted oversized collection must be absent from a new offline document',
      );
      assert.equal((await inspect()).storedObservedAt, undefined);
      await screenshot('configuration-cold-above-bound');
    });
    await ready('config.projects');
    await rm(budgetFile);
    await rmdir(budgetDirectory);
    budgetCreated = false;
    await until(
      (value) =>
        observation(value, 'config.projects')?.ready &&
        !row(value, 'config.projects', budgetProject) &&
        !value.configuration?.labels.includes(budgetProject),
      'Deleted project registration must leave the same mounted selector',
    );
    evidence.restored = await durable(
      (value) =>
        value.storedObservedAt !== undefined &&
        value.storedBytes < budget &&
        value.storedDataSha256 === value.cacheDataSha256,
      'Normal configuration persistence must recover after the collection shrinks',
    );
    receipts.configurationProjectsBound = true;
  } finally {
    await rm(temporary, { force: true });
    if (budgetCreated) await rm(budgetDirectory, { recursive: true });
    await writeFile(file, original);
    evidence.backupCleanup = [];
    for (const backup of backups) {
      const bytes = await readFile(backup);
      const saved = JSON.parse(bytes);
      assert.equal(saved.name, project);
      assert.equal(saved.webhooks?.github_secret, canary);
      evidence.backupCleanup.push({
        file: path.basename(backup),
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      await rm(backup);
    }
    await writeFile(
      path.join(artifacts, 'configuration-observations.json'),
      JSON.stringify(evidence, null, 2),
    );
  }
}
async function authority() {
  assert(
    process.env.FARMSLOT_PLANNING_PROOF_ACTOR,
    'Select an already signed-in disposable planning actor',
  );
  const actor = JSON.parse(await readFile(process.env.FARMSLOT_PLANNING_PROOF_ACTOR, 'utf8'));
  const principals = (await rpc('principal.list')).principals;
  const principal = principals.find((entry) => entry.id === actor.principalId);
  assert(
    principal?.subject.type === 'service' &&
      /^Offline (planning|authority) /.test(principal.subject.displayName),
    'Never change the original operator principal',
  );
  assert(
    principal.roles.some((binding) => binding.role === 'admin') &&
      !principal.roles.some((binding) => binding.role === 'operator'),
    'Disposable actor starts with admin only',
  );
  await navigate(`roadmap?projects=${project}&item=${fixtures.roadmap.id}`);
  const initial = await ready('roadmap.list');
  assert.equal(
    initial.principalId,
    actor.principalId,
    'Sign in the disposable actor through the actual auth form before this phase',
  );
  const inspect = (scope) =>
    cdp(
      'eval',
      route,
      `const url=performance.getEntriesByType('resource').map(({name})=>name).filter((name)=>new URL(name).pathname.endsWith('/packages/protocol/src/client-cache/index.ts')).at(-1);if(!url)throw Error('Inspect the actual cache module'); const {resourceQuery}=await import(url);return (await import('/src/dev/resource-authority-proof.ts')).inspectResourceAuthority(${JSON.stringify(scope) ?? 'undefined'},resourceQuery('roadmap.list',${JSON.stringify(initial.observations['roadmap.list'].params)}));`,
    );
  const before = await inspect();
  assert(before.persistent && before.storedObservedAt === before.cacheObservedAt);
  const reconnect = () =>
    cdp(
      'eval',
      route,
      "return (await import('/src/dev/resource-authority-proof.ts')).requestResourceReconnect()",
    );
  let changed = false;
  try {
    await rpc('principal.grant', {
      principalId: actor.principalId,
      role: 'operator',
      scope: { kind: 'global' },
    });
    changed = true;
    await rpc('principal.revokeRole', {
      principalId: actor.principalId,
      role: 'admin',
      scope: { kind: 'global' },
    });
    await reconnect();
    const deadline = Date.now() + 15000;
    let after;
    do {
      after = await inspect(before.inspectedScope);
      if (
        after.connection === 'connected' &&
        !after.cacheHasData &&
        after.storedObservedAt === undefined &&
        !after.identity.metadata.authority.roles.some((binding) => binding.role === 'admin')
      )
        break;
      await delay(100);
    } while (Date.now() < deadline);
    assert(
      after.connection === 'connected' &&
        !after.cacheHasData &&
        after.storedObservedAt === undefined,
      'Revoking roadmap authority must delete its stored row and reject replies',
    );
    await screenshot('roadmap-authority-revoked');
    receipts.roadmapAuthorityRevocation = true;
  } finally {
    if (changed) {
      await rpc('principal.grant', {
        principalId: actor.principalId,
        role: 'admin',
        scope: { kind: 'global' },
      });
      await rpc('principal.revokeRole', {
        principalId: actor.principalId,
        role: 'operator',
        scope: { kind: 'global' },
      });
      await reconnect();
      await ready('roadmap.list');
    }
  }
}
async function cleanup() {
  if (fixtures.queue) await rpc('dispatch.queue.remove', { itemId: fixtures.queue.id });
  if (fixtures.graph && fixtures.backlog) {
    const { graph } = await rpc('workGraph.get', { graphId: fixtures.graph.id });
    const node = graph.nodes.find((entry) => entry.backlogItemId === fixtures.backlog.id);
    if (node) {
      assert.equal(node.id, 'backlog-proof', 'Only detach the owned proof node');
      assert(['planning', 'paused'].includes(graph.graph.status));
      if (graph.graph.status === 'paused')
        await rpc('workGraph.retry', {
          graphId: fixtures.graph.id,
          reason: 'Remove owned offline planning proof fixtures without dispatch',
        });
      await rpc('workGraph.removeNode', { graphId: fixtures.graph.id, nodeId: node.id });
    }
  }
  if (fixtures.backlog) await rpc('backlog.delete', { itemId: fixtures.backlog.id });
  if (fixtures.roadmap) {
    const item = (await rpc('roadmap.get', { itemId: fixtures.roadmap.id })).item;
    await rpc('roadmap.delete', { itemId: item.id, expectedHash: item.fileHash });
  }
  if (fixtures.graph)
    await withOwnedGatewayOffline(async () => {
      const directory = process.env.FARMSLOT_WORK_GRAPH_DIR ?? path.join(farmRoot, '.work-graphs');
      const file = path.join(directory, `${fixtures.graph.id}.json`);
      assert.equal(JSON.parse(await readFile(file, 'utf8')).graph.id, fixtures.graph.id);
      await rm(file);
    });
}
const mode = process.argv[2] ?? 'writers';
assert(
  [
    'writers',
    'writers-and-raw',
    'all',
    'raw-file',
    'raw-file-only',
    'authority',
    'configuration',
  ].includes(mode),
);
let failure;
const failures = [];
try {
  await setup();
  if (mode === 'configuration') await configuration();
  else if (mode === 'authority') await authority();
  else if (mode !== 'raw-file-only') {
    await writers();
    if (!['writers', 'writers-and-raw'].includes(mode)) {
      await draftError();
      await cold();
    }
  }
  if (['all', 'raw-file', 'raw-file-only', 'writers-and-raw'].includes(mode)) await rawFile();
  if (mode === 'all') await configuration();
} catch (error) {
  failure = error;
  failures.push(error);
}
try {
  await writeFile(
    path.join(artifacts, 'planning-proof-receipt.json'),
    JSON.stringify({ mode, receipts, failure: failure?.message }, null, 2),
  );
} catch (error) {
  failures.push(error);
}
try {
  await cleanup();
} catch (error) {
  failures.push(error);
}
if (failures.length) throw new AggregateError(failures, 'Planning proof or cleanup failed');
console.log(JSON.stringify({ result: 'PASS', ...receipts }));

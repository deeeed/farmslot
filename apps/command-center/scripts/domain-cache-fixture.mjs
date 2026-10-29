import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
assert(
  process.env.DOMAIN_PROOF_TMUX_SOCKET,
  'Select an unused private socket; never adopt an operator runner',
);
assert.equal(process.env.TMUX?.split(',')[0], process.env.DOMAIN_PROOF_TMUX_SOCKET);
const farm = path.resolve(process.env.FARMSLOT_ROOT);
const home = path.resolve(process.env.FARMSLOT_HOME);
const runs = path.resolve(process.env.FARMSLOT_RUNS_DIR);
assert.notEqual(farm, source, 'Select the disposable farm, never the implementation checkout');
assert.notEqual(farm, path.parse(farm).root);
assert.notEqual(home, path.parse(home).root);
const receipt = path.resolve(process.env.FARMSLOT_DOMAIN_PROOF_SETUP);
assert(!receipt.startsWith(`${source}${path.sep}`), 'Fixture records stay outside source');
const ownerManifest = JSON.parse(await readFile(process.env.FARMSLOT_SLOT_RESOURCE_PROOF, 'utf8'));
assert.equal(path.resolve(ownerManifest.root), farm, 'Use the declared disposable farm');
assert.equal(path.resolve(ownerManifest.home), home, 'Use the declared disposable home');
assert.equal(path.resolve(ownerManifest.sourceRoot), source, 'Review the selected checkout');
assert(runs.startsWith(`${home}${path.sep}`), 'Run fixtures stay inside the disposable home');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mode = process.argv[2];
assert(['setup', 'cleanup'].includes(mode));

async function files(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const result = [];
  for (const entry of entries) {
    assert(!entry.isSymbolicLink(), 'Never back up or restore a linked fixture directory');
    const file = path.join(directory, entry.name);
    result.push(...(entry.isDirectory() ? await files(file) : [file]));
  }
  return result;
}
async function saved(file) {
  try {
    const bytes = await readFile(file);
    return {
      bytes: bytes.toString('base64'),
      mode: (await stat(file)).mode & 0o777,
      sha256: hash(bytes),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

if (mode === 'setup') {
  const ownerId = process.env.FARMSLOT_DOMAIN_PROOF_OWNER;
  assert(ownerId, 'Select the existing isolated gateway principal; do not change its authority');
  const directories = [path.join(home, 'copilot-runtime'), path.join(farm, '.runs/analytics')];
  const targets = [
    path.join(farm, '.pr-monitors.json'),
    path.join(farm, '.pr-rules.json'),
    path.join(farm, '.env'),
  ];
  const runtime = await saved(path.join(directories[0], 'session.json'));
  if (runtime) {
    const session = JSON.parse(Buffer.from(runtime.bytes, 'base64')).session;
    assert(
      ['stopped', 'failed'].includes(session.status) && !session.autostart,
      'Never adopt or start an existing runner for this proof',
    );
  }
  for (const directory of directories) targets.push(...(await files(directory)));
  const before = Object.fromEntries(
    await Promise.all(targets.map(async (file) => [file, await saved(file)])),
  );
  const context = {
    farm,
    home,
    runs,
    ownerId,
    directories,
    before,
    created: [],
    fixtureOnly: true,
    providerExecutionClaimed: false,
  };
  await mkdir(path.dirname(receipt), { recursive: true });
  await writeFile(receipt, JSON.stringify(context, null, 2), { flag: 'wx', mode: 0o600 });
  const checkpoint = () => writeFile(receipt, JSON.stringify(context, null, 2), { mode: 0o600 });
  const { PRMonitorStore } = await import('../../../services/gateway/src/pr-monitoring/store.ts');
  const { PRRuleStore } = await import('../../../services/gateway/src/pr-rules/store.ts');
  const { beginAssessment, finishAssessment } =
    await import('../../../services/gateway/src/assessment/store.ts');
  const { createRun, persistRunNow } = await import('../../../services/gateway/src/runs/store.ts');
  const { appendAnalyticsRecord, buildAnalyticsRecord } =
    await import('../../../services/gateway/src/runs/analytics.ts');
  const project = process.env.FARMSLOT_DOMAIN_PROOF_PROJECT;
  assert(project);
  const monitors = await PRMonitorStore.load(targets[0]);
  const monitor = await monitors.subscribe(ownerId, {
    pr: { host: 'github.com', repo: 'proof/offline-store', number: 1 },
    account: { host: 'github.com', login: 'offline-proof' },
    project,
    policy: { mode: 'notify-only' },
    pollIntervalMs: 300000,
    watchedChecks: [],
    automaticAttemptLimit: 1,
    cooldownMs: 300000,
  });
  await monitors.setLifecycle(monitor.id, ownerId, monitor.revision, 'paused');
  const rules = await PRRuleStore.load(targets[1]);
  const predicate = { kind: 'compare', field: 'state', operator: 'equals', value: 'open' };
  const team = await rules.saveTeam(ownerId, {
    name: `D07 fixture ${randomUUID()}`,
    account: { host: 'github.com', login: 'offline-proof' },
    sources: [{ kind: 'repository', repo: 'proof/offline-store' }],
    predicate,
    repositories: [],
    githubTeams: [],
    notificationPrincipalIds: [],
  });
  const rule = await rules.saveRule(ownerId, {
    name: `D07 rule ${randomUUID()}`,
    teamId: team.id,
    predicate,
    actions: [{ kind: 'review', autoStart: false }],
    pollIntervalMs: 300000,
    maxAdmissionsPerScan: 1,
    rereviewOnHeadChange: true,
  });
  context.monitorId = monitor.id;
  context.ruleId = rule.id;
  context.ruleName = rule.config.name;
  const assessment = await beginAssessment({
    ownerId,
    consumer: 'static-review-checklist',
    subject: {
      pr: { host: 'github.com', repo: 'proof/offline-store', number: 1, headSha: 'a'.repeat(40) },
      suggestion: {
        kind: 'static-review-checklist',
        source: { classification: 'synthetic', ref: 'synthetic:d07-cache-fixture' },
        context:
          'Controlled launch fixture for feedback and summary notifications. No provider was invoked.',
        items: [
          {
            id: 'color',
            text: 'The fixture input is blue.',
            evidence: 'Controlled launch fixture.',
          },
        ],
      },
    },
  });
  context.assessmentId = assessment.id;
  context.created.push(path.join(home, 'assessments', `${assessment.id}.json`));
  await checkpoint();
  await finishAssessment(assessment, {
    status: 'completed',
    attempted: false,
    answers: { color: { type: 'choice', choice: 'blue', choices: ['blue', 'red'] } },
  });
  context.runIds = [];
  for (const selectedProject of [project, `${project}-other`]) {
    const run = createRun(
      {
        flowType: 'fix-bug',
        project: selectedProject,
        ticketOrPr: `D07 fixture ${randomUUID()}`,
        safetyTier: 'sandboxed',
      },
      { deferBackgroundPersist: true },
    );
    run.status = 'done';
    run.completedAt = new Date().toISOString();
    context.runIds.push(run.id);
    context.created.push(path.join(runs, `${run.id}.json`));
    await checkpoint();
    await persistRunNow(run, 'D07 launch fixture');
    if (selectedProject === project) await appendAnalyticsRecord(buildAnalyticsRecord(run));
  }
  context.project = project;
  // The existing gateway loads this farm-local environment before constructing its runtime.
  const oldEnvironment = before[path.join(farm, '.env')];
  assert(!oldEnvironment, 'Use a fixture without an existing environment file');
  await writeFile(
    path.join(farm, '.env'),
    `FARMSLOT_OPERATOR_CHECKOUT=${path.join(home, 'worker')}\n`,
    { mode: 0o600 },
  );
  context.launchSources = {};
  for (const file of [targets[0], targets[1], ...context.created, ...(await files(directories[1]))])
    context.launchSources[file] = await saved(file);
  context.setupComplete = true;
  await checkpoint();
  console.log(JSON.stringify({ setupComplete: true, fixtureOnly: true, providerCalls: 0 }));
} else {
  const context = JSON.parse(await readFile(receipt, 'utf8'));
  assert.equal(context.farm, farm);
  assert.equal(context.home, home);
  assert.equal(context.runs, runs);
  const targets = new Set([...Object.keys(context.before), ...context.created]);
  for (const directory of context.directories)
    for (const file of await files(directory)) targets.add(file);
  for (const file of targets) {
    assert(
      file.startsWith(`${farm}/`) || file.startsWith(`${home}/`) || file.startsWith(`${runs}/`),
    );
    const original = context.before[file];
    if (original) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, Buffer.from(original.bytes, 'base64'), { mode: original.mode });
      await chmod(file, original.mode);
      assert.equal(hash(await readFile(file)), original.sha256);
    } else await rm(file, { force: true });
  }
  await writeFile(
    `${receipt}.cleanup.json`,
    JSON.stringify({ restoredFiles: targets.size, originalActorUnchanged: true }, null, 2),
  );
  console.log(JSON.stringify({ cleanup: 'pass', restoredFiles: targets.size }));
}

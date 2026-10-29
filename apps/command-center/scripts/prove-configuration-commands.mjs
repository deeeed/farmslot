// Real private configuration commands. Canonical reads wait for original source notices.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.cwd(), root);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
const fixture = JSON.parse(await readFile(process.env.FARMSLOT_DOMAIN_PROOF_SETUP, 'utf8'));
const context = JSON.parse(await readFile(process.env.FARMSLOT_SLOT_RESOURCE_PROOF, 'utf8'));
assert(fixture.setupComplete && context.setupOnly);
assert.equal(context.sourceRoot, root);
assert.equal(fixture.home, context.home);
assert.equal(fixture.farm, context.root);
assert.equal(fixture.project, context.project);
assert.equal(await realpath(process.env.FARMSLOT_HOME), fixture.home);
assert.equal(await realpath(process.env.FARMSLOT_ROOT), fixture.farm);
assert.notEqual(fixture.farm, root);
assert.match(fixture.project, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const target = await automationGatewayTarget();
assert.equal(new URL(target.url).hostname, '127.0.0.1');
assert.equal(new URL(target.url).port, '7913');
assert.equal(process.env.VITE_PORT, '5195');
assert.equal(process.env.FARMSLOT_CDP_PORT, '19222');
const artifacts = path.resolve(process.env.FARMSLOT_DOMAIN_PROOF_ARTIFACTS);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const caseId = path.basename(path.dirname(artifacts));
const cdpFile = path.join(root, 'apps/command-center/scripts/cdp.mjs');
const probe = path.join(root, 'apps/command-center/scripts/probes/configuration-writers.js');
const cdp = async (...args) =>
  JSON.parse(
    (
      await execute(process.execPath, [cdpFile, ...args], {
        timeout: 65000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout,
  );
// Reuse the committed helper's real CDP input, keeping even synthetic keys out of argv.
const fillPrivate = async (selector, text) => {
  const pending = execute(process.execPath, [cdpFile, 'fill', tab, selector, '--stdin'], {
    timeout: 65000,
    maxBuffer: 8 * 1024 * 1024,
  });
  pending.child.stdin.end(text);
  return JSON.parse((await pending).stdout);
};
const proxy = JSON.parse(
  await readFile(
    path.join(process.env.FARMSLOT_PLANNING_RACE_PROXY_DIR, 'proxy-ready.json'),
    'utf8',
  ),
);
assert.equal(proxy.method, 'config.projects');
assert.equal(proxy.port, 7915);
const status = async () => {
  const response = await fetch('http://127.0.0.1:7915/planning-race-status', {
    signal: AbortSignal.timeout(3000),
  });
  assert(response.ok);
  const value = await response.json();
  assert.equal(value.startId, proxy.startId);
  assert(!value.failure && !value.stopped);
  return value;
};
const control = async (action) => {
  const response = await fetch('http://127.0.0.1:7915/api/planning-race-control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-proof-owner': proxy.owner },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(3000),
  });
  assert(response.ok, `Owned ${action} must succeed`);
  assert.equal((await response.json()).startId, proxy.startId);
};
async function until(read, accepts, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (accepts(value)) return value;
    await delay(80);
  } while (Date.now() < deadline);
  assert.fail(label);
}
let tab;
let inFlight;
let activeGate;
const claims = {};
const evidence = {};
const failures = [];
const originals = new Map();
const allowed = new Map();
const ownedBackups = new Map();
const previousBackups = new Set();
const backupBytes = new Map();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const payloadHash = (value) => hash(JSON.stringify(value));
const inspect = () => cdp('eval', tab, '--file', probe);
const screenshot = (name) => cdp('screenshot', tab, path.join(artifacts, `${name}.png`));
const llmMethods = ['llm.auth.list', 'llm.config.get', 'llm.tiers'];
const commands = ['llm.auth.add', 'llm.config.set', 'config.project.autoRecovery.update'];
const inputState = (view, provider) =>
  view.providers?.keyInputs.find((row) => row.provider === provider);
const projectState = (view) => view.project?.projects.find((row) => row.name === fixture.project);
const revision = (state) =>
  state.resourceState?.dependencies.find(
    (row) => row.key.family === 'configuration' && row.key.scope === 'farm' && !row.key.project,
  )?.revision;
const sourceState = (view) =>
  Object.fromEntries(
    Object.entries(view.observations).map(([method, state]) => [
      method,
      {
        status: state.status,
        observedAt: state.observedAt,
        resourceState: state.resourceState,
        data: state.data,
      },
    ]),
  );
async function navigate(route) {
  await cdp('eval', tab, `location.hash=${JSON.stringify(route)};return {hash:location.hash}`);
}
async function remember(file) {
  assert(file.startsWith(fixture.home + '/'), 'Back up only owned private-home configuration');
  let original = null;
  try {
    const info = await lstat(file);
    assert(info.isFile() && !info.isSymbolicLink());
    assert.equal(await realpath(file), file);
    original = { bytes: await readFile(file), mode: info.mode & 0o777 };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  originals.set(file, original);
  allowed.set(file, new Set(original ? [hash(original.bytes)] : []));
}
const expectBytes = (file, bytes) => allowed.get(file).add(hash(bytes));
async function settled() {
  let signature;
  let since = Date.now();
  return until(
    status,
    (wire) => {
      const next = JSON.stringify(wire.observedReads);
      if (signature !== next) since = Date.now();
      signature = next;
      return Date.now() - since >= 400;
    },
    'Configuration source reads must settle',
  );
}
async function startGate(method) {
  await until(
    inspect,
    (view) => Object.values(view.observations).every((state) => state.ready),
    'All mounted reads must be current before gating a command',
  );
  const before = await settled();
  await control('hold-resource-changes');
  const wire = await status();
  assert(wire.resourceChangesHeld);
  const gate = wire.changeGates.at(-1);
  assert.equal(gate.principalId, fixture.ownerId);
  activeGate = gate.id;
  inFlight = { method, count: before.commands[method] ?? 0 };
  return {
    before,
    gateId: activeGate,
    heldAt: gate.heldAt,
    connection: gate.connection,
    view: await inspect(),
  };
}
async function commandSettled(boundary, acknowledgement) {
  const wire = await until(
    status,
    (value) =>
      value.commandReplies.some(
        (reply) => reply.method === inFlight.method && reply.repliedAt >= boundary.heldAt,
      ),
    'The actual browser command must finish',
  );
  // Bind the receipt by the increased command counter and current gate time, not an earlier write.
  const gate = wire.changeGates.find((row) => row.id === boundary.gateId);
  const reply = wire.commandReplies.find(
    (row) => row.method === inFlight.method && row.repliedAt >= gate.heldAt,
  );
  assert(reply?.ok);
  assert.equal(reply.connection, boundary.connection);
  assert.equal(wire.commands[inFlight.method], inFlight.count + 1);
  if (reply.backup) await captureBackup(reply.backup);
  inFlight = undefined;
  assert.deepEqual(
    wire.observedReads,
    boundary.before.observedReads,
    'The command must not force an early source read',
  );
  await until(
    status,
    (value) => value.changeGates.find((row) => row.id === boundary.gateId)?.frames.length > 0,
    'Hold an actual source notice after the successful command',
  );
  const acknowledged = await until(
    inspect,
    acknowledgement,
    'The command must acknowledge its local input or draft',
  );
  const deadline = Date.now() + 650;
  const reads = wire.observedReads;
  do {
    const current = await status();
    assert(current.resourceChangesHeld);
    assert.deepEqual(
      current.observedReads,
      reads,
      'Commands must not force source reads while original notices are held',
    );
    const view = await inspect();
    assert.equal(view.timeOrigin, boundary.view.timeOrigin);
    assert.equal(view.connectionId, boundary.view.connectionId);
    assert.deepEqual(
      sourceState(view),
      sourceState(boundary.view),
      'Command replies cannot replace canonical configuration',
    );
    await delay(80);
  } while (Date.now() < deadline);
  return {
    reply,
    acknowledged,
    quiet: { startedAt: deadline - 650, endedAt: Date.now(), observedReads: reads },
    gate: (await status()).changeGates.find((row) => row.id === boundary.gateId),
  };
}
async function releaseAndRead(boundary, method, accepts) {
  const releaseRequestedAt = Date.now();
  await control('release-resource-changes');
  activeGate = undefined;
  const wire = await status();
  const gate = wire.changeGates.find((row) => row.id === boundary.gateId);
  assert(gate.releasedAt && gate.frames.length);
  const view = await until(
    inspect,
    (value) =>
      value.observations[method]?.ready &&
      value.observations[method].observedAt > boundary.view.observations[method].observedAt &&
      accepts(value),
    'Released source notices must update the actual mounted view',
  );
  assert.equal(view.timeOrigin, boundary.view.timeOrigin);
  assert.equal(view.connectionId, boundary.view.connectionId);
  const state = view.observations[method];
  const observed = await until(
    status,
    (value) =>
      value.configurationReplies.some(
        (reply) =>
          reply.method === method &&
          reply.connection === boundary.connection &&
          reply.ok &&
          reply.requestAt >= releaseRequestedAt &&
          reply.payloadSha256 === payloadHash(state.data) &&
          JSON.stringify(reply.resourceState) === JSON.stringify(state.resourceState),
      ),
    'Bind rendered configuration to its actual observed wire reply',
  );
  assert(revision(state) > revision(boundary.view.observations[method]));
  assert(
    gate.frames.some(
      (frame) =>
        frame.epoch === state.resourceState.epoch &&
        frame.changes.some(
          (change) =>
            change.key.family === 'configuration' &&
            change.key.scope === 'farm' &&
            !change.key.project &&
            change.revision > revision(boundary.view.observations[method]) &&
            change.revision <= revision(state),
        ),
    ),
  );
  return {
    view,
    gate,
    releaseRequestedAt,
    wire: observed.configurationReplies.filter(
      (reply) =>
        reply.method === method &&
        reply.connection === boundary.connection &&
        reply.requestAt >= releaseRequestedAt,
    ),
  };
}

// Verified owning paths: auth-store.getFarmslotStorePath, llm/config.configPath,
// and slot-config/source-runtime-settings.settingsPath. Legacy projects write project.json.
const authFile = path.join(fixture.home, 'auth-profiles.json');
const configFile = path.join(fixture.home, 'llm-config.json');
const runtimeFile = path.join(fixture.home, 'sources/runtime-settings', `${fixture.project}.json`);
const projectFile = path.join(
  await realpath(process.env.FARMSLOT_PROJECTS_DIR),
  fixture.project,
  'project.json',
);
async function captureBackup(backup) {
  const source = [runtimeFile, projectFile].find(
    (file) => backup.startsWith(file + '.bak.') && path.dirname(backup) === path.dirname(file),
  );
  assert(
    source && !previousBackups.has(backup),
    'Bind the returned backup to a new exact owned source',
  );
  assert.equal(await realpath(backup), backup);
  const expected = hash(backupBytes.get(source));
  assert.equal(hash(await readFile(backup)), expected);
  ownedBackups.set(backup, expected);
  return source;
}
const privateKey = `D07_SYNTHETIC_NEVER_VALID_${randomUUID()}`;
const draftKey = `D07_UNSAVED_NEVER_VALID_${randomUUID()}`;
const redact = (value) =>
  String(value).replaceAll(privateKey, '[synthetic key]').replaceAll(draftKey, '[synthetic draft]');
try {
  for (const file of [authFile, configFile, runtimeFile, projectFile]) await remember(file);
  assert(originals.get(projectFile), 'Use the existing private project fixture');
  const rawProject = JSON.parse(originals.get(projectFile).bytes);
  assert.equal(rawProject.name, fixture.project);
  const rawRuntime = originals.get(runtimeFile)
    ? JSON.parse(originals.get(runtimeFile).bytes)
    : null;
  backupBytes.set(projectFile, originals.get(projectFile).bytes);
  backupBytes.set(
    runtimeFile,
    Object.keys(rawRuntime?.values ?? {}).length
      ? originals.get(runtimeFile).bytes
      : Buffer.from(JSON.stringify({ schemaVersion: 1, project: fixture.project, values: {} })),
  );
  for (const file of [projectFile, runtimeFile]) {
    let names = [];
    try {
      names = await readdir(path.dirname(file));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const name of names)
      if (name.startsWith(path.basename(file) + '.bak.'))
        previousBackups.add(path.join(path.dirname(file), name));
  }
  const url = new URL(process.env.FARMSLOT_UI_URL);
  assert.equal(url.origin, 'http://127.0.0.1:5195');
  const pages = (await cdp('tabs')).filter(
    (page) =>
      page.type === 'page' &&
      page.url.startsWith(url.origin) &&
      new URL(page.url).searchParams.get('authority-proof') === caseId,
  );
  assert.equal(pages.length, 1, 'Use exactly the existing owned recorded tab');
  tab = '@' + pages[0].id;
  await cdp('focus', tab);
  await navigate('config/llm');
  const warm = await until(
    inspect,
    (view) =>
      view.principalId === fixture.ownerId &&
      llmMethods.every((method) => view.observations[method]?.ready),
    'Mount actual healthy LLM configuration',
  );
  evidence.warm = warm;
  const initialCommands = (await status()).commands;
  const sourceAuth = originals.get(authFile)
    ? JSON.parse(originals.get(authFile).bytes)
    : { version: 1, profiles: {} };
  const provider = ['google', 'anthropic', 'openai'].find(
    (name) =>
      name !== warm.providers.config.defaultProvider &&
      !Object.values(sourceAuth.profiles).some((profile) => profile.provider === name) &&
      warm.providers.cards.some((card) => card.name === name && !card.hasKey),
  );
  assert(provider, 'Select an unused private provider without imported or environment credentials');
  const profileId = `${provider}:default`;
  const registeredBytes = Buffer.from(
    JSON.stringify(
      {
        ...sourceAuth,
        profiles: {
          ...sourceAuth.profiles,
          [profileId]: { type: 'api_key', provider, key: privateKey },
        },
      },
      null,
      2,
    ) + '\n',
  );
  expectBytes(authFile, registeredBytes);
  if (!originals.get(authFile))
    expectBytes(
      authFile,
      Buffer.from(JSON.stringify({ version: 1, profiles: {} }, null, 2) + '\n'),
    );
  await fillPrivate(`llm-config >>> [data-testid="llm-key-${provider}"]`, privateKey);
  await until(
    inspect,
    (view) => !inputState(view, provider)?.inputEmpty && !inputState(view, provider)?.draftEmpty,
    'Type the private synthetic key through real input',
  );
  const registration = await startGate('llm.auth.add');
  await cdp('click', tab, `llm-config >>> [data-testid="llm-key-save-${provider}"]`);
  evidence.registrationHeld = await commandSettled(
    registration,
    (view) => inputState(view, provider)?.inputEmpty && inputState(view, provider)?.draftEmpty,
  );
  assert.equal(evidence.registrationHeld.reply.profileId, profileId);
  assert.equal(
    hash(await readFile(authFile)),
    hash(registeredBytes),
    'The real registration writer must save exactly the owned synthetic profile',
  );
  assert.deepEqual(
    evidence.registrationHeld.acknowledged.providers.cards,
    registration.view.providers.cards,
  );
  evidence.registration = await releaseAndRead(
    registration,
    'llm.auth.list',
    (view) =>
      view.providers.cards.some((card) => card.storedProfileId === profileId) &&
      view.providers.text.includes(profileId),
  );
  await screenshot('key-registration-notified');
  claims.keyCommandWaitsForNotice = true;

  await fillPrivate(`llm-config >>> [data-testid="llm-key-${provider}"]`, draftKey);
  const providerWrite = await startGate('llm.config.set');
  const configuredBytes = Buffer.from(
    JSON.stringify(
      { ...providerWrite.view.observations['llm.config.get'].data, defaultProvider: provider },
      null,
      2,
    ) + '\n',
  );
  expectBytes(configFile, configuredBytes);
  await cdp('click', tab, `llm-config >>> [data-testid="llm-provider-active-${provider}"]`);
  evidence.providerHeld = await commandSettled(
    providerWrite,
    (view) => !inputState(view, provider)?.inputEmpty && !inputState(view, provider)?.draftEmpty,
  );
  assert.equal(
    evidence.providerHeld.acknowledged.providers.config.defaultProvider,
    providerWrite.view.providers.config.defaultProvider,
  );
  assert.equal(hash(await readFile(configFile)), hash(configuredBytes));
  evidence.provider = await releaseAndRead(
    providerWrite,
    'llm.config.get',
    (view) =>
      view.providers.config.defaultProvider === provider &&
      inputState(view, provider)?.active &&
      !inputState(view, provider)?.inputEmpty &&
      !inputState(view, provider)?.draftEmpty,
  );
  await screenshot('active-provider-unsaved-key-retained');
  await fillPrivate(`llm-config >>> [data-testid="llm-key-${provider}"]`, '');
  claims.activeProviderPreservesDraft = true;

  const malformed = Buffer.from('{"version":1,"profiles":');
  expectBytes(authFile, malformed);
  assert.equal(hash(await readFile(authFile)), hash(registeredBytes));
  await writeFile(authFile, malformed);
  await until(
    inspect,
    (view) =>
      !!view.observations['llm.auth.list']?.error &&
      llmMethods.slice(1).every((method) => view.observations[method]?.ready) &&
      view.providers.retry.some((button) => button.visible && !button.disabled),
    'A real registration read error must expose its Retry',
  );
  await settled();
  const failed = await inspect();
  assert(failed.providers.cards.some((card) => card.storedProfileId === profileId));
  assert(failed.providers.alert?.includes('Could not read provider registrations.'));
  await control('hold-resource-changes');
  activeGate = (await status()).changeGates.at(-1).id;
  assert.equal(hash(await readFile(authFile)), hash(malformed));
  await writeFile(authFile, registeredBytes);
  await until(
    status,
    (wire) => wire.changeGates.find((gate) => gate.id === activeGate)?.frames.length > 0,
    'Hold the real repaired-source notice before Retry',
  );
  const retryBefore = await status();
  const healthy = Object.fromEntries(
    llmMethods.slice(1).map((method) => [method, failed.observations[method]]),
  );
  await cdp('click', tab, 'llm-config >>> [role="alert"] button');
  const retried = await until(
    inspect,
    (view) =>
      view.observations['llm.auth.list']?.ready &&
      view.providers.cards.some((card) => card.storedProfileId === profileId),
    'Actual Retry must recover the failed auth query while notices remain held',
  );
  const retryAfter = await settled();
  assert(retryAfter.resourceChangesHeld);
  assert.equal(
    retryAfter.observedReads['llm.auth.list'],
    retryBefore.observedReads['llm.auth.list'] + 1,
  );
  for (const method of llmMethods.slice(1)) {
    assert.equal(
      retryAfter.observedReads[method],
      retryBefore.observedReads[method],
      'Retry must not reread healthy config or tiers',
    );
    assert.deepEqual(retried.observations[method], healthy[method]);
  }
  assert(
    retryAfter.configurationReplies.some(
      (reply) =>
        reply.method === 'llm.auth.list' &&
        reply.ok &&
        reply.requestAt >= retryBefore.changeGates.at(-1).heldAt &&
        reply.payloadSha256 === payloadHash(retried.observations['llm.auth.list'].data) &&
        JSON.stringify(reply.resourceState) ===
          JSON.stringify(retried.observations['llm.auth.list'].resourceState),
    ),
  );
  evidence.retry = {
    failed,
    before: retryBefore.observedReads,
    after: retryAfter.observedReads,
    retried,
    gate: retryAfter.changeGates.at(-1),
  };
  await screenshot('only-failed-registration-retried');
  await control('release-resource-changes');
  activeGate = undefined;
  await settled();
  claims.retryReadsOnlyFailure = true;

  await navigate(`config/project/${fixture.project}`);
  const projectWarm = await until(
    inspect,
    (view) =>
      view.observations['config.projects']?.ready &&
      view.project.autoRecovery.draft?.project === fixture.project &&
      !view.project.autoRecovery.saving,
    'Mount actual disabled project policy',
  );
  assert.equal(projectWarm.project.autoRecovery.draft.enabled, false);
  assert.equal(projectWarm.project.autoRecovery.draft.llmEnabled, false);
  const nextAttempts = projectWarm.project.autoRecovery.draft.maxAttempts === 2 ? 1 : 2;
  await cdp('fill', tab, '.cp-form-grid input[type="number"]', String(nextAttempts));
  const typed = await until(
    inspect,
    (view) =>
      view.project.autoRecovery.dirty &&
      view.project.autoRecovery.draft.maxAttempts === nextAttempts,
    'Type a safe max-attempts draft without enabling policy',
  );
  assert.deepEqual(
    typed.observations['config.projects'],
    projectWarm.observations['config.projects'],
  );
  const draft = typed.project.autoRecovery.draft;
  const list = (value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  const existing = { ...rawProject, ...(rawRuntime?.values ?? {}) };
  const oldPolicy = existing.auto_recovery ?? {};
  existing.auto_recovery = {
    ...oldPolicy,
    enabled: false,
    maxAttempts: nextAttempts,
    allowedSteps: list(draft.allowedStepsText),
    allowedCategories: list(draft.allowedCategoriesText),
    disabled_patterns: list(draft.disabledPatternsText),
    llm: {
      ...oldPolicy.llm,
      enabled: false,
      dailyUsdCap: draft.llmDailyUsdCap,
      timeoutMs: draft.llmTimeoutMs,
    },
  };
  const expectedRuntime = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      project: fixture.project,
      values: { ...(rawRuntime?.values ?? {}), auto_recovery: existing.auto_recovery },
    }),
  );
  const expectedProject = Buffer.from(JSON.stringify(existing, null, 2) + '\n');
  expectBytes(runtimeFile, expectedRuntime);
  expectBytes(projectFile, expectedProject);
  const policy = await startGate('config.project.autoRecovery.update');
  await cdp('click', tab, '.cp-auto-actions button');
  evidence.policyHeld = await commandSettled(
    policy,
    (view) =>
      !view.project.autoRecovery.saving &&
      !view.project.autoRecovery.dirty &&
      view.project.autoRecovery.draft.maxAttempts === nextAttempts,
  );
  assert.deepEqual(
    evidence.policyHeld.acknowledged.project.projects,
    policy.view.project.projects,
    'Acknowledged drafts cannot replace the project collection',
  );
  const backup = evidence.policyHeld.reply.backup;
  assert(backup, 'The policy command must return its actual backup');
  const source = await captureBackup(backup);
  assert.equal(
    hash(await readFile(source)),
    hash(source === runtimeFile ? expectedRuntime : expectedProject),
  );
  evidence.policy = await releaseAndRead(
    policy,
    'config.projects',
    (view) =>
      projectState(view)?.autoRecovery?.maxAttempts === nextAttempts &&
      projectState(view).autoRecovery.enabled === false &&
      view.project.autoRecovery.maxAttemptsInput === String(nextAttempts) &&
      !view.project.autoRecovery.dirty &&
      !view.project.autoRecovery.draft.enabled &&
      !view.project.autoRecovery.draft.llmEnabled,
  );
  evidence.policySource = { file: source, sha256: hash(await readFile(source)), backup };
  await screenshot('disabled-project-policy-notified');
  claims.projectCommandPreservesDraftBoundary = true;
  const final = await status();
  for (const [method, count] of Object.entries(final.commands))
    assert.equal(
      count - (initialCommands[method] ?? 0),
      commands.includes(method) ? 1 : 0,
      'Only the three intended browser writes may execute',
    );
} catch (error) {
  failures.push(error);
  if (tab) {
    try {
      evidence.failureView = await inspect();
      await screenshot('first-failure');
    } catch (captureError) {
      failures.push(captureError);
    }
  }
} finally {
  await finishProof();
}
async function finishProof() {
  let complete = true;
  if (inFlight) {
    try {
      const wire = await until(
        status,
        (wire) =>
          (wire.commands[inFlight.method] ?? 0) === inFlight.count ||
          wire.commandReplies.some(
            (reply) =>
              reply.method === inFlight.method && reply.repliedAt >= wire.changeGates.at(-1).heldAt,
          ),
        'Finish the real command before restoring its source',
      );
      const reply = wire.commandReplies.find(
        (reply) =>
          reply.method === inFlight.method && reply.repliedAt >= wire.changeGates.at(-1).heldAt,
      );
      if (reply?.backup) await captureBackup(reply.backup);
    } catch (error) {
      failures.push(error);
      complete = false;
    }
  }
  if (activeGate) {
    try {
      await control('release-resource-changes');
      activeGate = undefined;
    } catch (error) {
      failures.push(error);
    }
  }
  if (tab) {
    try {
      await navigate('fleet');
    } catch (error) {
      failures.push(error);
    }
  }
  if (complete)
    for (const [file, original] of originals) {
      try {
        let current;
        try {
          current = await readFile(file);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (current) {
          assert.equal(await realpath(file), file);
          assert(
            allowed.get(file).has(hash(current)),
            'Refuse to overwrite a foreign configuration change',
          );
        } else assert(!original, 'An original configuration file disappeared');
        if (original) {
          await writeFile(file, original.bytes);
          await chmod(file, original.mode);
          assert.equal(hash(await readFile(file)), hash(original.bytes));
        } else if (current) await unlink(file);
        (evidence.restored ??= []).push({
          file,
          existed: Boolean(original),
          sha256: original ? hash(original.bytes) : null,
          mode: original?.mode,
        });
      } catch (error) {
        failures.push(error);
      }
    }
  for (const [file, expected] of ownedBackups) {
    try {
      assert.equal(hash(await readFile(file)), expected);
      await unlink(file);
    } catch (error) {
      failures.push(error);
    }
  }
  const receipt = JSON.stringify(
    { claims, evidence, failures: failures.map((error) => redact(error.message)) },
    null,
    2,
  );
  assert(
    !receipt.includes(privateKey) && !receipt.includes(draftKey),
    'Proof artifacts must contain no synthetic key values',
  );
  await writeFile(path.join(artifacts, 'configuration-commands-receipt.json'), receipt, {
    mode: 0o600,
  });
}
if (failures.length)
  throw new AggregateError(
    failures.map((error) => new Error(redact(error.message))),
    'Configuration command proof or fenced restoration failed',
  );
console.log(JSON.stringify(claims));

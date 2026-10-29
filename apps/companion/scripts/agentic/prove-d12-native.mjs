// D12 native families proof driver, run by d12-native-families.recipe.json from apps/companion on
// a dev client the lane controller launched once. It makes no native call itself: launches, the one
// deliberate cold restart, deep links and gateway stops are controller checkpoints, requested
// through files as in D11. It reads the app through the dev-only recipe relay on METRO_PORT and
// prints one JSON receipt line per phase. The run-list phases come from
// prove-run-list-version-fill.mjs, whose receipt lines pass through unchanged.
//
// App observer this driver reads (dev only, ref `d12-native`):
//   { status, launchId, epoch, connectionId, framesSent, gate: { decisionId, packageHeld, opened, details,
//     diff, images: [{ sha256, loaded }], held: { diff, bothSides, images: [{ sha256, verified }] } },
//   catalog: { models: [id] }, upstream: { prs: [{ number, observedAt }] }, image: { id, state, mountId } }
// `launchId` is new for each app process; `framesSent` counts gateway application frames it has sent.
// Gate rendering claims come from mounted screens only (`diff`: the run Diff screen renders this
// gate's package diff; `images[].loaded`: an ArtifactImage mount loaded it); `held` is the store.
//
// Controller checkpoints this driver asks for: `open-url {url}`, `fail-artifact-once {id}`,
// `proxy-hold` (closes the app's socket at the store proxy and holds its reconnect), `proxy-release`,
// `change-runs {runs, gatewayDown?}` (the ack names the changed ids as `changedIds`), `gateway-stop`,
// `cold-restart` (the one deliberate restart) and `gateway-start` (a new epoch).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// The recipe names each phase's budget, below its node timeout, so a phase that runs out still
// prints its last observation before the recipe stops it.
const budgetArg = process.argv.slice(2).find((arg) => arg.startsWith('--budget-ms='));
const [phase, ...args] = process.argv.slice(2).filter((arg) => arg !== budgetArg);
const budget = Number(budgetArg?.slice('--budget-ms='.length));
assert(
  Number.isInteger(budget) && budget > 0,
  'The recipe names the phase budget with --budget-ms=',
);
const phaseEnd = Date.now() + budget;
const PHASES = [
  'online',
  'run-list-fill',
  'catalog-open',
  'catalog-online',
  'upstream-online',
  'reconnect-open',
  'reconnect',
  'offline',
  'gate-offline-open',
  'gate-offline',
  'gate-diff-offline',
  'catalog-offline',
  'upstream-offline',
  'recover',
];
assert(PHASES.includes(phase), `Expected one of ${PHASES.join(', ')}`);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
const metro = process.env.METRO_PORT;
assert(/^\d+$/.test(metro ?? ''), 'Select the isolated METRO_PORT');
const checkpoints = process.env.FARMSLOT_D12_CHECKPOINTS;
assert(checkpoints, 'FARMSLOT_D12_CHECKPOINTS names the controller checkpoint directory');
const config = JSON.parse(await readFile(process.env.FARMSLOT_D12_NATIVE_PROOF, 'utf8'));
const fixture = JSON.parse(await readFile(path.join(config.caseRoot, 'fixture.json'), 'utf8'));
const stateFile = path.join(config.caseRoot, 'client', 'd12-native-state.json');
await mkdir(path.dirname(stateFile), { recursive: true });
const scheme = 'farmslot-development';
// The gate review route needs its run, or the screen has no run query and stays loading.
const gateUrl = `${scheme}:///gate-review/${fixture.gate.decisionId}?runId=${fixture.gate.runId}`;
const total = String(fixture.runs.length);

async function observe(ref = 'd12-native') {
  const response = await fetch(`http://127.0.0.1:${metro}/farmslot-recipe/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'observeUi',
      nodeId: 'd12-native',
      payload: { refs: [ref] },
      timeout_ms: 3000,
    }),
    signal: AbortSignal.timeout(5000),
  });
  // No app is polling the relay while its native process starts.
  if (response.status === 504) return undefined;
  assert(response.ok, `Recipe relay failed with HTTP ${response.status}`);
  const result = await response.json();
  assert(result.ok, result.error ?? 'Recipe observer failed');
  return result.observations?.d12Native ?? result.observations?.offlineBaseline;
}
async function until(check, label, timeout = 90000) {
  const end = Math.min(Date.now() + timeout, phaseEnd);
  let last;
  while (Date.now() < end) {
    last = await observe().catch((error) => ({ observeError: error.message }));
    if (last && check(last)) return last;
    await delay(250);
  }
  throw new Error(`${label}: ${JSON.stringify(last).slice(0, 2000)}`);
}
/** One controller action, numbered after every request already in the directory. */
async function checkpoint(action, args = {}) {
  const taken = (await readdir(checkpoints)).filter((name) => name.endsWith('-request.json'));
  const step = `${String(taken.length + 1).padStart(2, '0')}-${action}`;
  const request = path.join(checkpoints, `${step}-request.json`);
  await writeFile(`${request}.tmp`, JSON.stringify({ case: config.name, action, args }));
  await rename(`${request}.tmp`, request);
  const end = Math.min(Date.now() + 180000, phaseEnd);
  while (Date.now() < end) {
    try {
      return JSON.parse(await readFile(path.join(checkpoints, `${step}-ack.json`), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(100);
  }
  throw new Error(`${step} controller acknowledgement deadline`);
}
const readState = async () => JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}'));
async function writeState(changes) {
  const next = { ...(await readState()), ...changes };
  await writeFile(`${stateFile}.tmp`, JSON.stringify(next, null, 2));
  await rename(`${stateFile}.tmp`, stateFile);
}
/** The run-list proof's own phase; its JSON receipt line reaches the recipe unchanged. */
function runList(name, extra = []) {
  const result = spawnSync(
    process.execPath,
    ['scripts/agentic/prove-run-list-version-fill.mjs', name, ...extra],
    {
      encoding: 'utf8',
      env: { ...process.env, FARMSLOT_D12_CASE: config.name },
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: Math.max(1, phaseEnd - Date.now()),
    },
  );
  process.stdout.write(result.stdout ?? '');
  assert.equal(
    result.status,
    0,
    `prove-run-list-version-fill ${name} failed${result.error ? `: ${result.error.message}` : ''}`,
  );
}
const receipt = (fields) => console.log(JSON.stringify({ phase, ...fields }));
const sameModels = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const prRows = (state) =>
  state.upstream.prs
    .map(({ number, observedAt }) => ({ number, observedAt }))
    .sort((a, b) => a.number - b.number);

if (phase === 'online') {
  // The controller launched the app on an empty store; prefetch must hold the pending gate.
  const state = await until(
    (value) => value.status === 'connected' && value.gate?.packageHeld === true,
    'Connected with the gate package held',
    150000,
  );
  // The reconnect image is over the prefetch size limit: prefetch never reads it, so its first live
  // read can fail. A held copy would be served first and the failure would never happen.
  const reconnectImage = state.gate.held?.images?.find(
    (image) => image.sha256 === fixture.reconnect.imageId,
  );
  assert(reconnectImage, 'The gate package lists the reconnect image');
  assert.equal(reconnectImage.verified, false, 'Prefetch holds the reconnect image');
  await writeState({
    online: { launchId: state.launchId, epoch: state.epoch, connectionId: state.connectionId },
  });
  receipt({
    gatePackageHeld: true,
    reconnectImageHeld: false,
    epoch: state.epoch,
    connectionId: state.connectionId,
  });
} else if (phase === 'run-list-fill') {
  runList('cold-fill', [
    '--min-runs',
    '81',
    '--expect-total',
    total,
    ...(fixture.oversizedRunId ? ['--expect-oversized'] : []),
  ]);
} else if (phase === 'catalog-open') {
  // The catalog is read only while a review picker is open. The gate review screen's picker sits
  // behind its request-review trigger, which the recipe taps once this screen is up.
  await checkpoint('open-url', { url: gateUrl });
  const state = await until((value) => value.gate?.opened === true, 'The gate review screen is up');
  receipt({ gateReviewOpen: true, catalogModels: state.catalog?.models?.length ?? 0 });
} else if (phase === 'catalog-online') {
  const state = await until((value) => value.catalog?.models?.length > 0, 'Catalog read online');
  // The picker may show a visible subset; every model it reads comes from the fixture's catalogs.
  const known = new Set(fixture.catalog.models.map((model) => model.id));
  assert(
    state.catalog.models.every((id) => known.has(id)),
    'A catalog model the fixture did not serve',
  );
  await writeState({ catalog: state.catalog.models });
  receipt({ catalogModels: state.catalog.models.length });
} else if (phase === 'upstream-online') {
  await checkpoint('open-url', { url: `${scheme}:///prs` });
  const state = await until(
    (value) => value.upstream?.prs?.length >= fixture.upstream.prs.length,
    'PR rows read online',
  );
  await writeState({ upstream: prRows(state) });
  receipt({ upstreamRows: state.upstream.prs.length });
} else if (phase === 'reconnect-open') {
  // One socket drop serves both claims. The large gate image's first read fails while connected. It
  // mounts with the gate's raw artifacts, which the recipe opens once this screen is up.
  const before = await until((value) => value.status === 'connected', 'Connected before reconnect');
  await checkpoint('fail-artifact-once', { id: fixture.reconnect.imageId });
  await checkpoint('open-url', { url: fixture.reconnect.url });
  await until((value) => value.gate?.opened === true, 'The gate review screen is up');
  await writeState({ reconnect: { connectionId: before.connectionId } });
  receipt({ reconnectOpen: true, connectionId: before.connectionId });
} else if (phase === 'reconnect') {
  // Then the proxy drops and holds the socket, K runs change, and only then may the app reconnect,
  // so the change can reach it only through its version read and ids pages.
  const before = (await readState()).reconnect;
  const failed = await until(
    (value) => value.image?.id === fixture.reconnect.imageId && value.image.state === 'failed',
    'The mounted image fails its first read',
  );
  await checkpoint('proxy-hold');
  await until((value) => value.status !== 'connected', 'The socket dropped and is held');
  const { changedIds } = await checkpoint('change-runs', { runs: fixture.changedRuns });
  assert.deepEqual([...changedIds].sort(), [...fixture.changedRuns].sort());
  const since = Date.now();
  await checkpoint('proxy-release');
  const recovered = await until(
    (value) =>
      value.status === 'connected' &&
      value.connectionId !== before.connectionId &&
      value.image?.state === 'loaded',
    'The app reconnects and the image loads',
  );
  receipt({
    imageRecoveredWithoutReload: recovered.image.mountId === failed.image.mountId,
    connectionId: recovered.connectionId,
    since,
  });
  runList('catch-up', [
    '--trigger=false',
    '--since',
    String(since),
    '--changed',
    changedIds.join(','),
  ]);
} else if (phase === 'offline') {
  const saved = await readState();
  // Offline is the whole path down: the gateway stops and the store proxy in front of it refuses
  // every new socket, as a stopped gateway's port would; the proxy would otherwise accept the
  // app's socket before finding the gateway gone, and the app's sign-in frames would count.
  await checkpoint('gateway-stop');
  await checkpoint('proxy-hold');
  await checkpoint('cold-restart');
  // The new process has the store only: a few seconds of attempts must send no gateway frame.
  const state = await until(
    (value) => value.launchId && value.launchId !== saved.online.launchId,
    'The restarted app is up offline',
    120000,
  );
  await delay(5000);
  const settled = await observe();
  receipt({ coldOfflineFrames: settled.framesSent, status: state.status });
  runList('offline-totals', ['--trigger=false', '--expect-total', total]);
} else if (phase === 'gate-offline-open') {
  // The gate review screen offline; its evidence images mount with the raw artifacts, which the
  // recipe opens once this screen is up (the open state does not survive the cold restart).
  await checkpoint('open-url', { url: gateUrl });
  await until((value) => value.gate?.opened === true, 'The gate review screen is up offline');
  receipt({ gateReviewOpenOffline: true });
} else if (phase === 'gate-offline') {
  // The gate review screen: its details, and its evidence images, each loaded by a mounted image and
  // verified in the store. Both sides of the diff are store-level; no Companion screen renders them.
  const [decisionId, runId, slotId] = args;
  assert.equal(decisionId, fixture.gate.decisionId);
  assert.equal(runId, fixture.gate.runId);
  assert.equal(slotId, fixture.gate.slotId);
  const expected = fixture.gate.images.map((image) => image.sha256);
  const covers = (rows, key) =>
    expected.every((sha) => rows?.some((row) => row.sha256 === sha && row[key]));
  const state = await until(
    (value) => value.gate?.opened && value.gate.details && covers(value.gate.images, 'loaded'),
    'The gate review opens offline with its images',
  );
  const review = {
    opened: true,
    details: true,
    imagesLoaded: true,
    imagesVerified: covers(state.gate.held?.images, 'verified'),
    bothSides: state.gate.held?.bothSides === true,
    framesSent: state.framesSent,
  };
  await writeState({ gateReview: review });
  receipt({
    gateReviewOffline: review.imagesVerified && review.bothSides && review.framesSent === 0,
    ...review,
  });
} else if (phase === 'gate-diff-offline') {
  // The gate's package diff, rendered by the run Diff screen.
  const [runId] = args;
  assert.equal(runId, fixture.gate.runId);
  const { gateReview } = await readState();
  await checkpoint('open-url', { url: `${scheme}:///workspace/run/${runId}/diff` });
  const state = await until(
    (value) => value.gate?.diff === true,
    'The run Diff screen renders the gate diff',
  );
  receipt({
    gateOfflineComplete:
      Boolean(gateReview) &&
      gateReview.imagesVerified &&
      gateReview.bothSides &&
      gateReview.framesSent === 0 &&
      state.framesSent === 0,
    diff: true,
    framesSent: state.framesSent,
  });
} else if (phase === 'catalog-offline') {
  const saved = await readState();
  const state = await until((value) => value.catalog?.models?.length > 0, 'Catalog offline');
  receipt({
    catalogRestoredSame: sameModels(state.catalog.models, saved.catalog),
    framesSent: state.framesSent,
  });
} else if (phase === 'upstream-offline') {
  const saved = await readState();
  await checkpoint('open-url', { url: `${scheme}:///prs` });
  const state = await until(
    (value) => value.upstream?.prs?.length >= saved.upstream.length,
    'PR rows offline',
  );
  receipt({
    upstreamRestoredSame: JSON.stringify(prRows(state)) === JSON.stringify(saved.upstream),
    framesSent: state.framesSent,
  });
} else if (phase === 'recover') {
  const saved = await readState();
  // K2 runs change while the gateway is down; the new epoch must catch up on exactly those.
  const { changedIds } = await checkpoint('change-runs', {
    runs: fixture.recoverChangedRuns,
    gatewayDown: true,
  });
  assert.deepEqual([...changedIds].sort(), [...fixture.recoverChangedRuns].sort());
  const since = Date.now();
  await checkpoint('gateway-start');
  await checkpoint('proxy-release');
  const state = await until(
    (value) =>
      value.status === 'connected' &&
      value.epoch !== saved.online.epoch &&
      value.upstream?.prs?.some(
        (row) => row.observedAt > Math.max(...saved.upstream.map((old) => old.observedAt)),
      ),
    'The app recovers upstream on the new epoch',
    180000,
  );
  receipt({ upstreamRecovered: true, epoch: state.epoch, changedIds });
  runList('recover-catch-up', [
    '--trigger=false',
    '--since',
    String(since),
    '--changed',
    changedIds.join(','),
  ]);
}

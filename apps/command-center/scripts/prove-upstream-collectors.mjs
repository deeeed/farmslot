// Prove gateway-owned upstream collectors in the real Command Center. Every source is a fake CLI
// in the private case; each viewer runs in its own visible window so its observers stay admitted.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const source = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const execute = promisify(execFile);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
const configFile = process.env.FARMSLOT_UPSTREAM_COLLECTORS_PROOF;
const config = JSON.parse(await readFile(configFile, 'utf8'));
assert.equal(config.sourceRoot, source);
const root = config.caseRoot;
const fixture = JSON.parse(await readFile(path.join(root, 'fixture.json'), 'utf8'));
const artifacts = path.join(root, 'client');
await mkdir(artifacts, { recursive: true });
const CDP = 'http://127.0.0.1:19222';
const UI = 'http://127.0.0.1:5208/';
const PR_HASH =
  '#prs?pr=7&repo=proof%2Fupstream-collectors&view=detail&prSection=prs&prScope=monitored' +
  '&prPane=monitoring&prEditor=monitor';
const METHODS = ['config.githubAccounts', 'pr.status', 'providerAccounts.snapshot'];
// The run-backed PR is an owned-family row of the persisted pr.list; the board shows it from there.
const LIST_HASH =
  '#prs?pr=8&repo=proof%2Fupstream-collectors&view=detail&prSection=prs&prScope=all&prPane=overview';
const LIST_TITLE = 'Run-backed upstream collector proof';
const STORED_PR_ERROR = 'The last GitHub check did not complete.';
const cdp = async (...args) =>
  JSON.parse(
    (
      await execute(
        process.execPath,
        [path.join(source, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { cwd: source, timeout: 65000, maxBuffer: 8 * 1024 * 1024 },
      )
    ).stdout,
  );
const inspect = (target) =>
  cdp(
    'eval',
    target,
    '--file',
    path.join(source, 'apps/command-center/scripts/probes/upstream-collectors.js'),
  );
async function until(check, label, target, timeout = 15000, interval = 250) {
  const end = Date.now() + timeout;
  let last;
  do {
    try {
      last = await inspect(target);
      if (check(last)) return last;
    } catch (error) {
      // A read-only probe can race a navigation or lazy module load; the deadline still applies.
      last = { probeError: error.message.slice(-500) };
    }
    await delay(interval);
  } while (Date.now() < end);
  await save('timeout-' + label.replace(/[^a-z0-9]+/gi, '-').slice(0, 60), last);
  const { stored, ...shown } = last ?? {};
  assert.fail(
    label +
      ': ' +
      JSON.stringify({ ...shown, storedRows: Object.keys(stored ?? {}) }).slice(0, 6000),
  );
}
const save = (name, value) =>
  writeFile(path.join(artifacts, name + '.json'), JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  });
const image = (name, target) => cdp('screenshot', target, path.join(artifacts, name + '.png'));
const url = (viewer, hash) =>
  `${UI}?upstream-proof=${encodeURIComponent(config.name)}&viewer=${viewer}${hash}`;
async function ownTabs(ids) {
  config.ownedTabIds = ids;
  await writeFile(configFile + '.tabs.tmp', JSON.stringify(config, null, 2) + '\n');
  await rename(configFile + '.tabs.tmp', configFile);
}

/** One CDP session to the browser, or to one exact page target. */
async function devtools(calls, target) {
  const endpoint = target
    ? (await (await fetch(CDP + '/json')).json()).find((page) => page.id === target.slice(1))
        ?.webSocketDebuggerUrl
    : (await (await fetch(CDP + '/json/version')).json()).webSocketDebuggerUrl;
  assert(endpoint, 'CDP target is missing');
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('Browser CDP socket failed'));
  });
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  let id = 0;
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const serial = ++id;
      pending.set(serial, (message) =>
        message.error ? reject(new Error(message.error.message)) : resolve(message.result),
      );
      socket.send(JSON.stringify({ id: serial, method, params }));
    });
  try {
    return await calls(call);
  } finally {
    socket.close();
  }
}
/** Navigate one owned page; a hash-only change keeps the same document and runtime. */
async function navigate(target, href) {
  await devtools(async (call) => {
    await call('Page.enable');
    await call('Page.navigate', { url: href });
  }, target);
  const wanted = new URL(href);
  return until(
    (value) => {
      if (!value.loaded) return false;
      const current = new URL(value.href);
      return (
        current.search === wanted.search && current.hash.split('?')[0] === wanted.hash.split('?')[0]
      );
    },
    'Navigation to ' + href,
    target,
    30000,
  );
}
/** A separate window keeps each viewer foreground; hidden documents retire their observers. */
async function openWindow(viewer, hash, bounds) {
  const targetId = await devtools(async (call) => {
    const { targetId } = await call('Target.createTarget', {
      url: url(viewer, hash),
      newWindow: true,
    });
    const { windowId } = await call('Browser.getWindowForTarget', { targetId });
    await call('Browser.setWindowBounds', { windowId, bounds });
    return targetId;
  });
  await ownTabs([...new Set([...(config.ownedTabIds ?? [config.tabId]), targetId])]);
  const target = '@' + targetId;
  let first = await until(
    (value) => value.loaded && (value.connection === 'connected' || value.auth),
    `Viewer ${viewer} must load the actual app`,
    target,
    30000,
  );
  if (first.auth) {
    assert((await cdp('login', target)).authenticated);
    first = await until(
      (value) => value.connection === 'connected',
      `Viewer ${viewer} login`,
      target,
      30000,
    );
  }
  assert.equal(first.visibility, 'visible', `Viewer ${viewer} must be a visible window`);
  const whatsNew = await cdp(
    'eval',
    target,
    "return Boolean(document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('.primary'))",
  );
  if (whatsNew) await cdp('click', target, 'whats-new-modal >>> .primary');
  return target;
}
async function closeWindow(target) {
  await cdp('close', target);
  await ownTabs((config.ownedTabIds ?? []).filter((id) => '@' + id !== target));
}
async function transition(name) {
  const result = JSON.parse(
    (
      await execute(
        process.execPath,
        [
          path.join(source, 'apps/command-center/scripts/upstream-collectors-proof-fixture.mjs'),
          'source',
          configFile,
          name,
        ],
        { cwd: source, timeout: 30000 },
      )
    ).stdout,
  );
  assert(result.completed);
  return result;
}
async function invocations() {
  return (await readFile(path.join(root, 'fake-invocations.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const accountReads = (rows) =>
  rows.filter((row) => row.tool === 'gh' && row.args.slice(0, 2).join(' ') === 'auth status');
const prReads = (rows) =>
  rows.filter(
    (row) =>
      row.tool === 'gh' &&
      row.args.slice(0, 2).join(' ') === 'pr view' &&
      row.args[2] === String(fixture.pr),
  );
const seatReads = (rows) =>
  rows.filter((row) => row.tool === 'claude' && row.args.join(' ') === 'auth status --json');
const sourceCalls = (rows) => rows.filter((row) => row.tool !== 'tmux');

/** Count gateway request frames that each mounted page actually sends. */
async function sentFrames(targets) {
  const list = await (await fetch(CDP + '/json')).json();
  const counts = {};
  const sockets = [];
  for (const target of targets) {
    const id = target.slice(1);
    const page = list.find((entry) => entry.id === id);
    assert(page, 'Frame counter target is missing');
    counts[id] = {};
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('Page CDP socket failed'));
    });
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method !== 'Network.webSocketFrameSent') return;
      if (message.params.response.opcode !== 1) return;
      const raw = message.params.response.payloadData;
      if (!raw.startsWith('{')) return;
      const frame = JSON.parse(raw);
      if (frame.type === 'req') counts[id][frame.method] = (counts[id][frame.method] ?? 0) + 1;
    };
    socket.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
    sockets.push({ id, socket });
  }
  // A hidden document retires its observers, so a quiet hidden viewer would prove nothing.
  const visibility = [];
  let serial = 1;
  const sample = () => {
    for (const { id, socket } of sockets) {
      const request = ++serial;
      const listener = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== request) return;
        socket.removeEventListener('message', listener);
        visibility.push({ id, at: Date.now(), state: message.result?.result?.value });
      };
      socket.addEventListener('message', listener);
      socket.send(
        JSON.stringify({
          id: request,
          method: 'Runtime.evaluate',
          params: { expression: 'document.visibilityState', returnByValue: true },
        }),
      );
    }
  };
  sample();
  const timer = setInterval(sample, 2000);
  const started = Date.now();
  return {
    started,
    stop() {
      clearInterval(timer);
      for (const { socket } of sockets) socket.close();
      return { elapsedMs: Date.now() - started, counts, visibility };
    },
  };
}
const state = JSON.parse(await readFile(fixture.stateFile, 'utf8'));
const FORBIDDEN = [
  fixture.marker,
  state.github.token,
  fixture.osHome,
  fixture.farm,
  'auth status --json',
  'provider-account-cli',
  'cd "$HOME"',
  'fake claude failed',
  'fake gh failed',
  'empty-output',
  'auth-file-missing',
  'tokenSource',
  'inspection',
  'GitHub returned no state',
];
const leaks = (value) => FORBIDDEN.filter((needle) => JSON.stringify(value).includes(needle));
const keysOnly = (value, allowed) =>
  value && typeof value === 'object' && Object.keys(value).every((key) => allowed.includes(key));
function storedSeatsSanitized(row) {
  assert(row?.data?.machines?.length, 'Stored seats row is missing');
  for (const machine of row.data.machines)
    for (const runner of machine.runners) {
      assert(!Object.hasOwn(runner, 'error'), 'Stored seat keeps a raw probe error');
      assert(!runner.usage || !Object.hasOwn(runner.usage, 'error'), 'Stored usage keeps an error');
      assert(!runner.inventory || !Object.hasOwn(runner.inventory, 'inspection'));
    }
  return leaks(row);
}
const claude = (seats) =>
  seats?.data?.machines?.[0]?.runners.find((runner) => runner.runner === 'claude');
const evidence = { windows: {} };
const claims = {};

const A = '@' + config.tabId;
// ── Runner seats: fleet map Setup modal ──
await cdp('click', A, '[data-testid="machine-accounts-btn"]');
const seatsOwner = await until(
  (value) =>
    value.seats?.ready &&
    value.seats.canonical &&
    value.persistent &&
    value.stored.seats &&
    value.setup?.open &&
    value.setup.rows.some((row) => row.runner === 'claude'),
  'The owner Setup modal must show current, persisted runner seats',
  A,
  30000,
);
assert.equal(seatsOwner.principalId, fixture.actorId);
assert(seatsOwner.collectorMethods.includes('providerAccounts.snapshot'));
assert.equal(claude(seatsOwner.seats).usage.accountEmail, 'seat-a@example.invalid');
assert.equal(seatReads(await invocations()).length, 1, 'One mounted owner samples seats once');
await save('seats-owner', seatsOwner);
await image('seats-owner', A);
// Non-overlapping windows: Chrome marks a mostly covered window hidden. No viewport resize either,
// because it resizes the real window over its neighbours.
const B = await openWindow('second', '#fleet', { left: 900, top: 39, width: 900, height: 520 });
evidence.windows.second = B;
await cdp('click', B, '[data-testid="machine-accounts-btn"]');
const seatsSecond = await until(
  (value) => value.seats?.ready && value.seats.canonical && value.setup?.open,
  'A second visible viewer must mount the same seats observation',
  B,
  30000,
);
assert.equal(seatsSecond.persistent, false, 'Only the owner may hold persistent SQLite');
assert.equal(
  seatsSecond.seats.sourceObservation.observedAt,
  seatsOwner.seats.sourceObservation.observedAt,
);
assert.equal(seatReads(await invocations()).length, 1, 'A second viewer must not resample seats');
await save('seats-second', seatsSecond);
await image('seats-second', B);

await transition('seats-change');
let before = seatReads(await invocations()).length;
await cdp('click', A, '[data-testid="machine-accounts-refresh"]');
const seatsNotified = await until(
  (value) =>
    value.seats?.ready &&
    claude(value.seats)?.usage?.accountEmail === 'seat-b@example.invalid' &&
    value.setup.rows.some((row) => row.text.includes('seat-b@example.invalid')),
  'The other viewer must receive the explicit seat verification without its own action',
  B,
  45000,
);
assert.equal(seatReads(await invocations()).length, before + 1);
assert(
  seatsNotified.seats.sourceObservation.observedAt > seatsOwner.seats.sourceObservation.observedAt,
);
await save('seats-notified', seatsNotified);
await image('seats-notified', B);

await transition('seats-fail');
await cdp('click', A, '[data-testid="machine-accounts-refresh"]');
const failedSeat = (value) =>
  value.seats?.sourceObservation?.status === 'stale' &&
  claude(value.seats)?.observations?.identity?.error?.code === 'PROVIDER_IDENTITY_UNAVAILABLE';
const seatsFailedOwner = await until(
  (value) => failedSeat(value) && value.stored.seats,
  'A failed seat probe must retain the last success on the owner',
  A,
  45000,
);
const seatsFailed = await until(
  failedSeat,
  'A failed seat probe must reach the other viewer',
  B,
  45000,
);
for (const value of [seatsFailedOwner, seatsFailed]) {
  const row = claude(value.seats);
  assert.equal(row.usage.accountEmail, 'seat-b@example.invalid');
  assert.equal(
    row.observations.identity.observedAt,
    seatsNotified.seats.sourceObservation.observedAt,
  );
  assert.equal(
    value.seats.sourceObservation.observedAt,
    seatsNotified.seats.sourceObservation.observedAt,
  );
  assert(value.setup.rows.some((item) => item.text.includes('seat-b@example.invalid')));
  assert(value.setup.rows.find((item) => item.runner === 'claude').title.includes(fixture.marker));
  assert.equal(
    value.setup.age,
    seatsNotified.setup.age,
    'The modal keeps the original snapshot age',
  );
}
// The live row carries raw diagnostics; the owner's actual SQLite row must not.
assert(JSON.stringify(seatsFailedOwner.seats.data).includes(fixture.marker));
assert(JSON.stringify(seatsFailedOwner.seats.data).includes('provider-account-cli'));
assert.deepEqual(storedSeatsSanitized(seatsFailedOwner.stored.seats), []);
await save('seats-failed-owner', seatsFailedOwner);
await save('seats-failed', seatsFailed);
await image('seats-failed', B);

await transition('seats-repair');
await cdp('click', A, '[data-testid="machine-accounts-refresh"]');
const seatsRecovered = await until(
  (value) =>
    value.seats?.ready &&
    value.seats.sourceObservation.status === 'ready' &&
    value.seats.sourceObservation.observedAt > seatsNotified.seats.sourceObservation.observedAt,
  'The other viewer must return to a current seat observation',
  B,
  45000,
);
await save('seats-recovered', seatsRecovered);

// ── GitHub accounts and PR detail: PR board selected PR with the monitor account picker ──
before = await invocations();
await navigate(A, url('owner', PR_HASH));
const prOwner = await until(
  (value) =>
    value.accounts?.ready &&
    value.accounts.canonical &&
    value.prDetail?.ready &&
    value.prDetail.canonical &&
    value.persistent &&
    value.stored.accounts &&
    value.stored.prDetail &&
    value.picker?.visible &&
    value.detail?.title === state.pr.title,
  'The owner must show current, persisted accounts and PR detail',
  A,
  30000,
);
assert.equal(prOwner.timeOrigin, seatsOwner.timeOrigin, 'Route changes keep the owner runtime');
let rows = await invocations();
assert.equal(accountReads(rows).length - accountReads(before).length, 1);
assert.equal(prReads(rows).length - prReads(before).length, 1);
await save('pr-owner', prOwner);
await image('pr-owner', A);
await navigate(B, url('second', PR_HASH));
const prSecond = await until(
  (value) =>
    value.accounts?.ready &&
    value.accounts.canonical &&
    value.prDetail?.ready &&
    value.prDetail.canonical &&
    value.picker?.visible &&
    value.detail?.title === state.pr.title,
  'The second viewer must mount the same accounts and PR detail observations',
  B,
  30000,
);
assert.equal(prSecond.persistent, false);
assert.equal(
  prSecond.accounts.sourceObservation.observedAt,
  prOwner.accounts.sourceObservation.observedAt,
);
assert.equal(
  prSecond.prDetail.sourceObservation.observedAt,
  prOwner.prDetail.sourceObservation.observedAt,
);
const shared = await invocations();
assert.equal(accountReads(shared).length, accountReads(rows).length, 'No second account sample');
assert.equal(prReads(shared).length, prReads(rows).length, 'No second PR sample');
await save('pr-second', prSecond);
await image('pr-second', B);
const prChange = await transition('pr-change');
const prBaseline = prOwner.prDetail.sourceObservation.observedAt;

await transition('accounts-change');
before = accountReads(await invocations()).length;
await cdp('click', A, '[data-testid="pr-github-accounts-refresh"]');
const accountsNotified = await until(
  (value) =>
    value.accounts?.ready &&
    value.accounts.data.accounts.some((account) => account.login === 'proof-second') &&
    value.picker.accounts.includes('proof-second'),
  'The other viewer must receive the explicit account verification',
  B,
  30000,
);
assert.equal(accountReads(await invocations()).length, before + 1);
await save('accounts-notified', accountsNotified);
await image('accounts-notified', B);

await transition('accounts-fail');
await cdp('click', A, '[data-testid="pr-github-accounts-refresh"]');
const failedAccounts = (value) =>
  value.accounts?.sourceObservation?.status === 'stale' &&
  value.accounts.sourceObservation.error?.code === 'GITHUB_ACCOUNTS_UNAVAILABLE';
const accountsFailedOwner = await until(failedAccounts, 'Owner account failure', A, 30000);
const accountsFailed = await until(failedAccounts, 'Other viewer account failure', B, 30000);
for (const value of [accountsFailedOwner, accountsFailed]) {
  assert.deepEqual(
    value.accounts.data.accounts.map((account) => account.login),
    ['proof-primary', 'proof-second'],
  );
  assert.equal(
    value.accounts.sourceObservation.observedAt,
    accountsNotified.accounts.sourceObservation.observedAt,
  );
  assert(value.picker.error?.startsWith('Cannot verify gateway GitHub accounts.'));
  assert(value.picker.accounts.includes('proof-second'));
}
assert.deepEqual(leaks(accountsFailedOwner.stored.accounts), []);
assert(
  accountsFailedOwner.stored.accounts.data.accounts.every((account) =>
    keysOnly(account, ['host', 'login', 'active']),
  ),
);
await save('accounts-failed-owner', accountsFailedOwner);
await save('accounts-failed', accountsFailed);
await image('accounts-failed', B);

await transition('accounts-repair');
await cdp('click', A, '[data-testid="pr-github-accounts-refresh"]');
const accountsRecovered = await until(
  (value) =>
    value.accounts?.sourceObservation?.status === 'ready' &&
    value.accounts.sourceObservation.observedAt >
      accountsNotified.accounts.sourceObservation.observedAt &&
    !value.picker.error,
  'The other viewer must return to current accounts',
  B,
  30000,
);
await save('accounts-recovered', accountsRecovered);

// PR detail has no explicit check here; its passive collector carries the change to both.
const revised = (value) =>
  value.prDetail?.data?.pr.title === 'Offline upstream collectors proof (source revised)';
const prNotifiedOwner = await until(
  (value) => revised(value) && value.detail?.title === value.prDetail.data.pr.title,
  'The passive PR collector must update the owner without Refresh',
  A,
  200000,
  1000,
);
const prNotified = await until(
  (value) => revised(value) && value.detail?.title === value.prDetail.data.pr.title,
  'The passive PR collector must update the other viewer without Refresh',
  B,
  15000,
);
const prNotifiedAt = prNotifiedOwner.prDetail.sourceObservation.observedAt;
assert.equal(prNotified.prDetail.sourceObservation.observedAt, prNotifiedAt);
assert(prNotifiedAt - prBaseline >= 60000, 'Passive PR cadence is at least one minute');
const changed = prReads(await invocations()).filter(
  (row) => row.stateRevision >= prChange.revision && row.at <= prNotifiedAt,
);
assert.equal(changed.length, 1, 'Both viewers share one PR sample of the change');
assert.deepEqual(
  prNotified.prDetail.data.pr.checks.map((check) => check.status),
  ['pass', 'pass'],
);
await save('pr-notified', prNotified);
await image('pr-notified', B);

await transition('pr-fail');
const failedPR = (value) =>
  value.prDetail?.sourceObservation?.status === 'stale' &&
  value.prDetail.sourceObservation.error?.code === 'UPSTREAM_UNAVAILABLE';
const prFailedOwner = await until(
  (value) => failedPR(value) && value.stored.prDetail?.data.observation?.error,
  'A failed passive PR read must retain the owner value',
  A,
  260000,
  1000,
);
const prFailed = await until(failedPR, 'A failed PR read must reach the other viewer', B, 15000);
for (const value of [prFailedOwner, prFailed]) {
  assert(revised(value));
  assert.equal(value.prDetail.sourceObservation.observedAt, prNotifiedAt);
  assert.equal(value.detail.title, value.prDetail.data.pr.title);
}
assert.notEqual(prFailedOwner.prDetail.sourceObservation.error.message, STORED_PR_ERROR);
assert.equal(prFailedOwner.stored.prDetail.data.observation.error.message, STORED_PR_ERROR);
assert.equal(prFailedOwner.stored.prDetail.data.observation.observedAt, prNotifiedAt);
assert(keysOnly(prFailedOwner.stored.prDetail.data, ['pr', 'observation']));
assert.deepEqual(leaks(prFailedOwner.stored.prDetail), []);
await save('pr-failed-owner', prFailedOwner);
await save('pr-failed', prFailed);
await image('pr-failed', B);

await transition('pr-repair');
const prRecoveredOwner = await until(
  (value) =>
    value.prDetail?.sourceObservation?.status === 'ready' &&
    value.prDetail.sourceObservation.observedAt > prNotifiedAt,
  'The passive PR collector must recover the owner',
  A,
  260000,
  1000,
);
const prRecovered = await until(
  (value) =>
    value.prDetail?.sourceObservation?.observedAt ===
    prRecoveredOwner.prDetail.sourceObservation.observedAt,
  'The other viewer must recover with the same sample',
  B,
  15000,
);
await save('pr-recovered', prRecovered);

// ── Settled panels: all three readers mounted in visible windows, sources idle ──
const C = await openWindow('fleet', '#fleet', { left: 900, top: 580, width: 900, height: 520 });
evidence.windows.fleet = C;
await cdp('click', C, '[data-testid="machine-accounts-btn"]');
await until((value) => value.seats?.ready && value.setup?.open, 'Fleet viewer seats', C, 30000);
// Reset the five-minute account and seat clocks so no passive sample falls in the window.
await cdp('click', A, '[data-testid="pr-github-accounts-refresh"]');
await cdp('click', C, '[data-testid="machine-accounts-refresh"]');
await until((value) => value.accounts?.ready && value.prDetail?.ready, 'Owner settles', A, 30000);
await delay(3000);
let idle;
for (let attempt = 1; attempt <= 5 && !idle; attempt += 1) {
  // A viewer hidden by the desktop (another Space or app) retires its observers; re-settle first.
  let settled = await Promise.all([A, B, C].map(inspect));
  if (settled.some((value) => value.visibility !== 'visible')) {
    await save(
      `idle-hidden-${attempt}`,
      settled.map(({ visibility }) => visibility),
    );
    await delay(10000);
    continue;
  }
  const sinceSample = Date.now() - settled[0].prDetail.sourceObservation.observedAt;
  if (sinceSample > 45000) {
    // Start right after a passive PR sample; the next one is at least two ticks away.
    const last = settled[0].prDetail.sourceObservation.observedAt;
    await until(
      (value) => value.prDetail?.sourceObservation?.observedAt > last,
      'Next passive PR sample',
      A,
      200000,
      500,
    );
    await delay(3000);
    settled = await Promise.all([A, B, C].map(inspect));
  }
  const startRows = (await invocations()).length;
  const counter = await sentFrames([A, B, C]);
  await delay(62000);
  const frames = counter.stop();
  const during = sourceCalls((await invocations()).slice(startRows));
  const panelReads = Object.values(frames.counts).reduce(
    (sum, counts) => sum + METHODS.reduce((total, method) => total + (counts[method] ?? 0), 0),
    0,
  );
  const visible =
    frames.visibility.length >= 3 * 25 &&
    frames.visibility.every((entry) => entry.state === 'visible');
  const result = {
    attempt,
    frames,
    sourceCallsDuring: during,
    panelReads,
    visible,
    methods: METHODS,
  };
  await save(`idle-attempt-${attempt}`, result);
  // Only a window with every viewer visible and no source sample can test idle panels.
  if (visible && !during.length) idle = result;
}
assert(idle, 'No idle window with visible viewers and no collector sample');
assert(idle.frames.elapsedMs >= 61000);
assert.equal(idle.panelReads, 0, 'Settled panels must not read collector observations');
const settled = await Promise.all([A, B, C].map(inspect));
assert(settled[0].accounts.ready && settled[0].prDetail.ready && settled[2].seats.ready);
assert.deepEqual(
  settled.map((value) => value.persistent),
  [true, false, false],
);
await save('idle', { ...idle, settled });

// ── Durable projection of every collector the owner stored ──
await navigate(A, url('owner', '#fleet'));
await cdp('click', A, '[data-testid="machine-accounts-btn"]');
const ownerFleet = await until(
  (value) => value.seats?.ready && value.stored.seats && value.setup?.open,
  'Owner stores the current seats before the outage',
  A,
  30000,
);
await navigate(A, url('owner', LIST_HASH));
const listOwner = await until(
  (value) =>
    value.prList?.status === 'ready' &&
    value.prList.rows?.some((row) => row.pr === fixture.listPr && row.ownedFamily) &&
    value.stored.prList?.data.prs.some((row) => row.pr === fixture.listPr) &&
    value.detail?.title === LIST_TITLE &&
    value.board?.card?.includes(LIST_TITLE),
  'The board shows the run-backed PR from the persisted pr.list',
  A,
  60000,
);
assert.equal(listOwner.prDetail, undefined, 'A listed PR needs no separate detail read');
await save('pr-list-owner', listOwner);
await image('pr-list-owner', A);
await navigate(A, url('owner', PR_HASH));
const beforeCold = await until(
  (value) =>
    value.accounts?.ready &&
    value.prDetail?.ready &&
    value.stored.accounts &&
    value.stored.prDetail &&
    value.stored.seats &&
    value.stored.prList,
  'Owner has every stored observation',
  A,
  30000,
);
assert.deepEqual(storedSeatsSanitized(beforeCold.stored.seats), []);
assert.deepEqual(leaks(beforeCold.stored), []);
assert(JSON.stringify(ownerFleet.seats.data).includes('provider-account-cli'));
await save('durable', { stored: beforeCold.stored, forbidden: FORBIDDEN.length });
for (const target of [C, B]) await closeWindow(target);

// ── Cold offline: controller stops the gateway; a new runtime restores SQLite ──
async function checkpoint(name) {
  const request = path.join(artifacts, name + '-request.json');
  await writeFile(request + '.tmp', JSON.stringify({ case: config.name, tabId: config.tabId }));
  await rename(request + '.tmp', request);
  const end = Date.now() + 60000;
  while (true) {
    try {
      const ack = JSON.parse(await readFile(path.join(artifacts, name + '-ack.json'), 'utf8'));
      assert.equal(ack.case, config.name);
      assert.equal(ack.tabId, config.tabId);
      return ack;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    assert(Date.now() < end, name + ' controller acknowledgement deadline');
    await delay(80);
  }
}
await checkpoint('cold-outage');
await until(
  (value) => value.connection !== 'connected',
  'The owned gateway must actually be disconnected',
  A,
  30000,
);
const coldFrames = await sentFrames([A]);
await devtools(async (call) => {
  await call('Page.enable');
  await call('Page.navigate', { url: url('owner-cold', LIST_HASH) });
}, A);
const coldPR = await until(
  (value) =>
    value.timeOrigin > beforeCold.timeOrigin &&
    value.persistent &&
    value.connection !== 'connected' &&
    value.accounts?.status === 'stale' &&
    value.accounts.data &&
    value.prList?.status === 'stale' &&
    value.prList.rows?.some((row) => row.pr === fixture.listPr && row.ownedFamily) &&
    value.detail?.title === LIST_TITLE &&
    value.board?.card?.includes(LIST_TITLE) &&
    value.board.banner?.startsWith('Saved PRs,'),
  'A new offline runtime must restore stored accounts and the listed PR detail',
  A,
  45000,
);
// The rows can only have advanced between the pre-outage read and the gateway stop.
const coldAccounts = coldPR.stored.accounts;
assert(
  coldAccounts.data.observation.observedAt >=
    beforeCold.stored.accounts.data.observation.observedAt,
);
assert.deepEqual(coldPR.accounts.data, coldAccounts.data);
assert.equal(
  coldPR.accounts.sourceObservation.observedAt,
  coldAccounts.data.observation.observedAt,
);
assert(
  coldAccounts.data.observation.observedAt < coldPR.timeOrigin,
  'Restored age predates runtime',
);
assert(coldPR.checkGitHub.every((button) => button.disabled));
// PR detail offline comes from the persisted list row: its stored source age, shown as saved.
const coldList = coldPR.stored.prList;
assert(
  coldList.data.observation.observedAt >= beforeCold.stored.prList.data.observation.observedAt,
);
assert.deepEqual(coldPR.prList.data, coldList.data);
assert.equal(coldPR.prList.sourceObservation.observedAt, coldList.data.observation.observedAt);
assert(
  coldList.data.observation.observedAt < coldPR.timeOrigin,
  'Restored PR age predates runtime',
);
// Recorded, not required: account rows restore but their picker lives in monitor editors, and the
// monitored PR's own detail row needs the memory-only monitor list to mount.
const coldNotes = {
  accountPickerMounted: Boolean(coldPR.picker),
  monitoredDetailStored: Boolean(coldPR.stored.prDetail?.data?.pr),
};
await image('cold-pr', A);
await navigate(A, url('owner-cold', '#fleet'));
await cdp('click', A, '[data-testid="machine-accounts-btn"]');
const coldSeats = await until(
  (value) =>
    value.timeOrigin === coldPR.timeOrigin &&
    value.seats?.status === 'stale' &&
    value.seats.data &&
    value.setup?.open &&
    value.setup.rows.length,
  'The cold runtime must restore stored seats',
  A,
  30000,
);
assert.deepEqual(coldSeats.seats.data, coldSeats.stored.seats.data);
assert.equal(
  coldSeats.seats.sourceObservation.observedAt,
  coldSeats.stored.seats.data.observation.observedAt,
);
assert(coldSeats.seats.sourceObservation.observedAt < coldPR.timeOrigin);
assert(coldSeats.setup.age, 'The cold Setup modal shows its saved snapshot time');
assert(coldSeats.setup.refresh.length, 'The cold Setup modal renders Refresh');
assert(
  [...coldSeats.setup.refresh, ...coldSeats.setup.retry].every((button) => button.disabled),
  'Seat Refresh and Retry are disabled offline',
);
await image('cold-seats', A);
// Keep counting while the restored panels sit offline and the client retries its socket.
await delay(10000);
const offlineFrames = coldFrames.stop();
const offlineReads = Object.values(offlineFrames.counts).reduce(
  (sum, counts) => sum + Object.values(counts).reduce((total, count) => total + count, 0),
  0,
);
assert.equal(offlineReads, 0, 'Cold restoration sends no gateway reads');
await save('cold', { coldPR, coldSeats, offlineFrames, coldNotes });

await checkpoint('cold-recovery');
const recoveredSeats = await until(
  (value) =>
    value.connection === 'connected' &&
    value.seats?.ready &&
    value.seats.sourceObservation.observedAt > coldSeats.seats.sourceObservation.observedAt,
  'The same cold runtime must recover seats',
  A,
  60000,
  500,
);
assert.equal(recoveredSeats.timeOrigin, coldPR.timeOrigin);
await image('recovered-seats', A);
await navigate(A, url('owner-cold', PR_HASH));
const recoveredPR = await until(
  (value) =>
    value.connection === 'connected' &&
    value.accounts?.ready &&
    value.prDetail?.ready &&
    value.accounts.sourceObservation.observedAt > coldPR.accounts.sourceObservation.observedAt &&
    value.prDetail.sourceObservation.observedAt >
      coldPR.stored.prDetail.data.observation.observedAt &&
    value.detail?.title === value.prDetail.data.pr.title &&
    value.picker?.refresh.every((button) => !button.disabled),
  'The same cold runtime must recover accounts and PR detail',
  A,
  60000,
  500,
);
assert.equal(recoveredPR.timeOrigin, coldPR.timeOrigin);
await save('recovered', { recoveredSeats, recoveredPR });
await image('recovered-pr', A);

// ── Every source answer came from the case's fakes under the gateway's restricted environment ──
rows = await invocations();
const expectedPath = `${fixture.fakeBin}:/usr/bin:/bin`;
// Slot commands prepend $HOME/.asdf/shims; HOME is the case's empty directory, so it adds nothing.
const allowedPaths = [expectedPath, `${fixture.osHome}/.asdf/shims:${expectedPath}`];
assert(rows.every((row) => allowedPaths.includes(row.path) && row.home === fixture.osHome));
for (const sourceName of [
  'github-accounts',
  'pr-detail:view',
  'pr-detail:checks',
  'seats:claude',
  'seats:codexbar',
  'seats:codex',
  'seats:cursor',
])
  assert(
    rows.some((row) => row.source === sourceName && row.outcome === 'ok'),
    sourceName,
  );
const unsupported = rows.filter((row) => row.outcome === 'unsupported');
await save('invocations', {
  total: rows.length,
  unsupported,
  bySource: rows.reduce(
    (counts, row) => ({ ...counts, [row.source]: (counts[row.source] ?? 0) + 1 }),
    {},
  ),
});
Object.assign(claims, {
  upstreamSharedSampling: true,
  upstreamSourceNotification: true,
  upstreamErrorRetention: true,
  upstreamNoIdleReads: true,
  upstreamColdOffline: true,
  upstreamColdRecovery: true,
  upstreamDurableSanitization: true,
  upstreamFakeSourcesOnly: true,
});
await save('result', { claims, evidence });
console.log(JSON.stringify(claims));

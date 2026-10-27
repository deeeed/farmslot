// Prove conditional file edits and the D08 slot-workspace targets in the real Command Center
// against a private gateway, two real farmslot nodes and fake gh and git. Node B advertises no
// conditional writes, and the capability-off checkpoint restarts the gateway without the
// capability; both through a lane-side preload, never a product switch. Another lane-side preload
// holds the gateway's first two writes of the ready slot's src/after-save.ts for 8 s, so the proof
// types while a save is in flight; the offline step stops the gateway.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const source = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const execute = promisify(execFile);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
const configFile = process.env.FARMSLOT_CONDITIONAL_EDITS_PROOF;
const config = JSON.parse(await readFile(configFile, 'utf8'));
assert.equal(config.sourceRoot, source);
const root = config.caseRoot;
const fixture = JSON.parse(await readFile(path.join(root, 'fixture.json'), 'utf8'));
const artifacts = path.join(root, 'client');
await mkdir(artifacts, { recursive: true });
const WebSocket = createRequire(path.join(source, 'package.json'))('ws');
const CDP = 'http://127.0.0.1:19222';
const UI = 'http://127.0.0.1:5208/';
const probeSource = await readFile(
  path.join(source, 'apps/command-center/scripts/probes/conditional-edits.js'),
  'utf8',
);
// Explore cases may run a subset of phases; a recorded proof always runs them all.
const PHASES = process.env.D11_PHASES ? new Set(process.env.D11_PHASES.split(',')) : null;
assert(!PHASES || config.explore, 'Phase selection is for explore cases only');
const phase = (name) => !PHASES || PHASES.has(name);
const PRECONDITION_UNSUPPORTED = 'FS_PRECONDITION_UNSUPPORTED';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const slots = fixture.slots;

const cdp = async (args, env = process.env) =>
  JSON.parse(
    (
      await execute(
        process.execPath,
        [path.join(source, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { cwd: source, timeout: 120000, maxBuffer: 16 * 1024 * 1024, env },
      )
    ).stdout,
  );
let probeSerial = 0;
/** Every time a probed page was hidden and brought back to front. */
const fronted = [];
/**
 * A hidden document is background by design: its cache marks every read stale and reads nothing.
 * Another window can hide a proof page, so a hidden page is brought to front and read again.
 */
async function inspect(target, params) {
  const file = path.join(artifacts, `.probe-${++probeSerial % 4}.js`);
  await writeFile(file, `const PARAMS = ${JSON.stringify(params ?? {})};\n${probeSource}`);
  const value = await cdp(['eval', target, '--file', file]);
  if (value.visibility === 'visible') return value;
  await bringToFront(target, value.visibility);
  return cdp(['eval', target, '--file', file]);
}
// cdp.mjs prints a string result as plain text, so the state comes back inside an object.
const visibilityOf = async (target) =>
  (await cdp(['eval', target, 'return { visibility: document.visibilityState }'])).visibility;
async function bringToFront(target, visibility) {
  fronted.push({ target, wall: Date.now(), visibility });
  await devtools((call) => call('Page.bringToFront'), target);
  await waitFor(async () => (await visibilityOf(target)) === 'visible', `${target} is visible`, {
    timeout: 15000,
  });
}
async function until(check, label, target, { timeout = 30000, interval = 400, params } = {}) {
  const end = Date.now() + timeout;
  let last;
  do {
    try {
      last = await inspect(target, params);
      if (last.visibility === 'visible' && check(last)) return last;
    } catch (error) {
      // A read-only probe can race a navigation or lazy module load; the deadline still applies.
      last = { probeError: error.message.slice(-500) };
    }
    await delay(interval);
  } while (Date.now() < end);
  await save('timeout-' + label.replace(/[^a-z0-9]+/gi, '-').slice(0, 60), last);
  assert.fail(label + ': ' + JSON.stringify(last).slice(0, 6000));
}
/** With a target, the page that must read for the check stays in front and visible. */
async function waitFor(check, label, { timeout = 30000, interval = 250, target } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (target) {
      const visibility = await visibilityOf(target);
      if (visibility !== 'visible') await bringToFront(target, visibility);
    }
    const value = await check();
    if (value) return value;
    await delay(interval);
  }
  assert.fail(label);
}
const save = (name, value) =>
  writeFile(path.join(artifacts, name + '.json'), JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  });
const image = (name, target) => cdp(['screenshot', target, path.join(artifacts, name + '.png')]);
const url = (viewer, hash) =>
  `${UI}?edit-proof=${encodeURIComponent(config.name)}&viewer=${viewer}${hash}`;
const slotRoute = (key, file) =>
  `#slot/${slots[key].id}${file ? `?file=${encodeURIComponent(file)}` : ''}`;
const readSlotFile = (key, file) => readFile(path.join(slots[key].repo, file), 'utf8');

/** One CDP session to the browser, or to one exact page target. */
async function devtools(calls, target) {
  const endpoint = target
    ? (await (await fetch(CDP + '/json')).json()).find((page) => page.id === target.slice(1))
        ?.webSocketDebuggerUrl
    : (await (await fetch(CDP + '/json/version')).json()).webSocketDebuggerUrl;
  assert(endpoint, 'CDP target is missing');
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const pending = new Map();
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
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
const navigate = (target, href) =>
  devtools(async (call) => {
    await call('Page.enable');
    await call('Page.navigate', { url: href });
  }, target);
/** Close the page's live gateway socket; the client reconnects on a new connection. */
const dropGatewaySocket = (target) =>
  devtools(async (call) => {
    await call('Runtime.enable');
    const prototype = await call('Runtime.evaluate', { expression: 'WebSocket.prototype' });
    const sockets = await call('Runtime.queryObjects', {
      prototypeObjectId: prototype.result.objectId,
      objectGroup: 'conditional-edits-proof',
    });
    const closed = await call('Runtime.callFunctionOn', {
      objectId: sockets.objects.objectId,
      functionDeclaration: `function() {
        let count = 0;
        for (const socket of this)
          if (socket.readyState === WebSocket.OPEN && new URL(socket.url).pathname === '/ws') {
            socket.close(1000, 'Conditional edits proof reconnect');
            count++;
          }
        return count;
      }`,
      returnByValue: true,
    });
    await call('Runtime.releaseObjectGroup', { objectGroup: 'conditional-edits-proof' });
    return closed.result.value;
  }, target);
/** Real pointer input at the centre of the first matching element, searched across shadow roots. */
const clickElement = (target, selector, textIncludes) =>
  devtools(async (call) => {
    await call('Page.bringToFront');
    const { result, exceptionDetails } = await call('Runtime.evaluate', {
      expression: `(() => {
        const all = (root, found = []) => {
          found.push(...root.querySelectorAll(${JSON.stringify(selector)}));
          for (const node of root.querySelectorAll('*')) if (node.shadowRoot) all(node.shadowRoot, found);
          return found;
        };
        const text = ${JSON.stringify(textIncludes ?? null)};
        const element = all(document).find(
          (node) => node.getClientRects().length > 0 && (text === null || node.textContent.includes(text)),
        );
        if (!element) throw new Error('Click target missing');
        element.scrollIntoView({ block: 'center' });
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? selector);
    for (const type of ['mousePressed', 'mouseReleased'])
      await call('Input.dispatchMouseEvent', {
        type,
        ...result.value,
        button: 'left',
        clickCount: 1,
      });
  }, target);
/** Real keys: an optional chord, then text inserted at the caret. */
const typeKeys = (target, { chord, text, enter = false }) =>
  devtools(async (call) => {
    if (chord)
      for (const type of ['rawKeyDown', 'keyUp'])
        await call('Input.dispatchKeyEvent', { type, ...chord });
    if (text) await call('Input.insertText', { text });
    if (enter)
      for (const type of ['rawKeyDown', 'char', 'keyUp'])
        await call('Input.dispatchKeyEvent', {
          type,
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          ...(type === 'char' ? { text: '\r' } : {}),
        });
  }, target);
const editorWidth = (target) =>
  cdp([
    'eval',
    target,
    `const all=(root,found=[])=>{found.push(...root.querySelectorAll('.monaco-editor'));for(const node of root.querySelectorAll('*'))if(node.shadowRoot)all(node.shadowRoot,found);return found;};return Math.max(0,...all(document).filter((node)=>node.getClientRects().length>0).map((node)=>node.getBoundingClientRect().width))`,
  ]);
/** A busy slot can open its run drawer and task panel beside the editor; close them for room. */
async function ensureEditorRoom(target) {
  for (const selector of [
    '.sv-review-header button.sv-task-panel-close:not([title])',
    '.sv-task-panel-header .sv-task-panel-close',
  ]) {
    if ((await editorWidth(target)) >= 300) return;
    await clickElement(target, selector).catch(() => undefined);
    await delay(400);
  }
  assert((await editorWidth(target)) >= 300, 'The editor has room to type');
}
/** Append a line at the end of the open file, as a user typing in the editor. */
async function typeInEditor(target, line) {
  await ensureEditorRoom(target);
  // The editor's centre is always inside its visible text area; its header sits above the lines.
  await clickElement(target, '.monaco-editor');
  // Cmd+ArrowDown moves the caret to the end of the document on macOS.
  await typeKeys(target, {
    chord: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, modifiers: 4 },
    text: `\n${line}`,
  });
}
async function ownTabs(ids) {
  config.ownedTabIds = ids;
  await writeFile(configFile + '.tabs.tmp', JSON.stringify(config, null, 2) + '\n');
  await rename(configFile + '.tabs.tmp', configFile);
}
/** A separate window keeps each viewer foreground; hidden documents retire their reads. */
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
  return '@' + targetId;
}
async function closeWindow(target) {
  await devtools((call) => call('Target.closeTarget', { targetId: target.slice(1) }));
  await ownTabs((config.ownedTabIds ?? []).filter((id) => id !== target.slice(1)));
}
let checkpointSerial = 0;
/** One controller action: services, fixture writes or fake state. Waits for its acknowledgement. */
async function checkpoint(action, args = {}) {
  const step = `${String(++checkpointSerial).padStart(2, '0')}-${action}`;
  const request = path.join(artifacts, step + '-request.json');
  const payload = { case: config.name, tabId: config.tabId, action, args };
  await writeFile(request + '.tmp', JSON.stringify(payload));
  await rename(request + '.tmp', request);
  const end = Date.now() + 180000;
  while (true) {
    try {
      const ack = JSON.parse(await readFile(path.join(artifacts, step + '-ack.json'), 'utf8'));
      assert.equal(ack.action, action);
      return ack;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    assert(Date.now() < end, step + ' controller acknowledgement deadline');
    await delay(100);
  }
}
async function dismissUpdateNotice(target) {
  const shown = await cdp([
    'eval',
    target,
    "return Boolean(document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('.primary'))",
  ]);
  if (shown) await cdp(['click', target, 'whats-new-modal >>> .primary']);
}
/** Gateway RPC as one of the fixture's admin principals. Resolves with the whole reply frame. */
async function rpc(method, params, profile = fixture.admins[0].profile) {
  const profiles = JSON.parse(await readFile(path.join(root, 'home/gateways.json'), 'utf8'));
  const socket = new WebSocket(config.gatewayUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const pending = new Map();
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.type === 'res') pending.get(frame.id)?.(frame);
  });
  let serial = 0;
  const call = (name, value) =>
    new Promise((resolve, reject) => {
      const id = `proof-${++serial}`;
      const timer = setTimeout(() => reject(new Error(`${name} timed out`)), 120000);
      pending.set(id, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      socket.send(JSON.stringify({ type: 'req', id, method: name, params: value }));
    });
  try {
    const auth = await call('auth.connect', {
      token: profiles.gateways[profile].secret,
      clientKind: 'ui',
      clientName: 'conditional-edits-proof',
    });
    assert(auth.ok, `auth.connect: ${auth.error?.code}`);
    return await call(method, params);
  } finally {
    socket.close();
  }
}
const nodesConnected = async () => {
  const reply = await rpc('nodes.list', {});
  const nodes = reply.payload?.nodes ?? [];
  return Object.values(fixture.nodes).every((node) =>
    nodes.some((entry) => entry.machine === node.machine),
  )
    ? nodes
    : undefined;
};

/** Every gateway frame on one page: raw JSONL, plus summaries for the edit and diff checks. */
async function recordFrames(target, label) {
  const page = (await (await fetch(CDP + '/json')).json()).find(
    (entry) => entry.id === target.slice(1),
  );
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const raw = createWriteStream(path.join(artifacts, `frames-${label}.jsonl`), { mode: 0o600 });
  const rows = [];
  socket.on('message', (data) => {
    const { method, params } = JSON.parse(String(data));
    if (!['Network.webSocketFrameSent', 'Network.webSocketFrameReceived'].includes(method)) return;
    const payload = params.response.payloadData;
    const dir = method.endsWith('Sent') ? 'sent' : 'received';
    raw.write(JSON.stringify({ wall: Date.now(), dir, payload }) + '\n');
    if (params.response.opcode !== 1 || !payload.startsWith('{')) return;
    const frame = JSON.parse(payload);
    // Vite's websocket also carries JSON, never gateway request, reply or event frames.
    if (!['req', 'res', 'event'].includes(frame.type)) return;
    const row = {
      wall: Date.now(),
      ts: params.timestamp,
      dir,
      socket: params.requestId,
      type: frame.type,
      id: frame.id,
      method: frame.method,
      event: frame.event,
      error: frame.error && { code: frame.error.code, details: frame.error.details },
    };
    if (frame.type === 'req' && frame.params && typeof frame.params === 'object') {
      const { content, ...rest } = frame.params;
      row.params = {
        ...Object.fromEntries(
          [
            'slotId',
            'path',
            'base',
            'head',
            'target',
            'includeUntracked',
            'runId',
            'expectedHash',
            'pr',
            'repo',
          ]
            .filter((key) => key in rest)
            .map((key) => [key, rest[key]]),
        ),
        ...(typeof content === 'string' ? { contentHash: sha256(content) } : {}),
      };
    }
    if (frame.type === 'res' && frame.payload && typeof frame.payload === 'object') {
      const { base, files, hash, pr, baseRef, diff } = frame.payload;
      row.payload = {
        ...(base !== undefined ? { base } : {}),
        // The new-side paths a git.diff reply carries; an untracked file is one.
        ...(typeof diff === 'string'
          ? { diffPaths: [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]) }
          : {}),
        ...(Array.isArray(files) ? { files: files.map((file) => file.path) } : {}),
        ...(hash !== undefined ? { hash } : {}),
        ...(pr !== undefined ? { pr, baseRef } : {}),
      };
    }
    rows.push(row);
  });
  socket.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
  await delay(300);
  return {
    rows,
    since: (wall) => rows.filter((row) => row.wall >= wall),
    async stop() {
      socket.close();
      await new Promise((resolve) => raw.end(resolve));
      return rows;
    },
  };
}
const replyTo = (rows, request) =>
  rows.find((row) => row.type === 'res' && row.socket === request.socket && row.id === request.id);
const requests = (rows, method, match = () => true) =>
  rows.filter((row) => row.type === 'req' && row.method === method && match(row));
const fakeLog = async () =>
  (await readFile(path.join(root, 'guard-invocations.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const drafts = (value) =>
  (value.indexedDb ?? []).flatMap((db) =>
    Object.entries(db.stores).flatMap(([store, rows]) =>
      rows
        .filter((row) => row && typeof row === 'object' && 'path' in row && 'slotId' in row)
        .map((row) => ({ db: db.name, store, ...row })),
    ),
  );
const draftFor = (value, key, file) =>
  drafts(value).find((row) => row.slotId === slots[key].id && row.path === file);
const principalOf = (draft) => JSON.parse(draft.scopeId).principalId;
const unsavedOf = (value, principalId) =>
  drafts(value).filter(
    (draft) => principalOf(draft) === principalId && draft.editedContent !== draft.baseContent,
  );
/** Whether a visible element matches, searched across shadow roots. */
const visible = (target, selector, textIncludes = '') =>
  cdp([
    'eval',
    target,
    `const all=(root,found=[])=>{found.push(...root.querySelectorAll(${JSON.stringify(selector)}));for(const node of root.querySelectorAll('*'))if(node.shadowRoot)all(node.shadowRoot,found);return found;};return all(document).some((node)=>node.getClientRects().length>0&&node.textContent.includes(${JSON.stringify(textIncludes)}))`,
  ]);

const claims = {};
const evidence = {};
const A = '@' + config.tabId;
const owner = await recordFrames(A, 'owner');

// ── Sign in as the first admin; the gateway advertises conditional file writes ──
await until((value) => value.auth, 'The new principal starts signed out', A);
// Earlier cases share this browser profile; their drafts would read as another principal's here.
evidence.clearedDraftDatabases = await cdp([
  'eval',
  A,
  `const names=(await indexedDB.databases()).map((db)=>db.name).filter((name)=>/draft/i.test(name));
   for (const name of names)
     await Promise.race([
       new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(name);request.onsuccess=resolve;request.onerror=()=>reject(request.error);}),
       new Promise((_,reject)=>setTimeout(()=>reject(new Error('Draft database delete blocked: '+name)),10000)),
     ]);
   return names`,
]);
assert((await cdp(['login', A])).authenticated);
await dismissUpdateNotice(A);
const signedIn = await until(
  (value) =>
    value.connection === 'connected' && value.principalId === fixture.admins[0].principalId,
  'Admin 1 connected',
  A,
  { timeout: 60000 },
);
evidence.capabilities = signedIn.capabilities;
assert.equal(signedIn.capabilities?.conditionalFileWrites, true);
evidence.nodes = await waitFor(nodesConnected, 'Both nodes connected', { timeout: 90000 });

// ── D08 targets on the ready slot's workspace ──
if (phase('d08')) {
  // The slot PR is found before the first branch diff, which asks for the PR's base.
  const openedAt = Date.now();
  await navigate(A, url('owner', slotRoute('ready')));
  const detected = await until(
    (value) =>
      value.slot?.slotId === slots.ready.id &&
      value.slot.prNumber === fixture.pr.number &&
      value.slot.branchDiffBase === 'develop' &&
      !value.slot.branchDiffLoading &&
      value.slot.branchDiffFiles.length > 0,
    'The slot PR is detected and its base diff renders',
    A,
    { timeout: 90000, interval: 1000 },
  );
  const firstDiff = requests(
    owner.since(openedAt),
    'git.branchDiff',
    (row) => row.params?.slotId === slots.ready.id,
  )[0];
  evidence.detected = { slot: detected.slot, firstDiff };
  assert.equal(detected.slot.prRepo, fixture.pr.repo);
  assert.equal(firstDiff.params.base, 'develop', 'The first branch diff uses the PR base');
  assert(!detected.slot.branchDiffFiles.includes('src/develop-only.ts'));
  await image('slot-pr-detected', A);
  claims.slotPrDetected = true;

  // Review threads: the Comments tab lists the fake PR's thread.
  await clickElement(A, '.sv-bottom-tab', 'Comments');
  const threads = await until(
    (value) => value.slot?.commentsText?.includes(fixture.pr.threadBody),
    'Review threads render',
    A,
    { timeout: 60000 },
  );
  evidence.threads = threads.slot.prThreads;
  await image('review-threads', A);
  claims.slotReviewThreads = true;

  // R3-B1: on a new document the first branch diff, for the PR base, is slow. The user picks a
  // newer base meanwhile; the slow answer arrives last and must not overwrite it.
  await checkpoint('git-delay', { base: 'develop', seconds: 12, remaining: 1 });
  const reopenedAt = Date.now();
  await navigate(A, url('owner-r3', slotRoute('ready')));
  const slowRequest = await waitFor(
    () =>
      requests(
        owner.since(reopenedAt),
        'git.branchDiff',
        (row) => row.params?.slotId === slots.ready.id && row.params.base === 'develop',
      )[0],
    'The first branch diff asks for the PR base',
    { target: A, timeout: 90000 },
  );
  // The stored diff lists the branch changes while the live read is still in flight.
  await until((value) => value.slot?.branchDiffFiles?.length > 0, 'Branch changes are listed', A);
  assert(!replyTo(owner.rows, slowRequest), 'The develop diff is still in flight');
  // A stored layout may already show the Branch Changes panel; the button toggles it.
  const basePicker = () =>
    cdp([
      'eval',
      A,
      `const all=(root,found=[])=>{found.push(...root.querySelectorAll('.base-btn'));for(const node of root.querySelectorAll('*'))if(node.shadowRoot)all(node.shadowRoot,found);return found;};return all(document).some((node)=>node.getClientRects().length>0)`,
    ]);
  if (!(await basePicker())) await clickElement(A, 'button[title^="Branch Changes"]');
  await waitFor(basePicker, 'The base picker is shown');
  await clickElement(A, '.base-btn');
  await delay(300);
  await typeKeys(A, { text: 'main', enter: true });
  const newer = await until(
    (value) =>
      value.slot?.branchDiffBase === 'main' &&
      !value.slot.branchDiffLoading &&
      value.slot.branchDiffFiles.includes('src/develop-only.ts'),
    'The newer base renders',
    A,
    { timeout: 30000 },
  );
  const slowReply = await waitFor(
    () => replyTo(owner.rows, slowRequest),
    'The slow develop diff answers',
    { target: A, timeout: 30000 },
  );
  await delay(1500);
  const after = await inspect(A);
  const mainRequest = requests(
    owner.since(reopenedAt),
    'git.branchDiff',
    (row) => row.params?.slotId === slots.ready.id && row.params.base === 'main',
  )[0];
  const mainReply = replyTo(owner.rows, mainRequest);
  evidence.r3 = {
    slowRequest,
    slowReply,
    mainRequest,
    mainReply,
    newer: newer.slot,
    afterSlowReply: after.slot,
  };
  await save('r3-slow-base', evidence.r3);
  await image('r3-newer-base', A);
  assert(mainRequest.wall > slowRequest.wall, 'The newer base was asked for second');
  assert(slowReply.wall > mainReply.wall, 'The develop reply came last');
  assert.equal(after.slot.branchDiffBase, 'main');
  assert(after.slot.branchDiffFiles.includes('src/develop-only.ts'));
  claims.slotSlowBaseIgnored = true;

  // R2-B1: the PR lookup fails during reconnect recovery. Recovery must settle without it: a
  // branch diff is asked for and answered while every lookup still fails. Only then does gh answer
  // again, and the first later success applies the PR's new base.
  const fakeBefore = (await fakeLog()).length;
  const lookupsSince = async (from) =>
    (await fakeLog())
      .slice(from)
      .filter((row) => ['failed', 'pr-list', 'pr-verify'].includes(row.outcome));
  await checkpoint('gh-state', { failNext: 1000000, prBase: 'release' });
  const restartAt = Date.now();
  await checkpoint('gateway-restart');
  await until(
    (value) => value.connection === 'connected' && value.connectionId !== after.connectionId,
    'Reconnected after the gateway restart',
    A,
    { timeout: 90000 },
  );
  await waitFor(nodesConnected, 'Both nodes reconnected', { timeout: 90000 });
  const failed = await waitFor(
    async () => (await fakeLog()).slice(fakeBefore).find((row) => row.outcome === 'failed'),
    'The first PR lookup after the restart fails',
    { target: A, timeout: 60000 },
  );
  const fallback = await waitFor(
    () => {
      const request = requests(
        owner.since(failed.at * 1000),
        'git.branchDiff',
        (row) => row.params?.slotId === slots.ready.id,
      )[0];
      const reply = request && replyTo(owner.rows, request);
      return reply && !reply.error && { request, reply };
    },
    'Recovery settles with a branch diff while the lookup fails',
    { target: A, timeout: 90000 },
  );
  const settled = await until(
    (value) =>
      value.slot?.branchDiffBase === fallback.request.params.base &&
      !value.slot.branchDiffLoading &&
      value.slot.branchDiffError === null,
    'The fallback base renders while gh fails',
    A,
    { timeout: 30000 },
  );
  const whileFailing = await lookupsSince(fakeBefore);
  assert.notEqual(fallback.request.params.base, 'release', 'The failed lookup changed nothing');
  assert(whileFailing.length >= 1 && whileFailing.every((row) => row.outcome === 'failed'));
  const releasedAt = Date.now();
  await checkpoint('gh-state', { failNext: 0 });
  const applied = await until(
    (value) =>
      value.slot?.branchDiffBase === 'release' &&
      !value.slot.branchDiffLoading &&
      value.slot.branchDiffError === null,
    'The first later PR success applies its base',
    A,
    { timeout: 240000, interval: 2000 },
  );
  const lookups = await lookupsSince(fakeBefore);
  evidence.r2 = {
    failed,
    fallback,
    settled: settled.slot,
    releasedAt,
    applied: applied.slot,
    lookups,
    branchDiffBases: requests(
      owner.since(restartAt),
      'git.branchDiff',
      (row) => row.params?.slotId === slots.ready.id,
    ).map((row) => ({ wall: row.wall, base: row.params.base })),
  };
  await save('r2-recovery-retry', evidence.r2);
  await image('r2-applied-base', A);
  assert(
    lookups.filter((row) => row.at * 1000 < releasedAt).every((row) => row.outcome === 'failed'),
    'No lookup succeeded before the release',
  );
  assert(lookups.some((row) => row.at * 1000 >= releasedAt && row.outcome !== 'failed'));
  assert(
    evidence.r2.branchDiffBases.some((row) => row.wall >= releasedAt && row.base === 'release'),
  );
  claims.slotPrRecoveryRetry = true;
}

// ── Conditional edits ──
// Drafts and editor states read through the hooks agreed with the editor's authors.
let openSerial = 0;
/**
 * Each scenario opens its file in a new document, so no other slot's run or read is still in
 * memory, and waits until the editor's state holds for two probes a second apart. Another tab
 * holds its sign-in for this document only, so it follows a link in the same document instead.
 */
const openFile = async (key, file, viewer = 'owner', target = A) => {
  if (target === A) await navigate(A, url(`${viewer}-${++openSerial}`, slotRoute(key, file)));
  else
    await cdp([
      'eval',
      target,
      `location.hash = ${JSON.stringify(slotRoute(key, file))}; return true`,
    ]);
  let previous;
  return until(
    (value) => {
      const settled =
        value.connection === 'connected' &&
        value.slot?.slotId === slots[key].id &&
        value.slot.activeFile === file &&
        value.slot.editor &&
        // 'hash' also covers a read that is not ready yet; wait for the settled state.
        (value.slot.editor.readOnly === false || value.slot.readOnlyReason?.reason !== 'hash');
      const state = settled
        ? JSON.stringify([value.slot.editor.readOnly, value.slot.readOnlyReason?.reason])
        : undefined;
      const stable = state !== undefined && state === previous;
      previous = state;
      return stable;
    },
    `${key} ${file} open`,
    target,
    { timeout: 60000, interval: 1000 },
  );
};
const fsWrites = (since, key, file) =>
  requests(
    owner.since(since),
    'fs.write',
    (row) => row.params?.slotId === slots[key].id && (!file || row.params.path === file),
  );

if (phase('saves')) {
  // A ready slot autosaves with the hash it read; a worker change after that save is a notice,
  // and the user's version stays as a draft.
  const editFile = 'src/edit.ts';
  const opened = await openFile('ready', editFile);
  assert.equal(opened.slot.editor.readOnly, false, 'Editable with the capability on a local slot');
  const before = await readSlotFile('ready', editFile);
  const typedAt = Date.now();
  await typeInEditor(A, '// D11 user edit on the ready slot');
  await waitFor(() => fsWrites(typedAt, 'ready', editFile).length > 0, 'The ready slot autosaves', {
    target: A,
    timeout: 30000,
  });
  const saved = await until(
    (value) =>
      value.slot?.saveState?.state === 'saved' &&
      value.slot.editor.value?.includes('D11 user edit on the ready slot'),
    'The autosave is acknowledged',
    A,
    { timeout: 30000, params: { editorText: true } },
  );
  const autosave = fsWrites(typedAt, 'ready', editFile);
  const savedText = await readSlotFile('ready', editFile);
  assert(autosave.length >= 1 && autosave[0].params.expectedHash === sha256(before));
  assert(!replyTo(owner.rows, autosave.at(-1)).error);
  assert.equal(savedText, saved.slot.editor.value);
  const workerText = before + '// D11 worker change after the user saved\n';
  await checkpoint('worker-write', { slot: 'ready', path: editFile, text: workerText });
  const noticed = await until(
    (value) =>
      value.slot?.changedNotice && draftFor(value, 'ready', editFile)?.editedContent === savedText,
    'A worker change after the save shows a notice and keeps the user version',
    A,
    { timeout: 30000, params: { indexedDb: true } },
  );
  evidence.afterSave = {
    autosave,
    notice: noticed.slot.changedNotice,
    draft: draftFor(noticed, 'ready', editFile),
  };
  await image('worker-change-notice', A);
  claims.editsWorkerChangeAfterSave = true;

  // Typing while an autosave is in flight: the gateway holds both writes of this file for 8 s.
  // The later text stays in the editor and in the draft, now over the saved text, and the next
  // save names the hash the first one returned.
  const slowFile = 'src/after-save.ts';
  await openFile('ready', slowFile);
  const slowFrom = Date.now();
  await typeInEditor(A, '// D11 first edit, saved while typing goes on');
  const first = await waitFor(
    () => fsWrites(slowFrom, 'ready', slowFile)[0],
    'The first autosave is sent',
    { target: A, timeout: 30000 },
  );
  await typeInEditor(A, '// D11 typed while the save was in flight');
  const during = await inspect(A, { indexedDb: true, editorText: true });
  assert(!replyTo(owner.rows, first), 'The first save is still in flight after the typing');
  assert(during.slot.editor.value.includes('typed while the save was in flight'));
  const firstReply = await waitFor(() => replyTo(owner.rows, first), 'The first save answers', {
    target: A,
    timeout: 30000,
  });
  assert(!firstReply.error && firstReply.payload?.hash === first.params.contentHash);
  const second = await waitFor(
    () => fsWrites(slowFrom, 'ready', slowFile)[1],
    'The next save is sent',
    { target: A, timeout: 30000 },
  );
  // The gateway holds this write too, so the rebased draft is still stored.
  const rebased = await inspect(A, { indexedDb: true, editorText: true });
  assert(!replyTo(owner.rows, second), 'The next save is still in flight');
  const pending = draftFor(rebased, 'ready', slowFile);
  assert(rebased.slot.editor.value.includes('typed while the save was in flight'));
  assert(pending?.editedContent.includes('typed while the save was in flight'));
  assert.equal(pending.baseHash, firstReply.payload.hash);
  assert.equal(sha256(pending.baseContent), firstReply.payload.hash);
  assert.equal(second.params.expectedHash, firstReply.payload.hash);
  assert.equal(second.params.contentHash, sha256(pending.editedContent));
  const secondReply = await waitFor(() => replyTo(owner.rows, second), 'The next save answers', {
    target: A,
    timeout: 30000,
  });
  assert(!secondReply.error);
  const landed = await until(
    (value) =>
      !draftFor(value, 'ready', slowFile) && value.slot?.editor?.value === pending.editedContent,
    'Both edits are saved',
    A,
    { timeout: 30000, params: { indexedDb: true, editorText: true } },
  );
  assert.equal(await readSlotFile('ready', slowFile), pending.editedContent);
  assert.equal(fsWrites(slowFrom, 'ready', slowFile).length, 2);
  evidence.typingDuringSave = {
    writes: [first, firstReply, second, secondReply],
    draftWhileFirstInFlight: draftFor(during, 'ready', slowFile),
    draftWhileSecondInFlight: pending,
    editor: landed.slot.editor,
  };
  await image('typing-during-save', A);
  claims.editsTypingDuringSave = true;

  // A busy slot saves only when asked; a worker change before that save refuses it, keeps the
  // draft, and shows both versions. Theirs wins once, mine once. The save follows the page's read
  // of the worker's bytes, as a user's would, never racing the change notice.
  const conflict = async (file, keep) => {
    await openFile('work', file);
    const original = await readSlotFile('work', file);
    const typed = Date.now();
    await typeInEditor(A, `// D11 user edit kept as ${keep}`);
    await delay(3000);
    assert.equal(fsWrites(typed, 'work', file).length, 0, 'A busy slot never autosaves');
    const mine = (await inspect(A, { editorText: true })).slot.editor.value;
    const theirs = original + `// D11 worker change before the ${keep} save\n`;
    const wroteFrom = Date.now();
    await checkpoint('worker-write', { slot: 'work', path: file, text: theirs });
    const currentRead = await waitFor(
      () =>
        requests(
          owner.since(wroteFrom),
          'fs.read',
          (row) => row.params?.slotId === slots.work.id && row.params.path === file,
        )
          .map((row) => replyTo(owner.rows, row))
          .find((reply) => reply?.payload?.hash === sha256(theirs)),
      `${file}: the page reads the worker change`,
      { target: A, timeout: 30000 },
    );
    await until(
      (value) =>
        value.slot?.editor?.readOnly === false &&
        value.slot.saveButton?.disabled === false &&
        value.slot.editor.value === mine,
      `${file}: the draft still shows over the current read`,
      A,
      { timeout: 30000, params: { editorText: true } },
    );
    const savedAt = Date.now();
    await clickElement(A, '[data-testid="file-save"]');
    const refused = await until(
      (value) => value.slot?.conflict && draftFor(value, 'work', file)?.editedContent === mine,
      `${file} save is refused and both versions show`,
      A,
      { timeout: 30000, params: { indexedDb: true } },
    );
    const refusal = replyTo(owner.rows, fsWrites(savedAt, 'work', file)[0]);
    assert.equal(refusal.error?.code, 'FS_CONFLICT');
    assert.equal(refusal.error.details?.reason, 'hash');
    assert.equal(refusal.error.details.currentHash, sha256(theirs));
    assert(refused.slot.conflict.mine.includes(`kept as ${keep}`));
    assert(refused.slot.conflict.theirs.includes(`before the ${keep} save`));
    await image(`conflict-${keep}`, A);
    const keptAt = Date.now();
    await clickElement(A, `[data-testid="draft-keep-${keep}"]`);
    // Keeping theirs drops the draft and shows the worker's file; keeping mine saves it over
    // theirs, naming the hash of theirs.
    const kept = await until(
      (value) =>
        !draftFor(value, 'work', file) &&
        value.slot?.editor?.readOnly === false &&
        value.slot.editor.value === (keep === 'theirs' ? theirs : mine),
      `${file} keeps ${keep}`,
      A,
      { timeout: 30000, params: { indexedDb: true, editorText: true } },
    );
    const keptWrites = fsWrites(keptAt, 'work', file);
    if (keep === 'theirs') {
      assert.equal(keptWrites.length, 0, 'Keeping theirs writes nothing');
      assert.equal(await readSlotFile('work', file), theirs);
    } else {
      assert.equal(keptWrites.length, 1);
      assert.equal(keptWrites[0].params.expectedHash, sha256(theirs));
      assert(!replyTo(owner.rows, keptWrites[0])?.error, 'Mine replaces theirs');
      assert.equal(await readSlotFile('work', file), mine);
    }
    return {
      file,
      keep,
      currentRead,
      refusal,
      conflict: refused.slot.conflict,
      keptWrites,
      kept: kept.slot,
    };
  };
  evidence.conflicts = [
    await conflict('src/conflict-a.ts', 'theirs'),
    await conflict('src/conflict-b.ts', 'mine'),
  ];
  claims.editsRefusedSaveKeepsDraft = true;
}

if (phase('runs')) {
  // A slot at a pending review gate warns that a save needs a new review.
  const gate = await openFile('gate', 'src/edit.ts');
  assert(gate.slot.reviewWarning, 'The review-gate slot shows the re-review warning');
  evidence.gateWarning = gate.slot.reviewWarning;
  // Bytes that are not UTF-8 stay read-only: the read's hash cannot match the text as UTF-8.
  const latin1 = await openFile('ready', 'data/latin1.txt');
  assert.equal(latin1.slot.editor.readOnly, true);
  assert.equal(latin1.slot.readOnlyReason?.reason, 'encoding');
  evidence.encoding = latin1.slot.readOnlyReason;

  // A draft for a run the slot no longer serves is read-only: listed with copy and discard but no
  // open, never in the editor, its copy is its edited text, and a save naming that run is refused.
  const runFile = 'src/run-bound.ts';
  await openFile('switch', runFile);
  await typeInEditor(A, '// D11 draft for run A');
  await until((value) => draftFor(value, 'switch', runFile), 'Run A draft stored', A, {
    params: { indexedDb: true },
  });
  await checkpoint('switch-run');
  const stale = await until(
    (value) =>
      value.drafts.some(
        (item) =>
          item.slot === slots.switch.id &&
          item.path === runFile &&
          item.state === 'stale-run' &&
          item.copy &&
          item.discard &&
          !item.open,
      ) &&
      draftFor(value, 'switch', runFile)?.state === 'stale-run' &&
      typeof value.slot?.editor?.value === 'string' &&
      !value.slot.editor.value.includes('D11 draft for run A'),
    'The run A draft becomes read-only with copy and discard',
    A,
    { timeout: 30000, params: { indexedDb: true, editorText: true } },
  );
  const staleDraft = draftFor(stale, 'switch', runFile);
  // The copy is read through the page: the clipboard write is recorded and not passed on, so the
  // proof never replaces the desktop clipboard of the machine it runs on.
  await cdp([
    'eval',
    A,
    `window.__d11Copies = [];
     Object.defineProperty(navigator.clipboard, 'writeText', {
       configurable: true,
       value: (text) => { window.__d11Copies.push(text); return Promise.resolve(); },
     });
     return true`,
  ]);
  await clickElement(A, '[data-testid="draft-copy"]');
  const copies = await waitFor(
    async () => {
      const copied = await cdp(['eval', A, 'return window.__d11Copies ?? []']);
      return copied.length ? copied : undefined;
    },
    'Copy writes the draft to the clipboard',
    { target: A },
  );
  assert.deepEqual(copies, [staleDraft.editedContent], 'Copy carries the edited content');
  const runRefusal = await rpc('fs.write', {
    slotId: slots.switch.id,
    path: runFile,
    content: 'run A content',
    expectedHash: sha256(await readSlotFile('switch', runFile)),
    runId: fixture.runs.switchA,
  });
  assert.equal(runRefusal.error?.code, 'FS_CONFLICT');
  assert.equal(runRefusal.error.details?.reason, 'run');
  assert.equal(runRefusal.error.details.currentRunId, fixture.runs.switchB);
  await image('stale-run-draft', A);
  await clickElement(A, '[data-testid="draft-discard"]');
  await until((value) => !draftFor(value, 'switch', runFile), 'The stale draft is discarded', A, {
    params: { indexedDb: true },
  });
  evidence.staleRun = {
    drafts: stale.drafts,
    draft: staleDraft,
    copies,
    editor: stale.slot.editor,
    refusal: runRefusal.error,
  };
  claims.editsStaleRunDraft = true;
  claims.editsGateWarning = true;
}

if (phase('hosts')) {
  // Node A checks the hash itself; node B advertises no conditional writes.
  const file = 'src/edit.ts';
  const a = await openFile('nodeA', file);
  assert.equal(a.slot.editor.readOnly, false, 'A node with conditional writes is editable');
  const before = await readSlotFile('nodeA', file);
  const typedAt = Date.now();
  await typeInEditor(A, '// D11 user edit on node A');
  await waitFor(() => fsWrites(typedAt, 'nodeA', file).length > 0, 'Node A autosaves', {
    target: A,
    timeout: 30000,
  });
  await until((value) => value.slot?.saveState?.state === 'saved', 'Node A save acknowledged', A, {
    timeout: 30000,
  });
  const nodeWrite = fsWrites(typedAt, 'nodeA', file)[0];
  assert.equal(nodeWrite.params.expectedHash, sha256(before));
  assert((await readSlotFile('nodeA', file)).includes('D11 user edit on node A'));
  const b = await openFile('nodeB', file);
  assert.equal(b.slot.editor.readOnly, true, 'A node without conditional writes is read-only');
  assert.equal(b.slot.readOnlyReason?.reason, 'host');
  const unchanged = await readSlotFile('nodeB', file);
  const refusal = await rpc('fs.write', {
    slotId: slots.nodeB.id,
    path: file,
    content: unchanged + '// must not land\n',
    expectedHash: sha256(unchanged),
  });
  assert.equal(refusal.error?.code, PRECONDITION_UNSUPPORTED);
  assert.equal(await readSlotFile('nodeB', file), unchanged);
  await image('node-b-read-only', A);
  evidence.hosts = {
    nodeA: { write: nodeWrite },
    nodeB: { readOnly: b.slot.readOnlyReason, refusal: refusal.error },
  };
  claims.editsNodeWithoutConditionalWrites = true;
}

if (phase('offline')) {
  // Offline, an untracked file opens from the held active-run diff (base to worktree, untracked
  // files included): its new side, read-only, with no fs.read. Nothing in this proof read it before.
  const file = fixture.untracked.path;
  const content = await readSlotFile('work', file);
  const fileReads = (rows) =>
    requests(
      rows,
      'fs.read',
      (row) => row.params?.slotId === slots.work.id && row.params.path === file,
    );
  await navigate(A, url(`owner-offline-${++openSerial}`, slotRoute('work')));
  await until(
    (value) => value.connection === 'connected' && value.slot?.slotId === slots.work.id,
    'The work slot opens online',
    A,
    { timeout: 60000 },
  );
  const prefetched = await waitFor(
    () => {
      const reply = requests(
        owner.rows,
        'git.diff',
        (row) => row.params?.slotId === slots.work.id && row.params.includeUntracked === true,
      )
        .map((row) => replyTo(owner.rows, row))
        .filter(Boolean)
        .at(-1);
      return !reply?.error && reply?.payload?.diffPaths?.includes(file) && reply;
    },
    "The work run's diff with the untracked file is held",
    { target: A, timeout: 60000 },
  );
  if (!(await visible(A, '.file-row .file-basename', file)))
    await clickElement(A, 'button[title^="Source Control"]');
  await waitFor(
    () => visible(A, '.file-row .file-basename', file),
    'The untracked file is listed',
    {
      target: A,
    },
  );
  assert.equal(fileReads(owner.rows).length, 0, 'The untracked file was never read online');
  await checkpoint('gateway-stop');
  const offlineFrom = Date.now();
  await until((value) => value.connection !== 'connected', 'The page is offline', A, {
    timeout: 30000,
  });
  await clickElement(A, '.file-row .file-basename', file);
  const opened = await until(
    (value) => value.slot?.activeFile === file && value.slot.editor?.value === content,
    'The untracked file renders from held content',
    A,
    { timeout: 30000, params: { editorText: true } },
  );
  assert.equal(opened.slot.editor.readOnly, true);
  assert.equal(opened.slot.readOnlyReason?.reason, 'offline');
  await image('offline-untracked-file', A);
  const offlineReads = fileReads(owner.since(offlineFrom));
  assert.equal(offlineReads.length, 0, 'No fs.read frame for the untracked file');
  evidence.offlineUntracked = {
    file,
    prefetched,
    connection: opened.connection,
    editor: opened.slot.editor,
    reason: opened.slot.readOnlyReason,
    fsReads: offlineReads,
  };
  await checkpoint('gateway-start');
  await until(
    (value) => value.connection === 'connected',
    'Reconnected after the gateway start',
    A,
    {
      timeout: 90000,
    },
  );
  await waitFor(nodesConnected, 'Both nodes reconnected', { timeout: 90000 });
  claims.editsOfflineUntrackedFile = true;
}

if (phase('capability')) {
  // An unsaved draft on the busy slot, then a gateway without the capability.
  const file = 'src/edit.ts';
  await openFile('work', file);
  await typeInEditor(A, '// D11 unsaved draft across the capability change');
  await until((value) => draftFor(value, 'work', file), 'Unsaved draft stored', A, {
    params: { indexedDb: true },
  });
  const previous = await inspect(A);
  await checkpoint('capability-off');
  await until(
    (value) =>
      value.connection === 'connected' &&
      value.connectionId !== previous.connectionId &&
      value.capabilities &&
      !value.capabilities.conditionalFileWrites,
    'Reconnected without the capability',
    A,
    { timeout: 90000 },
  );
  // The draft's own slot: its file is read-only now, and its draft is still listed there.
  const off = await openFile('work', file, 'owner-capability-off');
  const listed = await until(
    (value) => value.drafts.some((item) => item.slot === slots.work.id && item.path === file),
    'Drafts are still listed',
    A,
    { timeout: 30000 },
  );
  assert.equal(off.slot.editor.readOnly, true, 'Read-only without the capability');
  assert.equal(off.slot.readOnlyReason?.reason, 'capability');
  await image('capability-off', A);
  evidence.capabilityOff = {
    editor: off.slot.editor,
    reason: off.slot.readOnlyReason,
    drafts: listed.drafts,
  };
  await checkpoint('capability-on');
  await until(
    (value) =>
      value.connection === 'connected' && value.capabilities?.conditionalFileWrites === true,
    'Reconnected with the capability',
    A,
    { timeout: 90000 },
  );
  await waitFor(nodesConnected, 'Both nodes reconnected', { timeout: 90000 });
  claims.editsWithoutCapability = true;

  // Drafts are never sent. The ready slot, where saving is allowed, holds the user's version that
  // the worker change kept as a draft. Restored in a new document over a current read it is
  // editable, and neither the restore, a reconnect nor a reload sends it.
  const readyFile = 'src/edit.ts';
  const onDisk = await readSlotFile('ready', readyFile);
  const stored = draftFor(await inspect(A, { indexedDb: true }), 'ready', readyFile);
  assert(stored?.state === 'current', 'An unsaved draft is stored for the ready slot');
  assert.notEqual(stored.editedContent, stored.baseContent);
  assert.notEqual(stored.editedContent, onDisk);
  assert.equal(stored.baseHash, sha256(onDisk), 'The draft is over the current file');
  const currentRead = (since) =>
    waitFor(
      () =>
        requests(
          owner.since(since),
          'fs.read',
          (row) => row.params?.slotId === slots.ready.id && row.params.path === readyFile,
        )
          .map((row) => replyTo(owner.rows, row))
          .find((reply) => reply?.payload?.hash === sha256(onDisk)),
      'The restored draft has a current read',
      { target: A, timeout: 30000 },
    );
  const restoredShown = (value) =>
    value.slot?.slotId === slots.ready.id &&
    value.slot.activeFile === readyFile &&
    value.slot.editor?.readOnly === false &&
    value.slot.editor.value === stored.editedContent;
  const restoredFrom = Date.now();
  await openFile('ready', readyFile, 'owner-restored');
  const restoredRead = await currentRead(restoredFrom);
  await until(restoredShown, 'The restored draft is editable over the current read', A, {
    params: { editorText: true },
  });
  // Longer than the autosave pause.
  await delay(5000);
  const connected = await inspect(A);
  assert((await dropGatewaySocket(A)) >= 1);
  await until(
    (value) => value.connection === 'connected' && value.connectionId !== connected.connectionId,
    'Reconnected with the restored draft',
    A,
    { timeout: 60000 },
  );
  await delay(10000);
  const reloadFrom = Date.now();
  await devtools((call) => call('Page.reload'), A);
  const reloadRead = await currentRead(reloadFrom);
  await until(restoredShown, 'The draft is restored again after the reload', A, {
    timeout: 60000,
    params: { editorText: true },
  });
  await delay(10000);
  const sent = requests(owner.since(restoredFrom), 'fs.write');
  const held = await inspect(A, { indexedDb: true });
  evidence.reconnect = { stored, restoredRead, reloadRead, fsWrites: sent, drafts: drafts(held) };
  assert.equal(sent.length, 0, 'No draft is sent on restore, reconnect or reload');
  assert.equal(await readSlotFile('ready', readyFile), onDisk, 'The file on disk is unchanged');
  assert.equal(draftFor(held, 'ready', readyFile)?.editedContent, stored.editedContent);
  claims.editsReconnectSendsNoDraft = true;
}

if (phase('account')) {
  // Sign-out shows the unsaved count, then deletes the drafts.
  const before = drafts(await inspect(A, { indexedDb: true }));
  // The count is this principal's unsaved drafts: edited content that differs from its base.
  const unsaved = before.filter((draft) => draft.editedContent !== draft.baseContent);
  assert(unsaved.length >= 1, 'Sign-out starts with unsaved drafts');
  assert.equal(new Set(before.map((draft) => draft.scopeId)).size, 1);
  await cdp(['click', A, '[data-testid="account-menu"]']);
  await cdp(['click', A, '[data-testid="account-sign-out"]']);
  const asked = await until(
    (value) => value.signOutDrafts,
    'The sign-out confirmation shows the unsaved count',
    A,
  );
  assert.equal(Number(asked.signOutDrafts.count), unsaved.length);
  await image('sign-out-drafts', A);
  await cdp(['click', A, '[data-testid="account-sign-out-confirm"]']);
  const signedOut = await until(
    (value) => value.auth && drafts(value).length === 0,
    'Sign-out deletes the drafts',
    A,
    { params: { indexedDb: true } },
  );
  evidence.signOut = { before, count: asked.signOutDrafts, after: drafts(signedOut) };
  claims.editsDraftsDeletedOnSignOut = true;

  // A principal change found at connect, on the real login path. Admin 1 leaves a draft; a second
  // tab of the same origin signs in as admin 2 with a connection link. The tab that connects and
  // finds another principal's drafts for the same gateway profile shows the count and deletes them.
  // Admin 2 then leaves a draft, and admin 1 returns: the first tab's next document connects with the
  // login this browser profile saved for admin 1, shows admin 2's count and deletes those drafts.
  assert((await cdp(['login', A])).authenticated);
  const file = 'src/edit.ts';
  await openFile('work', file, 'owner-admin1');
  await typeInEditor(A, '// D11 draft left by admin 1');
  const left = await until((value) => draftFor(value, 'work', file), 'Admin 1 draft stored', A, {
    params: { indexedDb: true },
  });
  const profiles = JSON.parse(await readFile(path.join(root, 'home/gateways.json'), 'utf8'));
  const link = Buffer.from(
    JSON.stringify({
      v: 1,
      url: 'ws://127.0.0.1:5208/ws',
      token: profiles.gateways[fixture.admins[1].profile].secret,
    }),
  ).toString('base64url');
  const B = await openWindow('admin2', `#runs?connect=${link}`, {
    left: 900,
    top: 39,
    width: 900,
    height: 1040,
  });
  const changed = await until(
    (value) =>
      value.connection === 'connected' &&
      value.principalId === fixture.admins[1].principalId &&
      value.draftsDeletedNotice &&
      drafts(value).length === 0,
    'The tab that finds the change shows the count and deletes the old drafts',
    B,
    { timeout: 60000, params: { indexedDb: true } },
  );
  assert.equal(
    Number(changed.draftsDeletedNotice.count),
    drafts(left).filter((draft) => draft.editedContent !== draft.baseContent).length,
  );
  await image('principal-change', B);
  evidence.principalChange = { left: drafts(left), notice: changed.draftsDeletedNotice };
  claims.editsDraftsDeletedOnPrincipalChange = true;

  const [admin1, admin2] = fixture.admins.map((admin) => admin.principalId);
  await openFile('work', file, 'admin2', B);
  await typeInEditor(B, '// D11 draft left by admin 2');
  const left2 = await until(
    (value) => unsavedOf(value, admin2).some((draft) => draft.slotId === slots.work.id),
    'Admin 2 draft stored',
    B,
    { params: { indexedDb: true } },
  );
  await closeWindow(B);
  await navigate(A, url('owner-next', slotRoute('work', file)));
  const back = await until(
    (value) =>
      value.connection === 'connected' &&
      value.principalId === admin1 &&
      value.draftsDeletedNotice &&
      drafts(value).every((draft) => principalOf(draft) !== admin2),
    'Admin 1 returns; admin 2 drafts are counted and deleted',
    A,
    { timeout: 60000, params: { indexedDb: true } },
  );
  assert.equal(Number(back.draftsDeletedNotice.count), unsavedOf(left2, admin2).length);
  assert.equal(drafts(back).length, 0, 'No admin 1 or admin 2 draft is left in IndexedDB');
  assert(!back.drafts.length, 'No draft is listed');
  await image('principal-return', A);
  evidence.principalReturn = {
    left: drafts(left2),
    notice: back.draftsDeletedNotice,
    firstTabNext: { principalId: back.principalId, drafts: back.drafts },
  };
  claims.editsDraftsDeletedOnPrincipalReturn = true;
}

await owner.stop();
await save('result', { claims, evidence: { ...evidence, fronted } });
console.log(JSON.stringify(claims));

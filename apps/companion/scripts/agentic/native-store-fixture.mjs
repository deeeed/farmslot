import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { d05RecipeErrors } from './d05-fixture.mjs';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const storageId = (id) =>
  `native.session.read:${JSON.stringify({ executionNodeId: 'local', sessionId: id })}`;

/** Independent complete user/assistant projection for fixture and actual SQLite evidence only. */
export function messages(events) {
  const prompts = new Map();
  for (const event of events) {
    if (
      ['command.submitted', 'command.accepted'].includes(event.type) &&
      event.commandId &&
      event.text !== undefined &&
      !prompts.has(event.commandId)
    )
      prompts.set(event.commandId, event.text);
  }
  const seen = new Set();
  const result = [];
  for (const event of events) {
    if (event.commandId && prompts.has(event.commandId) && !seen.has(event.commandId)) {
      seen.add(event.commandId);
      result.push({ kind: 'user', text: prompts.get(event.commandId) });
    }
    if (event.type === 'text.delta') {
      const last = result.at(-1);
      if (
        last?.kind === 'assistant' &&
        last.commandId === event.commandId &&
        last.generation === event.generation
      )
        last.text += event.text ?? '';
      else
        result.push({
          kind: 'assistant',
          commandId: event.commandId,
          generation: event.generation,
          text: event.text ?? '',
        });
    }
  }
  return result;
}

/** Keep the upward-content navigation gesture inside the observed conversation. */
export function nativeScrollViewGesture(screen, direction = 'up') {
  assert(['up', 'down'].includes(direction), 'Select a vertical content direction');
  const scrolls = screen.nodes.filter(
    (node) => node.type === 'ScrollView' && node.rect?.width > 0 && node.rect?.height > 0,
  );
  assert.equal(scrolls.length, 1, 'Require one observed conversation scroll view');
  const rect = scrolls[0].rect;
  assert(['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key])));
  assert(rect.x >= 0 && rect.y >= 0);
  const viewport = screen.nodes.find(
    (node) => ['Application', 'Window'].includes(node.type) && node.rect?.height > 0,
  )?.rect;
  assert(
    viewport &&
      rect.x >= viewport.x &&
      rect.y >= viewport.y &&
      rect.x + rect.width <= viewport.x + viewport.width &&
      rect.y + rect.height <= viewport.y + viewport.height,
    'Conversation scroll view must be inside the observed viewport',
  );
  const x = rect.x + rect.width / 2;
  const top = { x, y: rect.y + rect.height * 0.2 };
  const bottom = { x, y: rect.y + rect.height * 0.8 };
  return {
    from: direction === 'up' ? top : bottom,
    to: direction === 'up' ? bottom : top,
    durationMs: 120,
  };
}

/** A discovered control can still be clipped by its actual scrolling ancestor. */
export function nativeResumeFitsScrollView(screen, selector) {
  const targets = screen.nodes.filter((node) => node.identifier === selector);
  if (targets.length !== 1) return false;
  const target = targets[0];
  const rect = target.rect;
  if (
    !rect ||
    !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key])) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    target.visibleToUser === false
  )
    return false;
  const nodes = new Map(screen.nodes.map((node) => [node.index, node]));
  const visited = new Set();
  let ancestor = target;
  let scrollView = false;
  while (
    ancestor.parentIndex !== undefined &&
    ancestor.parentIndex !== null &&
    ancestor.parentIndex >= 0
  ) {
    if (visited.has(ancestor.parentIndex)) return false;
    visited.add(ancestor.parentIndex);
    ancestor = nodes.get(ancestor.parentIndex);
    if (!ancestor) return false;
    if (ancestor.type === 'ScrollView') {
      scrollView = true;
      const clip = ancestor.rect;
      if (
        !clip ||
        !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(clip[key])) ||
        clip.width <= 0 ||
        clip.height <= 0 ||
        rect.x < clip.x ||
        rect.y < clip.y ||
        rect.x + rect.width > clip.x + clip.width ||
        rect.y + rect.height > clip.y + clip.height
      )
        return false;
    }
  }
  return scrollView;
}

/** Reject a stale accessibility target when its paired screenshot no longer renders Resume. */
export function renderedNativeResumeTarget(screen, image, selector) {
  const targets = screen.nodes.filter((node) => node.identifier === selector);
  assert.equal(targets.length, 1, 'Require one actual Resume accessibility target');
  const target = targets[0];
  assert.equal(target.enabled, false, 'Resume must remain accessibility-disabled');
  assert(
    nativeResumeFitsScrollView(screen, selector),
    'Resume must fit inside its actual ancestor ScrollView before a point press',
  );
  const rect = target.rect;
  const viewport = screen.nodes.find((node) => ['Application', 'Window'].includes(node.type))?.rect;
  assert(rect && viewport && target.visibleToUser !== false);
  assert(['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key])));
  assert(rect.width > 0 && rect.height > 0);
  assert(image.width > 0 && image.height > 0 && viewport.width > 0 && viewport.height > 0);
  assert(
    Math.abs(image.width / viewport.width - image.height / viewport.height) < 0.001,
    'Require matching screenshot and native viewport dimensions',
  );
  const labels = image.text.filter((node) => node.text.trim() === 'Resume conversation');
  assert.equal(labels.length, 1, 'The paired screenshot must visibly render Resume conversation');
  const label = labels[0];
  assert(['x', 'y', 'width', 'height'].every((key) => Number.isFinite(label[key])));
  assert(
    label.width > 0 &&
      label.height > 0 &&
      label.x >= 0 &&
      label.y >= 0 &&
      label.x + label.width <= 1 &&
      label.y + label.height <= 1,
  );
  const labelX = viewport.x + (label.x + label.width / 2) * viewport.width;
  const labelY = viewport.y + (1 - label.y - label.height / 2) * viewport.height;
  assert(
    labelX >= rect.x &&
      labelX <= rect.x + rect.width &&
      labelY >= rect.y &&
      labelY <= rect.y + rect.height,
    'Rendered Resume must match the actual disabled control bounds',
  );
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Filesystem-only preflight. No subprocess, network, writes, device import or profile mutation. */
export async function resolveNativeStoreInputs(env, root) {
  const errors = [];
  const inputs = [];
  const need = (condition, label) => {
    if (!condition) errors.push(label);
  };
  const inspect = async (label, file, json = false) => {
    try {
      assert(file && path.isAbsolute(file));
      const resolved = await realpath(file);
      assert((await stat(resolved)).isFile());
      const raw = await readFile(resolved);
      inputs.push({ label, path: resolved, sha256: sha256(raw) });
      return json ? JSON.parse(raw) : raw;
    } catch {
      errors.push(`${label}: supply a readable valid input file`);
      return undefined;
    }
  };
  const directory = async (key) => {
    try {
      assert(env[key] && path.isAbsolute(env[key]));
      const resolved = await realpath(env[key]);
      assert((await stat(resolved)).isDirectory());
      return resolved;
    } catch {
      errors.push(`${key}: supply an existing absolute owned directory`);
    }
  };
  const home = await directory('FARMSLOT_HOME');
  const stateDir = await directory('FARMSLOT_AGENT_DEVICE_STATE_DIR');
  const artifacts = await directory('FARMSLOT_RECIPE_ARTIFACTS_DIR');
  const proxyDir = await directory('FARMSLOT_NATIVE_STORE_PROXY_DIR');
  need(
    env.FARMSLOT_NATIVE_STORE_PROXY_PORT === '7917',
    'FARMSLOT_NATIVE_STORE_PROXY_PORT must be 7917',
  );
  need(env.GATEWAY_PORT === '7914', 'GATEWAY_PORT must select upstream 7914');
  need(env.PLATFORM === 'ios', 'PLATFORM must be ios');
  need(Boolean(env.IOS_SIMULATOR), 'IOS_SIMULATOR must select the already reserved simulator');
  need(env.FARMSLOT_OFFLINE_PROOF === '1', 'FARMSLOT_OFFLINE_PROOF must be 1');
  need(env.FARMSLOT_DISABLE_ORCHESTRATION === '1', 'FARMSLOT_DISABLE_ORCHESTRATION must be 1');
  for (const key of ['METRO_PORT', 'GATEWAY_PORT'])
    need(
      /^[1-9]\d*$/.test(env[key] ?? '') && Number(env[key]) < 65536,
      `${key}: supply a valid owned port`,
    );
  need(env.METRO_PORT !== env.GATEWAY_PORT, 'Metro and gateway ports must differ');
  need(Boolean(env.FARMSLOT_GATEWAY_PROFILE), 'FARMSLOT_GATEWAY_PROFILE is required');
  const profiles = await inspect(
    'gateway profiles',
    home && path.join(home, 'gateways.json'),
    true,
  );
  const profile = profiles?.gateways?.[env.FARMSLOT_GATEWAY_PROFILE];
  let gatewayUrl;
  try {
    const url = new URL(profile.url);
    assert(['ws:', 'wss:'].includes(url.protocol));
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert(!url.username && !url.password && !url.search && !url.hash);
    assert.equal(url.port, env.GATEWAY_PORT);
    assert.equal(profile.authMode, 'token');
    assert(typeof profile.secret === 'string' && profile.secret.length > 0);
    gatewayUrl = url.toString();
    if (env.FARMSLOT_GATEWAY) assert.equal(new URL(env.FARMSLOT_GATEWAY).toString(), gatewayUrl);
  } catch {
    errors.push('gateway profile: require selected loopback token profile on GATEWAY_PORT');
  }
  const variant = env.APP_VARIANT || 'development';
  need(
    ['development', 'preview'].includes(variant),
    'APP_VARIANT must select an owned development or preview client',
  );
  const suffix = variant === 'development' ? '.development' : '.preview';
  const bundleId = env.BUNDLE_ID || `${env.SITEED_BUNDLE_BASE || 'net.siteed.farmslot'}${suffix}`;
  const scheme = env.SCHEME || `${env.SITEED_SCHEME_BASE || 'farmslot'}-${variant}`;
  need(/^[a-zA-Z][\w.-]+$/.test(bundleId), 'BUNDLE_ID must be an explicit valid app identifier');
  need(/^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme), 'SCHEME must be a valid deep-link scheme');
  const fixture = await inspect('native store fixture', env.FARMSLOT_NATIVE_STORE_PROOF, true);
  let fixtureRoot;
  let nativeRoot;
  try {
    fixtureRoot = await realpath(path.dirname(env.FARMSLOT_NATIVE_STORE_PROOF));
    assert.equal(await realpath(fixture.fixture), fixtureRoot);
    assert.equal(await realpath(fixture.home), home);
    assert.equal(await realpath(fixture.sourceRoot), await realpath(root));
    nativeRoot = await realpath(fixture.nativeA);
    assert(!path.relative(fixtureRoot, nativeRoot).startsWith('..'));
  } catch {
    errors.push('fixture: require the declared private fixture, home, source and native roots');
  }
  need(
    Array.isArray(fixture?.sessionsA) && fixture.sessionsA.length === 12,
    'fixture.sessionsA must contain exactly 12 owned local sessions',
  );
  const sessions = [];
  const ids = new Set();
  for (const [index, entry] of (Array.isArray(fixture?.sessionsA)
    ? fixture.sessionsA
    : []
  ).entries()) {
    const label = `sessionsA[${index}]`;
    const raw = await inspect(`${label}.journal`, entry?.journal);
    try {
      assert(/^[a-f0-9-]{36}$/.test(entry.id) && !ids.has(entry.id));
      ids.add(entry.id);
      assert.equal(entry.nodeId, 'local');
      assert.equal(entry.cursor, 660);
      assert(typeof entry.prefix === 'string' && entry.prefix.length > 0);
      assert(/^[a-f0-9]{64}$/.test(entry.sha256));
      assert(raw && sha256(raw) === entry.sha256);
      const journal = await realpath(entry?.journal);
      assert(nativeRoot && path.dirname(journal) === path.join(nativeRoot, 'sessions'));
      assert.equal(path.basename(journal), `${entry.id}.journal`);
      assert(raw.toString().endsWith('\n'));
      const records = raw
        .toString()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const info = records
        .map((record) => record.info)
        .filter(Boolean)
        .at(-1);
      const owner = typeof entry.owner === 'string' ? entry.owner : entry.owner?.id;
      assert(
        owner &&
          info?.id === entry.id &&
          info.ownerPrincipalId === owner &&
          info.executionNodeId === 'local' &&
          info.state === 'closed' &&
          !info.workerManaged,
      );
      const events = records.map((record) => record.event).filter(Boolean);
      assert.equal(events.length, 660);
      assert(events.every((event, i) => event.sequence === i + 1 && event.sessionId === entry.id));
      const logical = messages(events);
      assert.equal(logical.length, 220);
      assert.equal(logical[0].text, `${entry.prefix}_USER_0`);
      assert.equal(logical.at(-1).text, `${entry.prefix}_ASSISTANT_109_complete_fragment`);
      assert.equal(logical.slice(-200)[0].text, `${entry.prefix}_USER_10`);
      sessions.push({
        id: entry.id,
        nodeId: 'local',
        prefix: entry.prefix,
        owner,
        cursor: 660,
        journal,
        sha256: entry.sha256,
        storedId: storageId(entry.id),
        first: `${entry.prefix}_USER_10`,
        last: `${entry.prefix}_ASSISTANT_109_complete_fragment`,
        route: `${scheme}:///native?sessionId=${entry.id}&executionNodeId=local`,
      });
    } catch {
      errors.push(
        `${label}: require unique local CLOSED owned journal, matching hash, 660 sequential events and 220 complete messages with exact fixture labels`,
      );
    }
  }
  need(
    sessions.length === 12 && new Set(sessions.map((s) => s.owner)).size === 1,
    'all 12 validated sessions must belong to the same fixture owner',
  );
  const pool = await inspect('owned fleet proof pool', env.FARMSLOT_NATIVE_STORE_POOL_PROOF, true);
  let fleet;
  try {
    const poolFile = await realpath(env.FARMSLOT_NATIVE_STORE_POOL_PROOF);
    assert.equal(path.dirname(poolFile), await realpath(path.join(fixture.root, 'pool')));
    assert.equal(pool.slots.length, 1);
    const slotId = pool.slots[0].id;
    assert(/^[a-zA-Z0-9-]+$/.test(slotId));
    assert(typeof pool.machine === 'string' && pool.machine.length > 0);
    fleet = {
      poolFile,
      slotId,
      addedSlotId: `${slotId}-added`,
      machine: pool.machine,
      route: `${scheme}:///fleet`,
      slotRoute: `${scheme}:///workspace/slot/${slotId}/slot`,
    };
  } catch {
    errors.push('fleet proof: require one setup slot in a pool inside the owned fixture');
  }
  const recipePath = path.join(
    root,
    'apps/companion/scripts/agentic/recipe/recipes/offline-cold-start.recipe.json',
  );
  const recipe = await inspect('native store recipe', recipePath, true);
  const manifest = await inspect(
    'native action manifest',
    path.join(root, 'apps/companion/scripts/agentic/recipe/action-manifest.json'),
    true,
  );
  for (const relative of [
    'apps/companion/scripts/agentic/prove-native-store.mjs',
    'apps/companion/scripts/agentic/native-store-fixture.mjs',
    'apps/companion/scripts/agentic/d05-fixture.mjs',
    'apps/companion/scripts/agentic/simulator-dev-client.mjs',
    'apps/companion/scripts/agentic/prepare-dev-client.mjs',
    'apps/companion/src/farmslot/run-collections-proof.ts',
    'apps/command-center/scripts/owned-gateway-outage.mjs',
    'scripts/lib/gateway-profile.mjs',
  ])
    await inspect(relative, path.join(root, relative));
  if (recipe && manifest) {
    try {
      const findings = await d05RecipeErrors(recipe, manifest, {});
      errors.push(...findings.map((f) => `recipe: ${f.message || f.code || 'invalid contract'}`));
    } catch {
      errors.push('recipe: pure protocol/schema validation unavailable or invalid');
    }
  }
  if (errors.length) throw new Error(JSON.stringify({ ok: false, errors }, null, 2));
  const plan = {
    version: 1,
    root,
    home,
    stateDir,
    artifacts,
    proxyDir,
    proxyPort: 7917,
    platform: 'ios',
    simulator: env.IOS_SIMULATOR,
    profile: env.FARMSLOT_GATEWAY_PROFILE,
    gatewayUrl,
    metroPort: Number(env.METRO_PORT),
    gatewayPort: Number(env.GATEWAY_PORT),
    variant,
    bundleId,
    scheme,
    sessions,
    fleet,
    selectedId: sessions.at(-1).id,
    recipePath,
    recipeParams: {},
    resumeSelector: 'companion-native-resume',
    resumeLabel: 'Resume conversation',
    inputs,
  };
  return { ...plan, inputHash: sha256(JSON.stringify(plan)) };
}

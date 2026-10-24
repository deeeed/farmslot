import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const within = (root, file) =>
  file !== root &&
  !path.relative(root, file).startsWith('..') &&
  !path.isAbsolute(path.relative(root, file));
export const persistedQueries = {
  backlog: 'backlog.list:{"includeArchived":true}',
  roadmap: 'roadmap.list:{"includeArchived":true}',
  projects: 'config.projects:{}',
  queue: 'dispatch.queue.list:{}',
  graph: 'workGraph.list:{"includeArchived":true}',
};
export const nativePlanningConsumerPaths = [
  'apps/companion/src/app/work-graphs.tsx',
  'apps/companion/src/app/dispatch-queue.tsx',
  'apps/companion/src/features/planning/WorkGraphsScreen.tsx',
  'apps/companion/src/features/planning/DispatchQueueScreen.tsx',
  'apps/companion/src/features/planning/use-work-graphs-controller.ts',
  'apps/companion/src/features/planning/use-dispatch-queue-controller.ts',
  'apps/companion/src/features/planning/styles/planning-lists.ts',
];
export const observedMemoryMethods = [
  'prWatch.list',
  'prRules.list',
  'prPush.list',
  'copilot.status',
];
export const forbiddenPlanningMethods = [
  'backlog.create',
  'backlog.update',
  'backlog.delete',
  'backlog.markReady',
  'backlog.enqueue',
  'backlog.autoDispatchTick',
  'dispatch.queue.add',
  'dispatch.queue.remove',
  'dispatch.queue.removeOrphan',
  'dispatch.queue.update',
  'dispatch.queue.reorder',
  'workGraph.create',
  'workGraph.addNode',
  'workGraph.addEdge',
  'workGraph.removeNode',
  'workGraph.removeEdge',
  'workGraph.updateNode',
  'workGraph.activate',
  'workGraph.pause',
  'workGraph.retry',
  'workGraph.attachRun',
  'workGraph.gateResolve',
  'workGraph.schedulerTick',
  'run.create',
  'roadmap.save',
  'roadmap.delete',
  'roadmap.refine',
  'roadmap.promote',
  'prWatch.subscribe',
  'prWatch.configure',
  'prWatch.refresh',
  'prWatch.repair',
  'prReview.request',
  'prRules.scan',
  'prPush.register',
  'prPush.unregister',
  'copilot.start',
  'copilot.configure',
  'copilot.stop',
  'chat.send',
  'native.session.create',
  'native.session.ensure',
  'native.session.send',
  'native.session.respond',
  'native.session.close',
  'native.session.interrupt',
];
export async function exclusiveJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

/** Match actual committed source bytes, independent of index flags or cached Git stat data. */
export async function verifyNativePlanningSource(sourceRoot, sourceHead) {
  assert.match(sourceHead, /^[a-f0-9]{40}$/, 'Require the authorized full source commit');
  const root = await realpath(sourceRoot);
  const env = { ...process.env };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_NAMESPACE',
    'GIT_PREFIX',
  ])
    delete env[name];
  const execute = promisify(execFile);
  const git = async (...args) =>
    (
      await execute('git', ['-C', root, ...args], {
        env,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
  assert.equal(await realpath((await git('rev-parse', '--show-toplevel')).trim()), root);
  assert.equal((await git('rev-parse', 'HEAD')).trim(), sourceHead, 'Source commit changed');
  const extra = (await git('ls-files', '--others', '--exclude-standard', '-z'))
    .split('\0')
    .filter(Boolean);
  assert.equal(extra.length, 0, `Untracked source files: ${extra.join(', ')}`);
  const entries = (await git('ls-tree', '-rz', '--full-tree', sourceHead))
    .split('\0')
    .filter(Boolean);
  assert(entries.length, 'The frozen source tree must contain files');
  const manifest = [];
  for (const entry of entries) {
    const split = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, split).split(' ');
    const relative = entry.slice(split + 1);
    assert(
      type === 'blob' && ['100644', '100755'].includes(mode),
      `Unsupported source entry: ${relative}`,
    );
    const file = path.resolve(root, relative);
    assert(within(root, file), `Foreign source path: ${relative}`);
    const info = await lstat(file);
    assert(info.isFile(), `Source file is not regular: ${relative}`);
    assert.equal(
      info.mode & 0o777,
      mode === '100755' ? 0o755 : 0o644,
      `Source mode drift: ${relative}`,
    );
    const bytes = await readFile(file);
    const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(actual, oid, `Source bytes drift: ${relative}`);
    manifest.push({ path: relative, mode, oid });
  }
  return {
    sourceHead,
    sourceTreeSha256: digest(JSON.stringify(manifest)),
    fileCount: manifest.length,
  };
}

/** Read-only, action-free input resolution. This never prepares fixtures or contacts a device. */
export async function resolveNativePlanningInputs(env, sourceRoot) {
  assert(env.FARMSLOT_D07_NATIVE_FIXTURE, 'Canonical D07 recipe requires a prepared fixture input');
  const root = await realpath(sourceRoot);
  const fixtureFile = await realpath(env.FARMSLOT_D07_NATIVE_FIXTURE);
  const fixtureRaw = await readFile(fixtureFile);
  const f = JSON.parse(fixtureRaw);
  assert.equal(f.version, 2, 'Prepare a fresh D07 fixture; legacy source pins cannot be reused');
  assert(env.FARMSLOT_D07_NATIVE_AUTHORIZATION, 'Require the actual source authorization');
  const authorization = JSON.parse(await readFile(env.FARMSLOT_D07_NATIVE_AUTHORIZATION, 'utf8'));
  assert.equal(authorization.executionAuthorized, true);
  assert.equal(authorization.purpose, 'D07-native-planning');
  const sourceVerification = await verifyNativePlanningSource(root, authorization.sourceHead);
  assert.equal(f.sourceHead, sourceVerification.sourceHead);
  assert.deepEqual(f.sourceVerification, sourceVerification, 'Frozen source verification changed');
  assert.equal(f.initialRoute, 'backlog', 'D07 starts in planning, not a native conversation');
  assert.equal(await realpath(f.sourceRoot), root);
  assert.equal(await realpath(f.home), await realpath(env.FARMSLOT_HOME));
  assert.equal(await realpath(f.farmRoot), await realpath(env.FARMSLOT_ROOT));
  assert.notEqual(f.farmRoot, root);
  assert(!within(root, f.farmRoot) && !within(f.farmRoot, root));
  assert.notEqual(await realpath(f.fixtureRoot), root);
  assert(within(await realpath(f.fixtureRoot), fixtureFile));
  assert(!within(root, f.fixtureRoot), 'Never prepare in product source');
  assert.match(f.project, /^d07-native-[a-z0-9-]+$/);
  assert.match(f.addedProject, /^d07-native-[a-z0-9-]+$/);
  assert.notEqual(f.project, f.addedProject);
  assert.equal(env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
  assert.equal(env.FARMSLOT_OFFLINE_PROOF, '1');
  assert.equal(await realpath(env.FARMSLOT_PROJECTS_DIR), f.projectsDir);
  assert(within(f.farmRoot, f.projectsDir));
  const inputs = [{ label: 'd07-fixture', path: fixtureFile, sha256: digest(fixtureRaw) }];
  assert(f.sourceWriter, 'Backlog changes require the actual owning API, not raw JSON replacement');
  const writerCredential = await realpath(f.sourceWriter.credentialFile);
  assert(within(await realpath(f.fixtureRoot), writerCredential));
  const writerBytes = await readFile(writerCredential);
  assert.equal(digest(writerBytes), f.sourceWriter.credentialSha256);
  const writerUrl = new URL(f.sourceWriter.url);
  assert(['127.0.0.1', 'localhost'].includes(writerUrl.hostname) && writerUrl.protocol === 'ws:');
  assert.equal(writerUrl.port, '7914', 'Source writers bypass the app-only proxy');
  assert(!writerUrl.username && !writerUrl.password && !writerUrl.search);
  assert(f.sourceWriter.principalId);
  inputs.push({
    label: 'source-writer-credential',
    path: writerCredential,
    sha256: digest(writerBytes),
  });
  for (const name of ['backlog', 'roadmap', 'project', 'queue', 'graph']) {
    const entry = f.files[name];
    const file = await realpath(entry.path);
    assert(within(f.farmRoot, file), `Foreign ${name} source`);
    const bytes = await readFile(file);
    assert.equal(
      digest(bytes),
      entry.sha256,
      `Original ${name} input drift; preserve consumed source`,
    );
    inputs.push({ label: `d07-${name}-original`, path: file, sha256: digest(bytes) });
  }
  assert.equal(f.files.newProject.path, path.join(f.projectsDir, f.addedProject, 'project.json'));
  try {
    await stat(f.files.newProject.path);
    assert.fail('New project source must still be absent');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const relative of [
    'apps/companion/scripts/agentic/native-planning-fixture.mjs',
    'apps/companion/scripts/agentic/prove-native-planning.mjs',
    'apps/companion/scripts/agentic/prepare-native-planning-inputs.mjs',
    'apps/companion/scripts/agentic/native-store-fixture.mjs',
    'apps/companion/scripts/agentic/prove-native-store.mjs',
    'apps/companion/scripts/agentic/simulator-dev-client.mjs',
    'apps/companion/scripts/agentic/prepare-dev-client.mjs',
    'apps/companion/scripts/agentic/recognize-simulator-prompt.jxa',
    'apps/companion/scripts/agentic/recipe/recipes/offline-cold-start.recipe.json',
    'apps/command-center/scripts/owned-gateway-outage.mjs',
    'apps/companion/src/features/planning/planning-resources.ts',
    'apps/companion/src/hooks/useConfigurationProjects.ts',
    'apps/companion/src/features/pr-automation/use-pr-automation-controller.ts',
    'apps/companion/src/features/copilot/use-copilot-controller.ts',
    'apps/companion/src/farmslot/run-collections-proof.ts',
    'packages/protocol/src/client-cache/registry.ts',
    ...nativePlanningConsumerPaths,
  ])
    inputs.push({
      label: relative,
      path: path.join(root, relative),
      sha256: digest(await readFile(path.join(root, relative))),
    });
  for (const [name, entry] of Object.entries(f.setupInputs)) {
    const bytes = await readFile(entry.path);
    assert.equal(digest(bytes), entry.sha256, `Setup receipt changed: ${name}`);
    inputs.push({ label: `actual-setup-${name}`, path: entry.path, sha256: entry.sha256 });
  }
  assert.equal(f.expected.backlog.status, 'candidate');
  assert(
    f.expected.backlog.id && f.expected.roadmap.id && f.expected.queue.id && f.expected.graph.id,
  );
  assert(f.expected.graph.title && f.expected.queue.label);
  assert(Number.isFinite(f.expected.queue.priority));
  assert(f.expected.backlog.before !== f.expected.backlog.after);
  assert(f.expected.roadmap.before !== f.expected.roadmap.after);
  assert(
    f.nativeCompatibilityReceipt,
    'Actual native comparison receipt is required, not a symbol inspection',
  );
  const compatibilityRaw = await readFile(f.nativeCompatibilityReceipt);
  const compatibility = JSON.parse(compatibilityRaw);
  assert.equal(compatibility.sourceHead, f.sourceHead);
  assert.equal(
    compatibility.compatibilityVerified,
    true,
    'Generated inputs and actual signed artifact remain a ROOT preflight gate',
  );
  assert.match(compatibility.executableSha256, /^[a-f0-9]{64}$/);
  assert.equal(compatibility.missingComparisons?.length, 0);
  inputs.push({
    label: 'actual-d07-native-compatibility',
    path: f.nativeCompatibilityReceipt,
    sha256: digest(compatibilityRaw),
  });
  return { ...f, fixtureFile, inputs, inputHash: digest(JSON.stringify(inputs)), persistedQueries };
}

async function updateOwnedBacklog(plan) {
  const credentialBytes = await readFile(plan.sourceWriter.credentialFile);
  assert.equal(digest(credentialBytes), plan.sourceWriter.credentialSha256);
  const credential = JSON.parse(credentialBytes);
  assert(typeof credential.secret === 'string' && credential.secret.length > 0);
  const url = new URL(plan.sourceWriter.url);
  assert(url.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.port, '7914');
  assert(!url.username && !url.password && !url.search);
  const { default: WebSocket } = await import('ws');
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    let finished = false;
    let authorized = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Owning backlog writer deadline')), 5000);
    socket.once('error', () => finish(new Error('Owning backlog writer transport failed')));
    socket.once('open', () =>
      socket.send(
        JSON.stringify({
          type: 'req',
          id: 'writer-auth',
          method: 'auth.connect',
          params: {
            clientKind: 'cli',
            clientName: 'd07-owning-source-writer',
            token: credential.secret,
          },
        }),
      ),
    );
    socket.on('message', (bytes) => {
      if (finished) return;
      let frame;
      try {
        frame = JSON.parse(String(bytes));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        finish(new Error('Owning source reply was not valid JSON'));
        return;
      }
      if (frame.type !== 'res') return;
      if (frame.id === 'writer-auth') {
        if (authorized) return;
        const principal = frame.payload?.principal;
        if (
          !frame.ok ||
          principal?.id !== plan.sourceWriter.principalId ||
          !Array.isArray(principal.roles) ||
          !principal.roles.some((binding) => binding.role === 'admin')
        ) {
          finish(new Error('Owning backlog writer authority refused'));
          return;
        }
        authorized = true;
        socket.send(
          JSON.stringify({
            type: 'req',
            id: 'writer-update',
            method: 'backlog.update',
            params: { itemId: plan.expected.backlog.id, title: plan.expected.backlog.after },
          }),
        );
      } else if (frame.id === 'writer-update') {
        if (!frame.ok) finish(new Error('Owning backlog update refused'));
        else finish(undefined, frame.payload);
      }
    });
  });
}

/** One real external source mutation, once, with immutable raw before/after provenance. */
export async function writePlanningSource(plan, kind, artifacts) {
  assert.match(
    plan.sourceHead,
    /^[a-f0-9]{40}$/,
    'Source writer requires the verified source commit',
  );
  assert(['backlog', 'roadmap', 'newProject'].includes(kind));
  const receipt = path.join(artifacts, `d07-writer-${kind}.json`);
  try {
    await stat(receipt);
    assert.fail('Writer was already consumed');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const file = plan.files[kind].path;
  assert(within(plan.farmRoot, file));
  assert.equal(await realpath(plan.projectsDir), plan.projectsDir);
  if (kind !== 'newProject') assert.equal(await realpath(file), file);
  let before;
  let after;
  if (kind === 'newProject') {
    // Exclusively create only the declared new project; no wildcard replacement/deletion.
    await mkdir(path.dirname(file), { mode: 0o700 });
    after = Buffer.from(
      `${JSON.stringify({ name: plan.addedProject, default_branch: 'main' }, null, 2)}\n`,
    );
    await writeFile(file, after, { flag: 'wx', mode: 0o600 });
  } else {
    before = await readFile(file);
    assert.equal(
      digest(before),
      plan.files[kind].sha256,
      'External source changed before owned writer',
    );
    if (kind === 'backlog') {
      const rows = JSON.parse(before);
      const row = rows.find((entry) => entry.id === plan.expected.backlog.id);
      assert.equal(row.title, plan.expected.backlog.before);
      assert.equal(row.status, 'candidate');
      const committed = await updateOwnedBacklog(plan);
      assert.equal(committed.item.id, row.id);
      assert.equal(committed.item.title, plan.expected.backlog.after);
      assert.equal(committed.item.status, 'candidate');
      after = await readFile(file);
      const current = JSON.parse(after);
      assert.equal(current.find((entry) => entry.id === row.id).title, committed.item.title);
      assert.deepEqual(
        current.filter((entry) => entry.id !== row.id),
        rows.filter((entry) => entry.id !== row.id),
      );
    } else {
      const raw = before.toString('utf8');
      assert.equal(
        raw.split(plan.expected.roadmap.before).length,
        2,
        'Require one owning roadmap title',
      );
      after = Buffer.from(raw.replace(plan.expected.roadmap.before, plan.expected.roadmap.after));
    }
    if (kind !== 'backlog') {
      const temporary = `${file}.d07-proof-tmp`;
      await writeFile(temporary, after, { flag: 'wx', mode: 0o600 });
      // Recheck before commit. The fixture is exclusively owned; this is not a cross-process lock.
      assert.equal(digest(await readFile(file)), digest(before));
      await rename(temporary, file);
    }
  }
  assert.equal(digest(await readFile(file)), digest(after));
  if (before)
    await writeFile(path.join(artifacts, `d07-${kind}-before.raw`), before, {
      flag: 'wx',
      mode: 0o600,
    });
  await writeFile(path.join(artifacts, `d07-${kind}-after.raw`), after, {
    flag: 'wx',
    mode: 0o600,
  });
  await exclusiveJson(receipt, {
    kind,
    method: kind === 'backlog' ? 'backlog.update' : 'owned-file-write',
    path: file,
    before: before ? digest(before) : null,
    after: digest(after),
    committedAt: Date.now(),
    sourceHead: plan.sourceHead,
  });
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const hash = (raw) => createHash('sha256').update(raw).digest('hex');
const inside = (root, file) =>
  file === root ||
  (!path.relative(root, file).startsWith('..') && !path.isAbsolute(path.relative(root, file)));
export async function optionalStat(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export const d05InboxBody = (plan) =>
  JSON.stringify({
    id: plan.inbox.id,
    type: 'blocked_alert',
    title: plan.inbox.title,
    description: 'A worker file must reach the real native inbox without Refresh.',
    actions: [{ id: 'acknowledge', label: 'Acknowledge' }],
    created_at: plan.savedRun.createdAt,
  });

/** iOS includes an empty multiline input's placeholder in its accessibility label. */
export function d05NativeControl(nodes, label) {
  if (label.startsWith('Issue reason for ')) {
    const input = nodes.find(
      (node) =>
        node.type === 'TextView' && (node.label === label || node.label?.startsWith(`${label} `)),
    );
    if (input) return input;
  }
  return nodes.find((node) => node.label === label);
}

/** Use the runner's pure contract validators before the single native device window. */
export async function d05RecipeErrors(recipe, manifest, params) {
  const { applyRecipeParamDefaults, validateRecipeWithManifest, validateRecipeParams } =
    await import('@farmslot/protocol');
  return [
    ...validateRecipeWithManifest(recipe, manifest, { adapter: 'ios' }).findings,
    ...validateRecipeParams(
      applyRecipeParamDefaults(params, recipe.paramsSchema),
      recipe.paramsSchema,
    ).findings,
  ].filter((finding) => finding.severity === 'error');
}

/** All filesystem inputs are inspected before a device module is imported. No writes or RPC. */
export async function resolveD05Inputs(env, sourceRoot) {
  const errors = [];
  const inputs = [];
  const need = (value, message) => {
    if (!value) errors.push(message);
    return value;
  };
  const check = async (label, action) => {
    try {
      return await action();
    } catch {
      errors.push(
        `${label}: missing, unreadable or invalid; repair this input before native execution`,
      );
      return undefined;
    }
  };
  const file = async (label, value, json = false) => {
    if (!need(value, `${label}: set its explicit input path`)) return undefined;
    return check(label, async () => {
      assert(!(await lstat(value)).isSymbolicLink());
      const canonical = await realpath(value);
      assert((await lstat(canonical)).isFile());
      const raw = await readFile(canonical);
      inputs.push({ path: canonical, sha256: hash(raw), label });
      return json ? JSON.parse(raw) : canonical;
    });
  };
  const home = await check('FARMSLOT_HOME', async () => {
    assert(env.FARMSLOT_HOME);
    const canonical = await realpath(env.FARMSLOT_HOME);
    assert((await lstat(canonical)).isDirectory());
    return canonical;
  });
  need(env.PLATFORM === 'ios', 'PLATFORM: D05 attempt requires ios; no Android attempt');
  need(
    env.IOS_SIMULATOR,
    'IOS_SIMULATOR: select the reserved simulator identifier without booting it',
  );
  need(env.FARMSLOT_OFFLINE_PROOF === '1', 'FARMSLOT_OFFLINE_PROOF must be 1');
  need(env.FARMSLOT_DISABLE_ORCHESTRATION === '1', 'FARMSLOT_DISABLE_ORCHESTRATION must be 1');
  need(
    env.FARMSLOT_GATEWAY_PROFILE,
    'FARMSLOT_GATEWAY_PROFILE: select the isolated service profile',
  );
  for (const key of ['METRO_PORT', 'GATEWAY_PORT'])
    need(/^[1-9]\d*$/.test(env[key] ?? ''), `${key}: supply the isolated port`);
  const baselineInput = await file(
    'FARMSLOT_RUN_PROOF_FIXTURE',
    env.FARMSLOT_RUN_PROOF_FIXTURE,
    true,
  );
  const baseline =
    baselineInput &&
    Object.fromEntries(
      ['home', 'runId', 'runFile', 'taskFile', 'workerRepo', 'workerTaskFile']
        .filter((key) => baselineInput[key] !== undefined)
        .map((key) => [key, baselineInput[key]]),
    );
  const run = await file('baseline.runFile', baseline?.runFile, true);
  if (home && baseline && run) {
    need(baseline.home === home, 'baseline.home must equal canonical FARMSLOT_HOME');
    need(
      baseline.runId === run.id && baseline.runFile === path.join(home, 'runs', `${run.id}.json`),
      'baseline run identity/path must match the owned home run',
    );
    need(run.readOnly === false, 'baseline run must be owned and writable, not an imported row');
    const { isActiveListRun } = await import('@farmslot/protocol');
    need(
      Boolean(run.slotId) && isActiveListRun(run),
      'baseline run must belong to the active view and have a real slot progress target',
    );
    need(!run.archivedAt, 'baseline run must not be archived');
    need(
      typeof run.createdAt === 'string' && Number.isFinite(Date.parse(run.createdAt)),
      'baseline run must have a valid createdAt for deterministic fixture contents',
    );
    need(
      typeof run.ticketOrPr === 'string' && run.ticketOrPr.length > 0,
      'baseline run must have a visible exact ticketOrPr title',
    );
    if (baseline.taskFile)
      need(baseline.taskFile === run.taskFile, 'baseline.taskFile must match actual run.taskFile');
  }
  const taskPaths = [...new Set([run?.taskFile, run?.activeTaskFile].filter(Boolean))];
  need(taskPaths.length, 'baseline taskFile: require the actual gateway task file');
  for (const task of taskPaths) {
    const actual = await file('actual run task copy', task);
    if (home && actual)
      need(inside(home, actual), 'run task copy must be confined to isolated FARMSLOT_HOME');
  }
  // Worker mirrors can differ from the gateway task path; resolve both explicitly.
  const workerTask = env.FARMSLOT_D05_WORKER_TASK ?? baseline?.workerTaskFile;
  const actualWorkerTask = await file(
    'FARMSLOT_D05_WORKER_TASK / baseline.workerTaskFile',
    workerTask,
  );
  if (home && actualWorkerTask)
    need(
      inside(home, actualWorkerTask),
      'worker task copy must be confined to isolated FARMSLOT_HOME',
    );
  if (baseline?.workerRepo && workerTask) {
    const repo = await check('baseline.workerRepo', () => realpath(baseline.workerRepo));
    const actual = await check('actual worker task confinement', () => realpath(workerTask));
    if (repo && home)
      need(inside(home, repo), 'worker repository must be inside isolated FARMSLOT_HOME');
    if (repo && actual)
      need(inside(repo, actual), 'actual worker task must be inside baseline.workerRepo');
  }
  const profile = await file(
    'FARMSLOT_NATIVE_VISUAL_IOS_PROFILE',
    env.FARMSLOT_NATIVE_VISUAL_IOS_PROFILE,
    true,
  );
  if (profile && env.FARMSLOT_GATEWAY_PROFILE && sourceRoot)
    await check('isolated gateway profile and native credential', async () => {
      const { automationGatewayTarget } = await import(
        path.join(sourceRoot, 'scripts/lib/gateway-profile.mjs')
      );
      const selected = await automationGatewayTarget(
        env.FARMSLOT_GATEWAY,
        env.FARMSLOT_GATEWAY_PROFILE,
      );
      assert(profile.presetSecret === selected?.credential.token);
      assert.equal(new URL(selected.url).port, env.GATEWAY_PORT);
    });
  if (profile)
    await check('iOS service profile', async () => {
      assert(profile.id && profile.authMode === 'token' && profile.presetSecret);
      const url = new URL(profile.url);
      assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
      assert.equal(url.port, env.GATEWAY_PORT);
    });
  let media;
  if (
    need(
      env.FARMSLOT_NATIVE_VISUAL_SOURCE,
      'FARMSLOT_NATIVE_VISUAL_SOURCE: select the genuine retained media directory',
    )
  ) {
    media = await check('genuine recorded visual closure', async () => {
      const { inspectNativeVisualSource } = await import('./native-visual-fixture.mjs');
      const result = await inspectNativeVisualSource(env.FARMSLOT_NATIVE_VISUAL_SOURCE);
      for (const entry of result.read.input.artifactPaths)
        await file(`retained media ${entry}`, path.join(result.source, entry));
      const { recordedEvidenceClosureIdentity } = await import('@farmslot/protocol');
      return {
        source: result.source,
        recipeRunId: result.read.input.claims.recipeRunId,
        claimId: result.claim.id,
        closureIdentity: recordedEvidenceClosureIdentity(result.read.input),
      };
    });
  }
  const artifactRoot =
    env.FARMSLOT_D05_ARTIFACT_ROOT && path.resolve(env.FARMSLOT_D05_ARTIFACT_ROOT);
  need(
    artifactRoot,
    'FARMSLOT_D05_ARTIFACT_ROOT: supply the private parent for both recipe artifact directories',
  );
  const receipt = env.FARMSLOT_NATIVE_RUN_RECEIPT && path.resolve(env.FARMSLOT_NATIVE_RUN_RECEIPT);
  need(receipt, 'FARMSLOT_NATIVE_RUN_RECEIPT: supply the private receipt path');
  if (receipt)
    await check('native receipt parent directory', async () => {
      const state = await lstat(path.dirname(receipt));
      assert(state.isDirectory() && !state.isSymbolicLink());
    });
  if (artifactRoot)
    await check('native artifact root directory', async () => {
      const state = await lstat(artifactRoot);
      assert(state.isDirectory() && !state.isSymbolicLink());
    });
  const projects = await check('FARMSLOT_PROJECTS_DIR', async () => {
    assert(env.FARMSLOT_PROJECTS_DIR);
    return realpath(env.FARMSLOT_PROJECTS_DIR);
  });
  if (projects && home)
    need(inside(home, projects), 'projects directory must be confined to isolated home');
  const seed = hash(`${home}:${baseline?.runId}:${receipt}`);
  const uuid = (suffix) => {
    const h = hash(`${seed}:${suffix}`);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const visualId = uuid('visual');
  const decisionId = uuid('inbox');
  const visualProject = `native-visual-${visualId}`;
  const decisionProject = `offline-native-inbox-${decisionId}`;
  const visualDirectory = home && path.join(home, 'projects', visualProject, 'tasks', visualId);
  const inboxProject = home && path.join(home, 'projects', decisionProject);
  const plan = {
    version: 1,
    planId: seed,
    home,
    baseline,
    inputs,
    recipeParams: { detail_title: run?.ticketOrPr },
    savedRun: {
      id: run?.id,
      title: run?.ticketOrPr,
      createdAt: run?.createdAt,
      selector: `Open run ${run?.id}`,
      taskFiles: taskPaths,
      workerTask,
    },
    inbox: {
      id: decisionId,
      title: 'Offline native inbox proof',
      actionId: 'acknowledge',
      actionSelector: 'companion-decision-action-acknowledge',
      project: inboxProject,
      file: inboxProject && path.join(inboxProject, 'tasks', 'decision', '.pending_decision.json'),
      receipt,
    },
    visual: {
      id: visualId,
      project: visualProject,
      projectDir: projects && path.join(projects, visualProject),
      directory: visualDirectory,
      runFile: home && path.join(home, 'runs', `${visualId}.json`),
      media,
    },
    artifactRoot,
    runtime: {
      platform: env.PLATFORM,
      simulator: env.IOS_SIMULATOR,
      metro: env.METRO_PORT,
      gatewayPort: env.GATEWAY_PORT,
      projectsDir: projects,
    },
  };
  for (const target of [
    artifactRoot,
    inboxProject,
    visualDirectory,
    plan.visual.projectDir,
    receipt && path.dirname(receipt),
  ].filter(Boolean)) {
    await check(`scratch confinement ${target}`, async () => {
      let current = path.resolve(target);
      while (current !== path.dirname(current)) {
        const state = await optionalStat(current);
        if (state) {
          assert(state.isDirectory() && !state.isSymbolicLink());
        }
        current = path.dirname(current);
      }
    });
  }
  if (visualDirectory && media)
    await check('reusable visual fixture contents', async () => {
      const { inspectNativeVisualSource, nativeVisualSupportFiles } =
        await import('./native-visual-fixture.mjs');
      const source = await inspectNativeVisualSource(media.source);
      const expected = new Map(
        Object.entries(nativeVisualSupportFiles).map(([relative, raw]) => [
          relative,
          Buffer.from(raw),
        ]),
      );
      for (const relative of source.read.input.artifactPaths) {
        expected.set(
          path.join('artifacts/recipe-runs/native-visual-fixture', relative),
          await readFile(path.join(media.source, relative)),
        );
      }
      for (const [relative, raw] of expected) {
        const target = path.join(visualDirectory, relative);
        await new D05FixtureOwner([visualDirectory]).physicalParents(target);
        const state = await optionalStat(target);
        if (state) {
          assert(state.isFile() && !state.isSymbolicLink());
          assert((await readFile(target)).equals(raw));
        }
      }
    });
  // Existing directories/sentinels may be reused, but reserved dynamic files cannot be adopted.
  for (const target of [
    plan.visual.runFile,
    plan.visual.projectDir && path.join(plan.visual.projectDir, 'project.json'),
  ].filter(Boolean)) {
    await check('reserved dynamic fixture', async () => {
      assert(
        !(await optionalStat(target)),
        'Choose a fresh receipt path; do not adopt dynamic fixture files',
      );
    });
  }
  if (plan.inbox.file) {
    await check('existing worker decision fixture identity', async () => {
      const state = await optionalStat(plan.inbox.file);
      if (!state) return;
      assert(state.isFile() && !state.isSymbolicLink());
      await new D05FixtureOwner([plan.inbox.project]).physicalParents(plan.inbox.file);
      assert.equal(await readFile(plan.inbox.file, 'utf8'), d05InboxBody(plan));
    });
  }
  if (receipt) {
    await check('existing D05 receipt ownership', async () => {
      const state = await optionalStat(receipt);
      if (!state) return;
      assert(state.isFile() && !state.isSymbolicLink());
      const existing = JSON.parse(await readFile(receipt, 'utf8'));
      assert.equal(existing.planId, plan.planId);
      assert.equal(existing.file, plan.inbox.file);
      assert.equal(existing.id, plan.inbox.id);
      assert.equal(existing.receiptOwned, true);
      assert(
        Array.isArray(existing.ownership.files) && Array.isArray(existing.ownership.directories),
      );
      new D05FixtureOwner([plan.inbox.project, receipt], existing.ownership);
    });
  }
  const actionManifest = await file(
    'recipe action manifest',
    path.join(sourceRoot, 'apps/companion/scripts/agentic/recipe/action-manifest.json'),
    true,
  );
  for (const recipe of ['runs-live.recipe.json', 'recorded-visual-runs-live.recipe.json']) {
    const document = await file(
      `living recipe ${recipe}`,
      path.join(sourceRoot, 'apps/companion/scripts/agentic/recipe/recipes', recipe),
      true,
    );
    if (document && actionManifest) {
      const findings = await d05RecipeErrors(document, actionManifest, plan.recipeParams);
      for (const finding of findings) errors.push(`${recipe} ${finding.path}: ${finding.message}`);
    }
  }
  if (env.FARMSLOT_D05_DETAIL_TITLE !== undefined)
    need(
      env.FARMSLOT_D05_DETAIL_TITLE === run?.ticketOrPr,
      'detail_title recipe parameter must equal the resolved actual baseline title',
    );
  if (errors.length)
    throw new Error(`D05 preflight failed (${errors.length} inputs):\n- ${errors.join('\n- ')}`);
  return plan;
}

/** Fresh preflight every phase, then compare to the same root-approved immutable plan. */
export async function consumeD05Plan(env, sourceRoot) {
  assert(env.FARMSLOT_D05_PLAN, 'Run dry-preflight and set FARMSLOT_D05_PLAN first');
  const expected = JSON.parse(await readFile(env.FARMSLOT_D05_PLAN, 'utf8'));
  const current = await resolveD05Inputs(env, sourceRoot);
  assert.deepEqual(
    current,
    expected,
    'D05 fixture inputs changed since dry preflight; resolve headlessly before the attempt',
  );
  if (env.FARMSLOT_RECIPE_ARTIFACTS_DIR)
    assert(
      inside(current.artifactRoot, path.resolve(env.FARMSLOT_RECIPE_ARTIFACTS_DIR)),
      'Recipe artifacts must remain under preflight artifact root',
    );
  assert.equal(
    env.FARMSLOT_D05_DETAIL_TITLE,
    current.recipeParams.detail_title,
    'Pass the resolved exact detail_title to the living recipe',
  );
  return current;
}

/** Reused directories/files are never owned by this invocation. No recursive deletion. */
export class D05FixtureOwner {
  constructor(roots, journal = { files: [], directories: [] }) {
    this.roots = roots.map((root) => path.resolve(root));
    this.journal = journal;
    for (const entry of [...journal.files, ...journal.directories]) {
      this.assertPath(entry.path);
      assert(
        Number.isInteger(entry.dev) && Number.isInteger(entry.ino),
        'Invalid ownership identity',
      );
    }
    for (const entry of journal.files)
      assert(/^[a-f0-9]{64}$/.test(entry.sha256), 'Invalid owned file digest');
  }
  assertPath(file) {
    const resolved = path.resolve(file);
    assert(
      this.roots.some((root) => inside(root, resolved)),
      'Fixture path escapes reserved scratch roots',
    );
    return resolved;
  }
  async physicalParents(file) {
    let current = path.dirname(file);
    while (current !== path.dirname(current)) {
      const state = await optionalStat(current);
      if (state)
        assert(
          state.isDirectory() && !state.isSymbolicLink(),
          'Fixture ancestor must not be a symlink',
        );
      current = path.dirname(current);
    }
  }
  async directory(file) {
    file = this.assertPath(file);
    await this.physicalParents(file);
    const existing = await optionalStat(file);
    if (existing) {
      assert(
        existing.isDirectory() && !existing.isSymbolicLink(),
        'Fixture directory must not be a symlink',
      );
      return;
    }
    const parent = path.dirname(file);
    if (this.roots.some((root) => inside(root, parent))) await this.directory(parent);
    await mkdir(file);
    const created = await lstat(file);
    this.journal.directories.push({ path: file, dev: created.dev, ino: created.ino });
  }
  async write(file, raw) {
    file = this.assertPath(file);
    await this.physicalParents(file);
    const parent = path.dirname(file);
    if (this.roots.some((root) => inside(root, parent))) await this.directory(parent);
    else {
      const parentState = await lstat(parent);
      assert(parentState.isDirectory() && !parentState.isSymbolicLink());
    }
    const state = await optionalStat(file);
    if (state) {
      assert(state.isFile() && !state.isSymbolicLink(), 'Fixture file must be a regular file');
      assert(
        (await readFile(file)).equals(Buffer.from(raw)),
        'Existing fixture file differs; preserve it and repair headlessly',
      );
      return;
    }
    await writeFile(file, raw, { flag: 'wx', mode: 0o600 });
    const created = await lstat(file);
    this.journal.files.push({
      path: file,
      dev: created.dev,
      ino: created.ino,
      sha256: hash(Buffer.from(raw)),
    });
  }
  /** Follow a known gateway write to this invocation's run, never an unowned file. */
  async followRunWrites(file, expectedRun) {
    file = this.assertPath(file);
    const entry = this.journal.files.find((candidate) => candidate.path === file);
    assert(entry, 'Only a newly owned run file can follow gateway writes');
    await this.physicalParents(file);
    const current = await lstat(file);
    assert(current.isFile() && !current.isSymbolicLink());
    const raw = await readFile(file);
    const saved = JSON.parse(raw);
    assert.equal(path.basename(file), `${expectedRun.id}.json`);
    assert.equal(saved.id, expectedRun.id);
    for (const [key, value] of Object.entries(saved))
      assert.deepEqual(
        value,
        expectedRun[key],
        'Run file differs from the independent gateway read',
      );
    Object.assign(entry, { dev: current.dev, ino: current.ino, sha256: hash(raw) });
  }
  async cleanup() {
    for (const entry of [...this.journal.files].reverse()) {
      const file = this.assertPath(entry.path);
      await this.physicalParents(file);
      const current = await optionalStat(file);
      // A second writer's replacement is foreign, even at our original filename.
      if (
        !current ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== entry.dev ||
        current.ino !== entry.ino ||
        hash(await readFile(file)) !== entry.sha256
      )
        continue;
      await unlink(file);
    }
    for (const entry of [...this.journal.directories].reverse()) {
      const dir = this.assertPath(entry.path);
      await this.physicalParents(dir);
      const current = await optionalStat(dir);
      if (
        !current ||
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== entry.dev ||
        current.ino !== entry.ino
      )
        continue;
      try {
        await rmdir(dir);
      } catch (error) {
        // A foreign sentinel or later writer retains this directory; never remove its contents.
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      }
    }
  }
}

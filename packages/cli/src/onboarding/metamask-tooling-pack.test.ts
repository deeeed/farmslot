import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseMarkdownDocument } from '@farmslot/agent-runtime';
import { recipeFlowRequirements, resolveRecipeProofRequirements } from '@farmslot/protocol';
import {
  expandTemplate,
  type ProjectVars,
  type RawProjectJson,
  type SlotVars,
  validateRuntimeCapabilitiesConfig,
} from '@farmslot/slot-config';

import { projectName, projectShortName, validatePackDir } from './pack.js';
import {
  defaultDevServerResource,
  defaultResources,
  generatePool,
  registerSlot,
  writePool,
} from './pool-config.js';

const { lintWorkerTemplateStructure } = createRequire(import.meta.url)(
  '@farmslot/agent-runtime/scripts/worker-terminal-contract.cjs',
) as { lintWorkerTemplateStructure: (content: string) => string[] };

const pack = fileURLToPath(new URL('../../../../packs/metamask-tooling/', import.meta.url));
const PROJECTS = ['metamask-harness-farm', 'metamask-recipe-perps-farm'] as const;
const NODE22 = process.versions.node.split('.')[0] === '22';

function readProject(name: string): RawProjectJson {
  return JSON.parse(readFileSync(join(pack, 'projects', name, 'project.json'), 'utf8'));
}

function scratch(t: test.TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tooling(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [join(pack, 'projects', PROJECTS[0], 'scripts/tooling.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 4000,
  });
}

test('the tooling pack passes real onboarding validation without operator pool configuration', () => {
  const result = validatePackDir(pack, join(tmpdir(), 'metamask-tooling-no-operator-pool'));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.pack?.projects.map(projectName), [...PROJECTS]);
  assert.deepEqual(result.pack?.projects.map(projectShortName), ['mmh', 'mmrp']);
  assert.ok(result.pack?.projects.every((project) => project.platform === 'ios'));
});

test('each project validates its runtime capabilities and declares a QA profile', () => {
  for (const name of PROJECTS) {
    const project = readProject(name);
    assert.doesNotThrow(() => validateRuntimeCapabilitiesConfig(project, `${name}/project.json`));
    assert.equal(project.qa?.profiles[0]?.template_id, 'qa/tooling');
  }
});

test('each project owns a distinct sibling Mobile checkout and never names a product farm slot', () => {
  const mobile = PROJECTS.map((name) => readProject(name).reference_repos?.mobile?.local_name);
  assert.deepEqual(mobile, ['mmh-mobile', 'mmrp-mobile']);
  for (const name of PROJECTS) {
    const text = readFileSync(join(pack, 'projects', name, 'project.json'), 'utf8');
    assert.doesNotMatch(text, /metamask-mobile-farm|metamask-mobile-\d|-mm-\d/);
    assert.match(text, /"dev-server"[\s\S]*\{\{mobile_repo\}\}/);
  }
});

test('the wallet is applied only by its explicit operator action, never on acquire or reuse', () => {
  for (const name of PROJECTS) {
    const project = readProject(name);
    const { slot_actions: actions, ...rest } = project;
    assert.doesNotMatch(JSON.stringify(rest), /mobile-fixture|fixtures (init|set)/);
    const command = String(actions?.['mobile-wallet-fixture']?.command);
    assert.match(
      command,
      /mobile-fixture [a-z-]+ "\{\{repo\}\}" "\{\{mobile_repo\}\}" "\{\{slot_id\}\}" "\{\{port\}\}" "\{\{simulator\}\}"$/,
    );
  }
});

test('project commands use the support root every lifecycle path expands', () => {
  // Onboarding's bash lifecycle, resources and slot actions expand farmslot_dir;
  // gateway prepare remaps it to the node bundle. node_support_dir is not expanded there.
  for (const name of PROJECTS) {
    const text = readFileSync(join(pack, 'projects', name, 'project.json'), 'utf8');
    assert.doesNotMatch(text, /node_support_dir/i);
    assert.match(
      text,
      /\{\{farmslot_dir\}\}\/projects\/metamask-harness-farm\/scripts\/tooling\.sh/,
    );
  }
});

test('marking and runtimes use the published provider and a pinned library, not the slot checkout', () => {
  for (const name of PROJECTS) {
    const recipe = readProject(name).recipe;
    assert.deepEqual(recipe?.provider.root, { env: 'MM_HARNESS_PACKAGE_ROOT' });
    assert.equal(recipe?.provider.package, '@deeeed/metamask-harness');
    assert.match(recipe?.libraries?.[0]?.revision ?? '', /^[0-9a-f]{40}$/);
  }
});

test('the pack keeps one lifecycle implementation that the second project reuses', () => {
  const perps = join(pack, 'projects', PROJECTS[1]);
  assert.equal(existsSync(join(perps, 'scripts')), false);
  assert.match(
    readFileSync(join(perps, 'setup/ios.sh'), 'utf8'),
    /^shared=.*\/metamask-harness-farm\/setup\/ios\.sh"\n[\s\S]*^exec bash "\$shared" .* recipe-perps$/m,
  );
  const support = readProject(PROJECTS[1]).node_support?.paths ?? [];
  assert.ok(support.includes('projects/metamask-harness-farm/scripts'), support.join(', '));
  assert.ok(support.includes('projects/metamask-harness-farm/setup'), support.join(', '));
});

test('worker templates keep the generated TASK.md out and name the explicit candidate', () => {
  for (const name of PROJECTS) {
    for (const flow of ['dev', 'fix-bug', 'qa']) {
      const content = readFileSync(
        join(pack, 'projects', name, 'templates/worker', `${flow}.md`),
        'utf8',
      );
      assert.deepEqual(lintWorkerTemplateStructure(content), [], `${name} ${flow}`);
      assert.match(content, /\[DETERMINISTIC: ci\.local_check\]/);
      // MOBILE_REPO is blanked by a gateway-local existence check; the project var is not.
      assert.doesNotMatch(content, /\{\{MOBILE_REPO\}\}/);
      assert.match(content, /--target "\{\{OWNED_MOBILE_REPO\}\}"/);
      assert.match(content, /retained-library [a-z-]+ \{\{REPO\}\} \{\{TASK_DIR\}\}/);
      assert.match(content, /"\$PUBLISHED" run <recipe> --library perps="\$RETAINED"/);
      for (const run of content.match(/ run <recipe>[^`]*/g) ?? [])
        assert.match(run, /--library perps=/, `${name} ${flow}: ${run}`);
      assert.match(
        content,
        name === PROJECTS[0]
          ? /\{\{REPO\}\}\/bin\/mm-harness run <recipe> --library perps="\$RETAINED"/
          : /"\$PUBLISHED" run <recipe> --library perps=\{\{REPO\}\}/,
      );
    }
  }
});

test('every template passes dispatch admission for the project smoke and proof resource', () => {
  for (const name of PROJECTS) {
    const project = readProject(name);
    const smokes = (project.recipe?.checks ?? []).map((check) => check.recipe);
    for (const flow of ['dev', 'fix-bug', 'qa']) {
      const text = readFileSync(
        join(pack, 'projects', name, 'templates/worker', `${flow}.md`),
        'utf8',
      );
      // The same parse and requirement read that find-slot runs before claiming a slot.
      const required = recipeFlowRequirements(parseMarkdownDocument(text).frontmatter);
      assert.deepEqual(required.recipes, smokes, `${name} ${flow}`);
      assert.deepEqual(required.resources, ['mobile-proof'], `${name} ${flow}`);
      const proof = resolveRecipeProofRequirements({ required });
      assert.deepEqual(proof.missingRequirements, [], `${name} ${flow}`);
      assert.equal(proof.requirements[0]?.mode, 'visual', `${name} ${flow}`);
    }
  }
});

test('the proof capability is available on slots allocated by project add', (t) => {
  const root = scratch(t, 'mt-catalog-');
  const pool = generatePool({ machine: 'mini', os: 'darwin', sshUser: 'farm', runnerPaths: {} });
  const result = validatePackDir(pack, join(root, 'no-pool'));
  assert.deepEqual(result.errors, []);
  // The same allocation projectAdd performs for each declared slot.
  for (const entry of result.pack!.projects) {
    const short = projectShortName(entry);
    registerSlot(pool, {
      id: `mini-${short}-1`,
      project: projectName(entry),
      platform: entry.platform,
      repo: join(root, 'repos', `${short}-1`),
      session: `${short}-1`,
      branch: 'main',
      resources: {
        'dev-server': defaultDevServerResource(pool),
        ...defaultResources(entry.platform, short, 1, pool),
      },
    });
    mkdirSync(join(root, 'repos', `${short}-1`, '.git'), { recursive: true });
  }
  mkdirSync(join(root, 'pool'));
  writePool(join(root, 'pool', 'mini.json'), pool);
  cpSync(join(pack, 'projects'), join(root, 'projects'), { recursive: true });
  // The gateway's own catalog evaluator decides availability before dispatch.
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--experimental-test-module-mocks',
      '--conditions=development',
      fileURLToPath(new URL('./test/metamask-tooling-catalog.mts', import.meta.url)),
      ...pool.slots.map((slot) => slot.id),
    ],
    {
      // Resolve gateway workspace packages as the gateway itself does.
      cwd: fileURLToPath(new URL('../../../../services/gateway/', import.meta.url)),
      encoding: 'utf8',
      env: {
        ...process.env,
        FARMSLOT_POOL_DIR: join(root, 'pool'),
        FARMSLOT_PROJECTS_DIR: join(root, 'projects'),
        FARMSLOT_HOME: join(root, 'home'),
      },
      timeout: 60000,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const catalogs: Array<{
    slotId: string;
    capabilities: Array<{ id: string; availability: { state: string; reason?: string } }>;
  }> = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
  assert.deepEqual(
    catalogs.map((catalog) => [catalog.slotId, catalog.capabilities]),
    pool.slots.map((slot) => [
      slot.id,
      [{ id: 'mobile-proof', availability: { state: 'available' } }],
    ]),
  );
});

test('the owned Mobile target renders for a checkout that exists only on the execution node', () => {
  for (const name of PROJECTS) {
    const projectJson = readProject(name);
    const slotVars: SlotVars = {
      slotId: 'mini-x-1',
      machine: 'mini',
      platform: 'ios',
      host: 'mini.example',
      sshUser: 'farm',
      osType: 'darwin',
      claudePath: '',
      codexPath: '',
      opencodePath: '',
      cursorPath: '',
      grokPath: '',
      dispatchCmd: '',
      recycleCmd: '',
      // Absent on the machine running this test, as a remote node's checkout is to the gateway.
      repo: '/remote-only/farm/repos/x-1',
      session: 'x-1',
      slotMode: 'dispatch',
      slotEnabled: true,
      sshTarget: 'farm@mini.example',
      remoteRepo: '/remote-only/farm/repos/x-1',
      projectName: name,
      resourceVars: {},
    };
    const projectVars: ProjectVars = {
      projectName: name,
      projectConfig: join(pack, 'projects', name, 'project.json'),
      projectFixturesDir: '',
      projectTemplatesDir: '',
      projectJson,
      runtimeDir: 'temp/farmslot/runtime',
      artifactDir: 'temp/farmslot/tasks',
    };
    assert.equal(existsSync('/remote-only'), false);
    // The task writer renders project vars with this expansion and no existence check.
    const rendered = expandTemplate(
      String(projectJson.vars?.owned_mobile_repo),
      slotVars,
      projectVars,
    );
    // The reference-repo placeholder, which hooks also use, not the task writer's MOBILE_REPO.
    assert.equal(projectJson.vars?.owned_mobile_repo, '{{mobile_repo}}');
    const localName = projectJson.reference_repos?.mobile?.local_name;
    assert.equal(rendered, `/remote-only/farm/repos/${localName}`);
  }
});

test('the resolver refuses a harness root inside the slot checkout', (t) => {
  const root = scratch(t, 'mt-resolver-');
  const checkout = join(root, 'checkout');
  const harness = join(checkout, 'harness');
  mkdirSync(join(harness, 'bin'), { recursive: true });
  writeFileSync(
    join(harness, 'package.json'),
    JSON.stringify({ name: '@deeeed/metamask-harness', bin: { 'mm-harness': 'bin/mm-harness' } }),
  );
  writeFileSync(join(harness, 'bin/mm-harness'), '#!/bin/sh\n', { mode: 0o755 });
  const resolver = join(pack, 'projects', PROJECTS[0], 'scripts/resolve-harness.mjs');
  const run = (env: string, target: string) =>
    spawnSync(process.execPath, [resolver, '--published', target], {
      encoding: 'utf8',
      env: { ...process.env, MM_HARNESS_PACKAGE_ROOT: env },
      timeout: 4000,
    });
  const inside = run(harness, checkout);
  assert.equal(inside.status, 1);
  assert.match(inside.stderr, /not the slot checkout/);
  mkdirSync(join(root, 'other'));
  const published = run(harness, join(root, 'other'));
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.stdout, /bin\/mm-harness$/);
});

test('lifecycle commands refuse a missing, unexpanded or self-referencing Mobile checkout', (t) => {
  const root = scratch(t, 'mt-mobile-');
  const repo = join(root, 'mmh-1');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // A stand-in for the configured Node 22 directory; the router checks the major version.
  symlinkSync(process.execPath, join(bin, 'node'));
  const env = { FARMSLOT_NODE22_BIN: bin };
  const major = process.versions.node.split('.')[0];
  const boot = (mobile: string) =>
    tooling(['mobile-boot', 'harness', repo, mobile, '9400', 'mmh-1', 'slot', root], env);
  if (major !== '22') {
    assert.match(boot(join(root, 'mmh-mobile')).stderr, /Node 22 is required/);
    t.skip('the remaining refusals need Node 22');
    return;
  }
  assert.match(boot('').stderr, /no owned Mobile checkout/);
  assert.match(boot('{{mobile_repo}}').stderr, /no owned Mobile checkout/);
  assert.match(boot(join(root, 'mmh-mobile')).stderr, /owned Mobile checkout is missing/);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'metamask' }));
  assert.match(boot(repo).stderr, /must not be the tooling checkout/);
  mkdirSync(join(root, 'other'));
  writeFileSync(join(root, 'other/package.json'), JSON.stringify({ name: 'not-metamask' }));
  assert.match(boot(join(root, 'other')).stderr, /is not a MetaMask Mobile checkout/);
});

test('Mobile dependency setup installs locked dependencies before setup:expo on a fresh checkout', (t) => {
  const root = scratch(t, 'mt-mobile-deps-');
  const repo = join(root, 'mmh-1');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const mobile = join(root, 'mmh-mobile');
  mkdirSync(mobile);
  writeFileSync(join(mobile, 'package.json'), JSON.stringify({ name: 'metamask' }));
  // A stand-in for the configured Mobile Node: Yarn refuses `run` without install
  // state, exactly as it does on a fresh clone, and an install creates that state.
  const bin = join(root, 'mobile-node');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  const calls = join(root, 'calls.log');
  writeFileSync(
    join(bin, 'corepack'),
    `#!/bin/sh
echo "$*" >> "${calls}"
case "$*" in
  "yarn install --immutable") mkdir -p node_modules && : > node_modules/.yarn-state.yml ;;
  "yarn setup:expo") [ -f node_modules/.yarn-state.yml ] || { echo "Couldn't find the node_modules state file" >&2; exit 1; } ;;
  *) exit 3 ;;
esac
`,
    { mode: 0o755 },
  );
  const deps = () =>
    tooling(['mobile-deps', 'harness', repo, mobile, 'mini-mmh-1'], { MOBILE_NODE_BIN: bin });
  const fresh = deps();
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [
    'yarn install --immutable',
    'yarn setup:expo',
  ]);
  // An existing install is reused; setup runs again without a second install.
  rmSync(calls);
  const prepared = deps();
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), ['yarn setup:expo']);
});

test('a second slot of the same project cannot claim or stop another slot Mobile checkout', (t) => {
  if (!NODE22) {
    t.skip('needs Node 22');
    return;
  }
  const root = scratch(t, 'mt-owner-');
  const repo = join(root, 'mmh-2');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const mobile = join(root, 'mmh-mobile');
  mkdirSync(join(mobile, 'temp/recipe/runtime'), { recursive: true });
  writeFileSync(join(mobile, 'package.json'), JSON.stringify({ name: 'metamask' }));
  writeFileSync(
    join(mobile, 'temp/recipe/runtime/farmslot-owner'),
    'metamask-harness-farm/mini-mmh-1\n',
  );
  // The private wallet input lives in the owned checkout, never in pack sources.
  mkdirSync(join(mobile, 'temp/recipe/private'), { recursive: true });
  writeFileSync(join(mobile, 'temp/recipe/private/wallet-fixture.json'), '{}');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  // A published harness outside the slot checkout; refusals happen before it runs.
  const harness = join(root, 'published');
  mkdirSync(join(harness, 'bin'), { recursive: true });
  writeFileSync(
    join(harness, 'package.json'),
    JSON.stringify({ name: '@deeeed/metamask-harness', bin: { 'mm-harness': 'bin/mm-harness' } }),
  );
  // Records every published-harness call; doctor's liveness gate follows LIVE.
  const calls = join(root, 'harness-calls.log');
  writeFileSync(
    join(harness, 'bin/mm-harness'),
    `#!/bin/sh\necho "$*" >> "${calls}"\necho ran "$@"\n[ "$1" != doctor ] || [ "$LIVE" = 1 ]\n`,
    { mode: 0o755 },
  );
  const env = { FARMSLOT_NODE22_BIN: bin, MM_HARNESS_PACKAGE_ROOT: harness };
  const harnessCalls = () =>
    existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
  const applyWallet = (slot: string, live: boolean) =>
    tooling(['mobile-fixture', 'harness', repo, mobile, slot, '9400', 'sim-1'], {
      ...env,
      LIVE: live ? '1' : '0',
    });
  const fixtureRun = applyWallet('mini-mmh-2', true);
  assert.equal(fixtureRun.status, 1);
  assert.match(fixtureRun.stderr, /owned by metamask-harness-farm\/mini-mmh-1/);
  assert.deepEqual(harnessCalls(), []);
  // Dependency setup would run Yarn in the owner's checkout; it refuses before Yarn.
  const deps = tooling(['mobile-deps', 'harness', repo, mobile, 'mini-mmh-2'], {
    ...env,
    MOBILE_NODE_BIN: bin,
  });
  assert.equal(deps.status, 1);
  assert.match(deps.stderr, /owned by metamask-harness-farm\/mini-mmh-1/);
  assert.equal(existsSync(join(mobile, 'node_modules')), false);
  // The owner's app is not running: refuse after the liveness check, before any write.
  const notLive = applyWallet('mini-mmh-1', false);
  assert.equal(notLive.status, 1);
  assert.match(notLive.stderr, /boot this slot's dev-server resource/);
  const wallet = `${realpathSync(mobile)}/temp/recipe/private/wallet-fixture.json`;
  const target = `--adapter mobile --target ${realpathSync(mobile)}`;
  const doctor = `doctor ${target} --watcher-port 9400 --runtime-dir temp/recipe/runtime --device sim-1 --expect-live`;
  assert.deepEqual(harnessCalls(), [doctor]);
  // Live: stage the private input, then apply it to the running app, in that order.
  rmSync(calls);
  const applied = applyWallet('mini-mmh-1', true);
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(harnessCalls(), [
    doctor,
    `fixtures init --from ${wallet} --force ${target} --json`,
    `fixtures set ${target} --device sim-1 --json`,
  ]);
  rmSync(calls);
  const stop = tooling(['mobile-stop', 'harness', repo, mobile, '9400', 'sim', 'mini-mmh-2'], env);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /nothing to stop/);
  assert.doesNotMatch(stop.stdout, /^ran /m);
  const owner = tooling(['mobile-stop', 'harness', repo, mobile, '9400', 'sim', 'mini-mmh-1'], env);
  assert.equal(owner.status, 0, owner.stderr);
  assert.match(owner.stdout, /^ran stop --adapter mobile --port 9400/m);
});

test('the baseline library is the retained copy from a receipt the installed CLI verified', (t) => {
  const root = scratch(t, 'mt-retained-');
  const repo = join(root, 'mmrp-1');
  const task = join(repo, 'temp/farmslot/tasks/qa/T-1');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(task, { recursive: true });
  const receipt = {
    bindingIdentity: {
      libraries: [
        { name: 'perps', path: '/pins/abc/inputs/37/experimental-metamask-recipe-perps' },
        { name: 'metamask', path: '/published/library' },
      ],
    },
  };
  const cli = (name: string, body: string) => {
    const file = join(root, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const verified = cli(
    'farmslot-ok',
    `[ "$1 $2 $3 $4" = "task verify ${task} --json" ] || exit 9\ncat <<'JSON'\n${JSON.stringify(receipt)}\nJSON`,
  );
  const ok = tooling(['retained-library', 'recipe-perps', repo, task], { FARMSLOT_CLI: verified });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '/pins/abc/inputs/37/experimental-metamask-recipe-perps\n');
  // A task whose tooling no longer verifies yields no library, never a fallback.
  const refused = cli('farmslot-refuse', 'echo "retained input changed" >&2; exit 1');
  const bad = tooling(['retained-library', 'recipe-perps', repo, task], { FARMSLOT_CLI: refused });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /did not verify/);
});

test('teardown without an owned Mobile checkout stops nothing and succeeds', (t) => {
  const root = scratch(t, 'mt-teardown-');
  const repo = join(root, 'mmrp-1');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const result = tooling([
    'mobile-stop',
    'recipe-perps',
    repo,
    join(root, 'mmrp-mobile'),
    '9400',
    'mmrp-1',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no owned Mobile checkout to stop/);
});

test('the candidate selection names the slot checkout explicitly for each project', (t) => {
  const root = scratch(t, 'mt-candidate-');
  const repo = join(root, 'tool');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'bin'));
  writeFileSync(join(repo, 'bin/mm-harness'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(repo, 'recipe-library.json'), '{}');
  const real = spawnSync('pwd', ['-P'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  assert.equal(
    tooling(['candidate', 'harness', repo]).stdout,
    `MM_HARNESS_CANDIDATE=${real}/bin/mm-harness\n`,
  );
  assert.equal(
    tooling(['candidate', 'recipe-perps', repo]).stdout,
    `RECIPE_LIBRARY_CANDIDATE=perps=${real}\n`,
  );
});

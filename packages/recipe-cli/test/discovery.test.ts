import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { RecipeActionManifestDocument } from '@farmslot/protocol';
import { loadRecipeLibraries } from '@farmslot/recipe-runner';

import { runRecipeCli } from '../src/cli.js';
import { buildDiscoveryIndex, findRecipe, shadowedRecipes } from '../src/discovery-index.js';
import { assessRecipe, RECIPE_CLI_VERSION } from '../src/index.js';
import type {
  ActionsEnvelope,
  DescribeEnvelope,
  DiscoveryErrorEnvelope,
  ExplainEnvelope,
  ListEnvelope,
  SearchEnvelope,
  TemplateEnvelope,
} from '../src/types.js';

const HELLO = fileURLToPath(new URL('../../../examples/recipe-library-hello', import.meta.url));
const SCHEMA = 'https://farmslot.io/schemas/recipe-v1.schema.json';

const recipe = (
  title: string,
  nodes: Record<string, Record<string, unknown>>,
  paramsSchema?: Record<string, unknown>,
) => ({
  $schema: SCHEMA,
  title,
  description: `${title}.`,
  ...(paramsSchema ? { paramsSchema } : {}),
  workflow: {
    entry: Object.keys(nodes)[0],
    nodes: {
      ...Object.fromEntries(
        Object.entries(nodes).map(([id, node]) => [id, { intent: `Run ${id}`, ...node }]),
      ),
      done: { action: 'end', status: 'pass' },
    },
  },
});

const commandManifest = (extra: Record<string, unknown> = {}) => ({
  $schema: 'https://farmslot.io/schemas/action-manifest-v1.schema.json',
  actions: {
    command: {
      description: 'Run a command.',
      schema: {
        type: 'object',
        properties: { cmd: { type: 'string' } },
        required: ['cmd'],
        additionalProperties: false,
      },
      examples: [{ action: 'command', intent: 'Run true.', cmd: 'true', next: 'done' }],
    },
    ...extra,
  },
});

const customAction = (description: string) => ({
  description,
  execution_capabilities: ['app-mutation'],
  schema: {
    type: 'object',
    properties: { target: { type: 'string' } },
    required: ['target'],
    additionalProperties: false,
  },
  result_cases: ['done'],
  examples: [{ action: 'team.open', intent: 'Open home.', target: 'home', next: 'done' }],
});

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Two libraries: `team` (higher precedence) and `base`, sharing one ref and one action. */
async function fixture(
  t: TestContext,
): Promise<{ team: string; base: string; env: Record<string, string> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const team = path.join(root, 'team');
  const base = path.join(root, 'base');
  await writeJson(path.join(team, 'recipe-library.json'), { platforms: ['web'] });
  await writeJson(path.join(team, 'manifests', 'shared.action-manifest.json'), commandManifest());
  await writeJson(
    path.join(team, 'manifests', 'web.action-manifest.json'),
    commandManifest({ 'team.open': customAction('Open a page.') }),
  );
  await writeJson(
    path.join(team, 'recipes', 'shop', 'smoke.recipe.json'),
    recipe(
      'Team smoke',
      {
        setup: {
          action: 'call',
          ref: 'shop.setup',
          params: { who: '{{params.user}}' },
          next: 'run',
        },
        run: { action: 'command', cmd: 'true', next: 'done' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: { user: { type: 'string', description: 'User to sign in.' } },
        required: ['user'],
      },
    ),
  );
  await writeJson(
    path.join(team, 'recipes', 'web', 'shop', 'open.recipe.json'),
    recipe('Web open', { open: { action: 'team.open', target: 'home', next: 'done' } }),
  );
  await writeJson(
    path.join(team, 'recipes', 'shop', 'broken.recipe.json'),
    recipe('Broken', { gone: { action: 'call', ref: 'shop.missing', next: 'done' } }),
  );
  await writeJson(path.join(base, 'manifests', 'shared.action-manifest.json'), commandManifest());
  await writeJson(
    path.join(base, 'recipes', 'shop', 'smoke.recipe.json'),
    recipe('Base smoke', { run: { action: 'command', cmd: 'true', next: 'done' } }),
  );
  await writeJson(
    path.join(base, 'recipes', 'shop', 'setup.recipe.json'),
    recipe(
      'Setup',
      { login: { action: 'command', cmd: 'echo {{params.who}}', next: 'done' } },
      {
        type: 'object',
        additionalProperties: false,
        properties: { who: { type: 'string' }, region: { type: 'string', default: 'eu' } },
        required: ['who'],
      },
    ),
  );
  return { team, base, env: { RECIPE_LIBRARY_PATH: `team=${team}:base=${base}` } };
}

async function cli<T>(
  argv: string[],
  env: Record<string, string>,
): Promise<{ json: T; exitCode: number }> {
  const lines: string[] = [];
  const log = console.log;
  const previousEnv = process.env.RECIPE_LIBRARY_PATH;
  const previousExit = process.exitCode;
  console.log = (line: unknown) => void lines.push(String(line));
  process.env.RECIPE_LIBRARY_PATH = env.RECIPE_LIBRARY_PATH;
  process.exitCode = 0;
  try {
    await runRecipeCli([...argv, '--json']);
    return { json: JSON.parse(lines.join('\n')) as T, exitCode: Number(process.exitCode ?? 0) };
  } finally {
    console.log = log;
    process.env.RECIPE_LIBRARY_PATH = previousEnv;
    process.exitCode = previousExit;
  }
}

test('list resolves precedence, shadows, ids, variants and runnable state', async (t) => {
  const { env, team } = await fixture(t);
  const { json } = await cli<ListEnvelope>(['list'], env);
  assert.equal(json.schemaVersion, 1);
  assert.deepEqual(
    json.libraries.map((library) => [library.rank, library.name, library.origin]),
    [
      [1, 'team', 'env'],
      [2, 'base', 'env'],
    ],
  );
  assert.match(json.libraries[0]!.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(json.libraries[0]!.platforms, ['web']);
  const byRef = new Map(json.recipes.map((entry) => [entry.ref, entry]));
  const smoke = byRef.get('shop.smoke')!;
  assert.equal(smoke.source, 'team');
  assert.equal(smoke.id, 'team.shop.smoke');
  assert.deepEqual(smoke.shadows, ['base']);
  assert.equal(smoke.runnable, true);
  assert.equal(byRef.get('shop.open')?.runnable, null);
  assert.deepEqual(byRef.get('shop.open')?.variants, [
    { platform: 'web', source: 'team', file: 'recipes/web/shop/open.recipe.json' },
  ]);
  assert.equal(byRef.get('shop.broken')?.runnable, false);
  assert.deepEqual(
    byRef.get('shop.broken')?.problems.map((problem) => problem.code),
    ['workflow.unresolved_call_ref', 'RECIPE_REFERENCE_NOT_FOUND'],
  );

  const web = await cli<ListEnvelope>(['list', '--platform', 'web', '--runnable'], env);
  assert.deepEqual(
    web.json.recipes.map((entry) => entry.ref),
    ['shop.open', 'shop.setup', 'shop.smoke'],
  );

  const override = await cli<ListEnvelope>(['list', '--library', `base=${team}`], env);
  assert.deepEqual(
    override.json.libraries.map((library) => [
      library.name,
      library.origin,
      library.overrides ?? null,
    ]),
    [
      ['base', 'flag', path.join(path.dirname(team), 'base')],
      ['team', 'env', null],
    ],
  );
});

test('actions merge manifests by precedence and report handlers', async (t) => {
  const { env } = await fixture(t);
  const all = await cli<ActionsEnvelope>(['actions'], env);
  const byName = new Map(all.json.actions.map((action) => [action.name, action]));
  assert.deepEqual(byName.get('command'), {
    ...byName.get('command'),
    source: 'team',
    shadows: ['base'],
    handler: 'builtin',
    declared: true,
    platforms: ['shared', 'web'],
    capabilities: ['host-exec'],
  });
  assert.equal(byName.get('team.open')?.handler, 'adapter');
  assert.deepEqual(byName.get('team.open')?.parameters, [
    { name: 'target', type: 'string', required: true },
  ]);
  assert.equal(byName.get('call')?.handler, 'runner');
  assert.equal(byName.get('wait')?.declared, false);

  const shared = await cli<ActionsEnvelope>(
    ['actions', '--source', 'team', '--platform', 'web'],
    env,
  );
  assert.deepEqual(
    shared.json.actions.map((action) => action.name),
    ['command', 'team.open'],
  );
});

test('describe reports parameters, composition, callers and namespaced ids', async (t) => {
  const { env } = await fixture(t);
  const { json } = await cli<DescribeEnvelope>(['describe', 'shop.smoke'], env);
  assert.equal(json.kind, 'recipe');
  assert.equal(json.recipe?.resolvedBy, 'ref');
  assert.deepEqual(json.recipe?.parameters, [
    { name: 'user', type: 'string', required: true, description: 'User to sign in.' },
  ]);
  assert.deepEqual(json.recipe?.actions, ['command', 'end']);
  assert.deepEqual(json.recipe?.nestedRecipes, ['shop.setup']);
  assert.match(json.recipe?.runCommand ?? '', /run shop\.smoke user='<user>'/u);

  const shadowed = await cli<DescribeEnvelope>(['describe', 'base.shop.smoke'], env);
  assert.equal(shadowed.json.recipe?.source, 'base');
  assert.equal(shadowed.json.recipe?.title, 'Base smoke');
  assert.equal(shadowed.json.recipe?.resolvedBy, 'id');

  const setup = await cli<DescribeEnvelope>(['describe', 'shop.setup'], env);
  assert.deepEqual(setup.json.recipe?.callers, ['shop.smoke']);

  const action = await cli<DescribeEnvelope>(['describe', 'team.open', '--platform', 'web'], env);
  assert.equal(action.json.kind, 'action');
  assert.deepEqual(action.json.action?.callers, ['shop.open']);
  assert.deepEqual(action.json.action?.resultCases, ['done']);

  const missing = await cli<DiscoveryErrorEnvelope>(['describe', 'shop.smok'], env);
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.json.error.code, 'DISCOVERY_NOT_FOUND');
  assert.match(missing.json.error.userAction, /shop\.smoke/u);

  const variantOnly = await cli<DiscoveryErrorEnvelope>(['explain', 'shop.open'], env);
  assert.equal(variantOnly.json.error.code, 'RECIPE_PLATFORM_REQUIRED');
});

test('explain resolves parameter flow, required actions and missing pieces', async (t) => {
  const { env } = await fixture(t);
  const { json } = await cli<ExplainEnvelope>(
    ['explain', 'shop.smoke', '--param', 'user=ada'],
    env,
  );
  assert.deepEqual(json.recipe.parameters, [{ name: 'user', value: 'ada', from: 'input' }]);
  const call = json.recipe.nodes.find((node) => node.kind === 'call');
  assert.equal(call?.kind === 'call' && call.recipe?.source, 'base');
  assert.deepEqual(call?.kind === 'call' && call.recipe?.parameters, [
    { name: 'who', value: 'ada', from: 'input', template: '{{params.user}}' },
    { name: 'region', value: 'eu', from: 'default' },
  ]);
  assert.deepEqual(
    json.requiredActions.map((action) => [action.name, action.declared, action.handler]),
    [
      ['command', true, 'builtin'],
      ['end', true, 'runner'],
    ],
  );
  assert.deepEqual(json.capabilities, ['host-exec']);
  assert.deepEqual(json.missing.parameters, []);
  assert.deepEqual(json.resolution?.edges, [{ from: 'shop.smoke', to: 'shop.setup' }]);

  const bare = await cli<ExplainEnvelope>(['explain', 'shop.smoke'], env);
  assert.deepEqual(bare.json.missing.parameters, [{ recipe: 'shop.smoke', name: 'user' }]);

  const broken = await cli<ExplainEnvelope>(['explain', 'shop.broken'], env);
  assert.deepEqual(broken.json.missing.recipes, [
    { from: 'shop.broken#gone', ref: 'shop.missing' },
  ]);
  assert.equal(broken.json.resolution, null);

  const web = await cli<ExplainEnvelope>(['explain', 'shop.open', '--platform', 'web'], env);
  assert.deepEqual(web.json.missing.handlers, ['team.open']);
  assert.deepEqual(web.json.capabilities, ['app-mutation']);
});

test('search, template and completions read the same index', async (t) => {
  const { env } = await fixture(t);
  const search = await cli<SearchEnvelope>(['search', 'setup'], env);
  assert.equal(search.json.results[0]?.name, 'shop.setup');

  const action = await cli<TemplateEnvelope>(['template', 'team.open', '--platform', 'web'], env);
  assert.deepEqual(action.json.node, {
    action: 'team.open',
    intent: 'Open home.',
    target: 'home',
    next: 'done',
  });
  const call = await cli<TemplateEnvelope>(['template', 'shop.setup'], env);
  assert.deepEqual(call.json.node.params, { who: '<who>' });

  const recipes = await cli<{ candidates: string[] }>(
    ['completions', '--candidates', 'recipes'],
    env,
  );
  assert.deepEqual(recipes.json.candidates, [
    'base.shop.setup',
    'base.shop.smoke',
    'shop.broken',
    'shop.open',
    'shop.setup',
    'shop.smoke',
    'team.shop.broken',
    'team.shop.open',
    'team.shop.smoke',
  ]);
  const commands = await cli<{ candidates: string[] }>(
    ['completions', '--candidates', 'commands'],
    env,
  );
  assert.ok(commands.json.candidates.includes('explain'));
  assert.ok(commands.json.candidates.includes('run'));
});

test('an unsatisfied requires range and an invalid action manifest fail closed', async (t) => {
  const { env, team } = await fixture(t);
  await writeJson(path.join(team, 'recipe-library.json'), {
    platforms: ['web'],
    requires: { '@farmslot/recipe-cli': '>=99.0.0' },
  });
  const requires = await cli<DiscoveryErrorEnvelope>(['list'], env);
  assert.equal(requires.exitCode, 1);
  assert.equal(requires.json.error.code, 'RECIPE_LIBRARY_REQUIREMENT_UNSATISFIED');

  // A package this CLI cannot check fails closed too, in discovery and in run.
  await writeJson(path.join(team, 'recipe-library.json'), {
    requires: { '@farmslot/adapter-sdk': '>=9' },
  });
  const unchecked = await cli<DiscoveryErrorEnvelope>(['describe', 'shop.smoke'], env);
  assert.equal(unchecked.exitCode, 1);
  assert.equal(unchecked.json.error.code, 'RECIPE_LIBRARY_REQUIREMENT_UNSATISFIED');
  const run = await cli<{ code: string }>(['run', 'shop.smoke', '--describe'], env);
  assert.equal(run.exitCode, 1);
  assert.equal(run.json.code, 'RECIPE_LIBRARY_REQUIREMENT_UNSATISFIED');

  await writeJson(path.join(team, 'recipe-library.json'), { platforms: ['web'] });
  await writeJson(path.join(team, 'manifests', 'shared.action-manifest.json'), {
    actions: { x: {} },
  });
  const manifest = await cli<DiscoveryErrorEnvelope>(['actions'], env);
  assert.equal(manifest.exitCode, 1);
  assert.equal(manifest.json.error.code, 'ACTION_MANIFEST_INVALID');
});

test('the hello example library lists, describes and explains without an adapter', async () => {
  const env = { RECIPE_LIBRARY_PATH: `hello=${HELLO}` };
  const list = await cli<ListEnvelope>(['list'], env);
  assert.deepEqual(
    list.json.recipes.map((entry) => [entry.ref, entry.runnable]),
    [
      ['greet', true],
      ['greet-twice', true],
    ],
  );
  const explain = await cli<ExplainEnvelope>(
    ['explain', 'greet-twice', '--param', 'guest=Ada'],
    env,
  );
  assert.deepEqual(explain.json.missing.actions, []);
  assert.deepEqual(explain.json.missing.handlers, []);
  const web = await cli<ExplainEnvelope>(['explain', 'greet', '--platform', 'web'], env);
  assert.deepEqual(web.json.missing.handlers, ['hello.wave']);
  const index = await buildDiscoveryIndex({ env });
  assert.deepEqual(
    index.libraries[0]?.info.requires.map((entry) => entry.package),
    ['@farmslot/recipe-runner'],
  );
});

test('the hello example runs through the same bin once its plan is approved', async (t) => {
  const artifacts = await mkdtemp(path.join(os.tmpdir(), 'recipe-hello-run-'));
  t.after(() => rm(artifacts, { recursive: true, force: true }));
  const run = async (extra: string[]): Promise<string[]> => {
    const lines: string[] = [];
    const log = console.log;
    const previousEnv = process.env.RECIPE_LIBRARY_PATH;
    console.log = (line: unknown) => void lines.push(String(line));
    process.env.RECIPE_LIBRARY_PATH = `hello=${HELLO}`;
    try {
      await runRecipeCli([
        'run',
        'greet-twice',
        'guest=Ada',
        '--action-manifest',
        path.join(HELLO, 'manifests', 'shared.action-manifest.json'),
        '--artifacts-dir',
        artifacts,
        ...extra,
      ]);
    } finally {
      console.log = log;
      process.env.RECIPE_LIBRARY_PATH = previousEnv;
    }
    return lines;
  };
  const previousExit = process.exitCode;
  t.after(() => {
    process.exitCode = previousExit;
  });
  // Library recipes have unknown trust, so host-exec waits for an approved plan digest.
  const refusal = JSON.parse((await run(['--json'])).find((line) => line.startsWith('{'))!) as {
    code: string;
    recipeDigest: string;
  };
  assert.equal(refusal.code, 'RECIPE_TRUST_REQUIRED');
  process.exitCode = 0;
  await run(['--approve-plan', refusal.recipeDigest]);
  assert.equal(process.exitCode ?? 0, 0);
  const summary = JSON.parse(await readFile(path.join(artifacts, 'summary.json'), 'utf8')) as {
    status: string;
    recipeLibraries?: { sources: Array<{ name: string; provenance: { digest?: string } }> };
  };
  assert.equal(summary.status, 'pass');
  const index = await buildDiscoveryIndex({ env: { RECIPE_LIBRARY_PATH: `hello=${HELLO}` } });
  assert.equal(
    summary.recipeLibraries?.sources[0]?.provenance.digest,
    index.libraries[0]?.info.digest,
  );
});

/** Two copies of the hello library: `a` shadows `hello`'s generic greet with its own title. */
async function shadowedHello(
  t: TestContext,
): Promise<{ root: string; env: Record<string, string> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-discovery-ids-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(HELLO, path.join(root, 'hello'), { recursive: true });
  await cp(HELLO, path.join(root, 'a'), { recursive: true });
  const greet = path.join(root, 'a', 'recipes', 'greet.recipe.json');
  await writeJson(greet, { ...JSON.parse(await readFile(greet, 'utf8')), title: 'A greet' });
  return {
    root,
    env: { RECIPE_LIBRARY_PATH: `a=${path.join(root, 'a')}:hello=${path.join(root, 'hello')}` },
  };
}

test('namespaced ids and platform aliases resolve the same way in run and discovery', async (t) => {
  const { env } = await shadowedHello(t);
  const described = await cli<DescribeEnvelope>(['describe', 'hello.greet'], env);
  assert.equal(described.json.recipe?.resolvedBy, 'id');
  assert.equal(described.json.recipe?.title, 'Greet someone');
  assert.match(described.json.recipe?.runCommand ?? '', /run hello\.greet /u);

  // The generated command resolves to the described recipe, not the shadow winner.
  const run = await cli<{ source: string; title: string }>(
    ['run', 'hello.greet', '--describe'],
    env,
  );
  assert.equal(run.exitCode, 0);
  assert.deepEqual([run.json.source, run.json.title], ['hello', 'Greet someone']);

  const template = await cli<DiscoveryErrorEnvelope>(['template', 'hello.greet'], env);
  assert.equal(template.exitCode, 2);
  assert.equal(template.json.error.code, 'RECIPE_SHADOWED');

  const alias = await cli<DescribeEnvelope>(['describe', 'web.greet', '--platform', 'web'], env);
  assert.equal(alias.json.recipe?.resolvedBy, 'alias');
  assert.equal(alias.json.recipe?.file, 'recipes/web/greet.recipe.json');
  const aliasRun = await cli<{ file: string }>(
    ['run', 'web.greet', '--describe', '--adapter', 'web'],
    env,
  );
  assert.equal(aliasRun.json.file, 'recipes/web/greet.recipe.json');

  const flagged = await cli<DescribeEnvelope>(
    ['describe', 'greet', '--library', `extra=${HELLO}`],
    env,
  );
  assert.match(flagged.json.recipe?.runCommand ?? '', new RegExp(`--library extra=${HELLO}`, 'u'));

  const search = await cli<SearchEnvelope>(['search', 'greet'], env);
  assert.ok(search.json.results.some((result) => result.id === 'a.greet'));
  const candidates = await cli<{ candidates: string[] }>(
    ['completions', '--candidates', 'recipes'],
    env,
  );
  assert.ok(candidates.json.candidates.includes('hello.greet'));
  assert.ok(candidates.json.candidates.includes('a.greet'));
});

test('an alias dependency is judged by the document it resolves to', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-discovery-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const high = path.join(root, 'high');
  const low = path.join(root, 'low');
  await writeJson(path.join(high, 'manifests', 'shared.action-manifest.json'), commandManifest());
  await writeJson(
    path.join(high, 'recipes', 'foo.recipe.json'),
    recipe('Foo', { run: { action: 'command', cmd: 'true', next: 'done' } }),
  );
  await writeJson(
    path.join(high, 'recipes', 'parent.recipe.json'),
    recipe('Parent', { call: { action: 'call', ref: 'web.foo', next: 'done' } }),
  );
  await writeJson(path.join(low, 'recipe-library.json'), { platforms: ['web'] });
  await writeJson(
    path.join(low, 'recipes', 'web', 'foo.recipe.json'),
    recipe('Low web foo', { bad: { action: 'low.bad', next: 'done' } }),
  );
  const env = { RECIPE_LIBRARY_PATH: `high=${high}:low=${low}` };
  const { json } = await cli<ListEnvelope>(['list', '--platform', 'web'], env);
  const byRef = new Map(json.recipes.map((entry) => [entry.ref, entry]));
  assert.equal(byRef.get('foo')?.runnable, true);
  assert.equal(byRef.get('parent')?.runnable, false);
  assert.deepEqual(
    byRef.get('parent')?.problems.map((problem) => problem.code),
    ['RECIPE_DEPENDENCY_NOT_RUNNABLE'],
  );
});

test('library files must be contained regular files, walked the same way for load and digest', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-discovery-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = path.join(root, 'lib');
  await cp(HELLO, library, { recursive: true });
  const env = { RECIPE_LIBRARY_PATH: `lib=${library}` };
  const before = await cli<ListEnvelope>(['list'], env);

  // Dotfiles and node_modules are skipped by both the loader and the digest.
  const greet = await readFile(path.join(library, 'recipes', 'greet.recipe.json'), 'utf8');
  await writeFile(path.join(library, 'recipes', '.sneaky.recipe.json'), greet);
  await mkdir(path.join(library, 'recipes', 'node_modules'));
  await writeFile(path.join(library, 'recipes', 'node_modules', 'nm.recipe.json'), greet);
  // A symlinked directory is not followed, so it neither crashes nor adds recipes.
  await symlink('../manifests', path.join(library, 'recipes', 'linkdir'));
  const after = await cli<ListEnvelope>(['list'], env);
  assert.equal(after.json.status, 'ok');
  assert.equal(after.json.libraries[0]?.digest, before.json.libraries[0]?.digest);
  assert.deepEqual(
    after.json.recipes.map((entry) => entry.ref),
    ['greet', 'greet-twice'],
  );
  const run = await cli<{ ref: string }>(['run', 'greet', '--describe'], env);
  assert.equal(run.exitCode, 0);

  // A convention manifest that escapes the library is rejected, not read or digested.
  await writeJson(path.join(root, 'outside.action-manifest.json'), commandManifest());
  await symlink(
    '../../outside.action-manifest.json',
    path.join(library, 'manifests', 'evil.action-manifest.json'),
  );
  const escaped = await cli<DiscoveryErrorEnvelope>(['actions'], env);
  assert.equal(escaped.exitCode, 1);
  assert.equal(escaped.json.error.code, 'RECIPE_SOURCE_INVALID');
});

test('every failure prints the JSON envelope with the documented exit code', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-discovery-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [index, content] of [
    '{"platforms":"web"}',
    '{"actions":{"shared":"missing.json"}}',
    '[]',
    'not json',
  ].entries()) {
    const library = path.join(root, `bad-${index}`);
    await cp(HELLO, library, { recursive: true });
    await writeFile(path.join(library, 'recipe-library.json'), content);
    const result = await cli<DiscoveryErrorEnvelope>(['list'], {
      RECIPE_LIBRARY_PATH: `bad=${library}`,
    });
    assert.equal(result.exitCode, 1, content);
    assert.equal(result.json.error.code, 'RECIPE_LIBRARY_MANIFEST_INVALID', content);
  }

  const env = { RECIPE_LIBRARY_PATH: `hello=${HELLO}` };
  const missingArgument = await cli<DiscoveryErrorEnvelope>(['describe'], env);
  assert.deepEqual(
    [missingArgument.exitCode, missingArgument.json.command, missingArgument.json.error.code],
    [2, 'describe', 'DISCOVERY_USAGE'],
  );
  const unknownOption = await cli<DiscoveryErrorEnvelope>(['list', '--bogus'], env);
  assert.deepEqual([unknownOption.exitCode, unknownOption.json.error.code], [2, 'DISCOVERY_USAGE']);
  const badParam = await cli<DiscoveryErrorEnvelope>(
    ['explain', 'greet', '--param', 'noequals'],
    env,
  );
  assert.deepEqual([badParam.exitCode, badParam.json.error.code], [2, 'DISCOVERY_USAGE']);
  const script = await cli<{ kind: string; shell: string; script: string }>(
    ['completions', 'bash'],
    env,
  );
  assert.equal(script.json.kind, 'script');
  assert.match(script.json.script, /complete -F/u);
  const platformRequired = await cli<DiscoveryErrorEnvelope>(['describe', 'shop.none'], env);
  assert.equal(platformRequired.json.error.code, 'DISCOVERY_NOT_FOUND');
});

test('explain validates parameters the way run does', async () => {
  const env = { RECIPE_LIBRARY_PATH: `hello=${HELLO}` };
  const { json } = await cli<ExplainEnvelope>(
    ['explain', 'greet-twice', '--param', 'guest=42', '--param', 'extra=1'],
    env,
  );
  assert.deepEqual(
    json.missing.problems.map((problem) => [problem.code, problem.path]),
    [
      ['RECIPE_PARAMS_INVALID', 'params.guest'],
      ['RECIPE_PARAMS_INVALID', 'params.extra'],
      ['RECIPE_PARAMS_INVALID', 'params.name'],
    ],
  );
  const clean = await cli<ExplainEnvelope>(['explain', 'greet-twice', '--param', 'guest=Ada'], env);
  assert.deepEqual(clean.json.missing.problems, []);
});

test('RECIPE_PLATFORM_REQUIRED suggests the command that was run', async (t) => {
  const { env } = await fixture(t);
  for (const command of ['describe', 'template', 'explain']) {
    const result = await cli<DiscoveryErrorEnvelope>([command, 'shop.open'], env);
    assert.equal(result.json.error.code, 'RECIPE_PLATFORM_REQUIRED');
    assert.match(
      result.json.error.userAction,
      new RegExp(` ${command} shop\\.open --platform web`, 'u'),
    );
  }
});

test('a malformed --library entry is a usage error', async () => {
  const env = { RECIPE_LIBRARY_PATH: `hello=${HELLO}` };
  for (const entry of ['hello=', '=path']) {
    const result = await cli<DiscoveryErrorEnvelope>(['list', '--library', entry], env);
    assert.deepEqual([result.exitCode, result.json.error.code], [2, 'DISCOVERY_USAGE'], entry);
  }
  const fromEnv = await cli<DiscoveryErrorEnvelope>(['list'], { RECIPE_LIBRARY_PATH: 'hello=' });
  assert.deepEqual([fromEnv.exitCode, fromEnv.json.error.code], [2, 'RECIPE_LIBRARY_PATH_INVALID']);
});

test('search finds shadowed recipes by their library id', async (t) => {
  const { env } = await shadowedHello(t);
  const { json } = await cli<SearchEnvelope>(['search', 'hello.greet'], env);
  const shadowed = json.results.find((result) => result.id === 'hello.greet');
  assert.deepEqual(
    [shadowed?.source, shadowed?.description.startsWith('Greet someone')],
    ['hello', true],
  );
});

test('an index loads each library set once per platform, however many lookups follow', async (t) => {
  const { env } = await shadowedHello(t);
  const calls: string[] = [];
  const index = await buildDiscoveryIndex({
    env,
    platform: 'web',
    loadLibraries: (sources, options) => {
      calls.push(`${sources.map((source) => source.name).join('+')}@${options?.adapter ?? '*'}`);
      return loadRecipeLibraries(sources, options);
    },
  });
  assert.deepEqual(calls.sort(), ['a+hello@*', 'a+hello@web']);
  for (let round = 0; round < 3; round += 1) {
    assert.equal((await findRecipe(index, 'hello.greet'))?.resolvedBy, 'id');
    assert.deepEqual(
      (await shadowedRecipes(index)).map((recipe) => recipe.ref),
      ['greet', 'greet-twice'],
    );
  }
  assert.deepEqual(calls.sort(), ['a+hello@*', 'a+hello@web', 'hello@web']);
});

test('explain --strict exits 3 when anything is missing', async () => {
  const env = { RECIPE_LIBRARY_PATH: `hello=${HELLO}` };
  const gaps = await cli<ExplainEnvelope>(['explain', 'greet-twice', '--strict'], env);
  assert.deepEqual([gaps.exitCode, gaps.json.status], [3, 'ok']);
  assert.deepEqual(gaps.json.missing.parameters, [{ recipe: 'greet-twice', name: 'guest' }]);
  const clean = await cli<ExplainEnvelope>(
    ['explain', 'greet-twice', '--param', 'guest=Ada', '--strict'],
    env,
  );
  assert.equal(clean.exitCode, 0);
});

test('a run selected by id logs and records the recipe it selected', async (t) => {
  const { env } = await shadowedHello(t);
  const artifacts = await mkdtemp(path.join(os.tmpdir(), 'recipe-id-run-'));
  t.after(() => rm(artifacts, { recursive: true, force: true }));
  const previousExit = process.exitCode;
  t.after(() => {
    process.exitCode = previousExit;
  });
  const run = async (extra: string[]): Promise<string[]> => {
    const lines: string[] = [];
    const saved = { log: console.log, info: console.info, warn: console.warn };
    const capture = (line: unknown) => void lines.push(String(line));
    Object.assign(console, { log: capture, info: capture, warn: capture });
    const previousEnv = process.env.RECIPE_LIBRARY_PATH;
    process.env.RECIPE_LIBRARY_PATH = env.RECIPE_LIBRARY_PATH;
    try {
      await runRecipeCli([
        'run',
        'hello.greet',
        'name=Ada',
        '--action-manifest',
        path.join(HELLO, 'manifests', 'shared.action-manifest.json'),
        '--artifacts-dir',
        artifacts,
        ...extra,
      ]);
    } finally {
      Object.assign(console, saved);
      process.env.RECIPE_LIBRARY_PATH = previousEnv;
    }
    return lines;
  };
  const refusal = JSON.parse((await run(['--json'])).find((line) => line.startsWith('{'))!) as {
    recipeDigest: string;
  };
  process.exitCode = 0;
  const lines = await run(['--approve-plan', refusal.recipeDigest]);
  assert.equal(process.exitCode ?? 0, 0);
  assert.ok(lines.includes('Recipe hello.greet selected by id: hello · recipes/greet.recipe.json'));
  assert.equal(
    lines.some((line) => line.includes('shadows')),
    false,
    'the winner it did not run is not reported',
  );
  const summary = JSON.parse(await readFile(path.join(artifacts, 'summary.json'), 'utf8')) as {
    status: string;
    recipeSelection?: { name: string; resolvedBy: string; source: string; file: string };
  };
  assert.equal(summary.status, 'pass');
  assert.deepEqual(
    [
      summary.recipeSelection?.name,
      summary.recipeSelection?.resolvedBy,
      summary.recipeSelection?.source,
      summary.recipeSelection?.file,
    ],
    ['hello.greet', 'id', 'hello', 'recipes/greet.recipe.json'],
  );
});

test('all-platform search finds shadowed platform-only recipes by id', async (t) => {
  const { root, env } = await shadowedHello(t);
  // Both libraries ship the same web-only recipe, as an override copy of a team library would.
  const wave = recipe('Wave', { wave: { action: 'hello.wave', name: 'Ada', next: 'done' } });
  await writeJson(path.join(root, 'hello', 'recipes', 'web', 'wave.recipe.json'), wave);
  await writeJson(path.join(root, 'a', 'recipes', 'web', 'wave.recipe.json'), {
    ...wave,
    title: 'A wave',
  });
  for (const extra of [[], ['--platform', 'web']]) {
    const { json } = await cli<SearchEnvelope>(['search', 'hello.wave', ...extra], env);
    const shadowed = json.results.find((result) => result.id === 'hello.wave');
    assert.equal(shadowed?.source, 'hello', `search ${extra.join(' ')}`);
  }
});

test('all-platform search lists a shadowed id once when only a platform variant is shadowed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-discovery-dedupe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(HELLO, path.join(root, 'hello'), { recursive: true });
  // The override library ships only the web greeting.
  const webGreet = path.join(HELLO, 'recipes', 'web', 'greet.recipe.json');
  await writeJson(path.join(root, 'web-only', 'recipe-library.json'), { platforms: ['web'] });
  await writeJson(path.join(root, 'web-only', 'recipes', 'web', 'greet.recipe.json'), {
    ...JSON.parse(await readFile(webGreet, 'utf8')),
    title: 'Override web greeting',
  });
  await cp(path.join(HELLO, 'manifests'), path.join(root, 'web-only', 'manifests'), {
    recursive: true,
  });
  const env = {
    RECIPE_LIBRARY_PATH: `web-only=${path.join(root, 'web-only')}:hello=${path.join(root, 'hello')}`,
  };
  const { json } = await cli<SearchEnvelope>(['search', 'hello.greet'], env);
  assert.equal(json.results.filter((result) => result.id === 'hello.greet').length, 1);
});

test('hosts can assess a qualified alias by the document it resolves to', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-discovery-assess-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const high = path.join(root, 'high');
  const low = path.join(root, 'low');
  await writeJson(path.join(high, 'manifests', 'shared.action-manifest.json'), commandManifest());
  await writeJson(
    path.join(high, 'recipes', 'foo.recipe.json'),
    recipe('Foo', { run: { action: 'command', cmd: 'true', next: 'done' } }),
  );
  await writeJson(path.join(low, 'recipe-library.json'), { platforms: ['web'] });
  await writeJson(
    path.join(low, 'recipes', 'web', 'foo.recipe.json'),
    recipe('Low web foo', { bad: { action: 'low.bad', next: 'done' } }),
  );
  const index = await buildDiscoveryIndex({
    env: { RECIPE_LIBRARY_PATH: `high=${high}:low=${low}` },
    platform: 'web',
  });
  const alias = index.resolution.recipes.get('web.foo')!;
  assert.equal(alias.aliasFor, 'foo');
  assert.deepEqual(
    assessRecipe(index, alias).map((problem) => problem.code),
    ['recipe.action_not_declared_by_manifest'],
  );
  assert.deepEqual(assessRecipe(index, index.resolution.recipes.get('foo')!), []);
});

test('a host view judges readiness from one platform resolution and its own manifest', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-discovery-host-view-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = path.join(root, 'acme');
  await writeJson(
    path.join(library, 'recipes', 'extension', 'acme', 'nav.recipe.json'),
    recipe('Nav', { run: { action: 'command', cmd: 'true', next: 'done' } }),
  );
  // A half-edited recipe for another platform.
  await mkdir(path.join(library, 'recipes', 'mobile', 'acme'), { recursive: true });
  await writeFile(path.join(library, 'recipes', 'mobile', 'acme', 'wip.recipe.json'), '{"title": ');
  const sources = [{ name: 'acme', root: library }];

  // A single-platform view never reads it.
  const resolution = await loadRecipeLibraries(sources, { adapter: 'extension' });
  const nav = resolution.recipes.get('acme.nav')!;
  const declared = commandManifest() as RecipeActionManifestDocument;
  assert.deepEqual(assessRecipe({ resolution, manifest: declared }, nav), []);

  // Readiness uses the injected manifest, not one recipe-cli merges itself.
  const helloManifest = JSON.parse(
    await readFile(path.join(HELLO, 'manifests', 'shared.action-manifest.json'), 'utf8'),
  ) as RecipeActionManifestDocument;
  delete helloManifest.actions.command;
  assert.deepEqual(
    assessRecipe({ resolution, manifest: helloManifest }, nav).map((problem) => problem.code),
    ['recipe.action_not_declared_by_manifest'],
  );
});

test('requires vouches only for the packages the host passes, like run', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-discovery-vouch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(HELLO, root, { recursive: true });
  await writeJson(path.join(root, 'recipe-library.json'), {
    platforms: ['web'],
    requires: { '@farmslot/recipe-cli': '>=0.1.0' },
  });
  const env = { RECIPE_LIBRARY_PATH: `hello=${root}` };
  // A host that does not provide recipe-cli: discovery and run both refuse.
  await assert.rejects(buildDiscoveryIndex({ env }), /cannot provide or check/u);
  await assert.rejects(loadRecipeLibraries([{ name: 'hello', root }]), /cannot provide or check/u);
  // farmslot-recipe vouches for itself in both paths.
  const packageVersions = { '@farmslot/recipe-cli': RECIPE_CLI_VERSION };
  const index = await buildDiscoveryIndex({ env, packageVersions });
  assert.equal(index.recipes.get('greet')?.runnable, true);
  const listed = await cli<ListEnvelope>(['list'], env);
  assert.equal(listed.json.status, 'ok');
  const described = await cli<{ ref: string }>(['run', 'greet', '--describe'], env);
  assert.equal(described.exitCode, 0);
  assert.equal(described.json.ref, 'greet');
});

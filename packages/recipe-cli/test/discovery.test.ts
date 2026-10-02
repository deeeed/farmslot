import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runRecipeCli } from '../src/cli.js';
import { buildDiscoveryIndex } from '../src/discovery-index.js';
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
    'shop.broken',
    'shop.open',
    'shop.setup',
    'shop.smoke',
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
  assert.equal(requires.json.error.code, 'LIBRARY_REQUIREMENT_UNSATISFIED');

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
  assert.equal(index.libraries[0]?.info.requires[0]?.satisfied, true);
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

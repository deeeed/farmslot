import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = mkdtempSync(path.join(tmpdir(), 'recipe-adapter-coherence-'));
const library = path.join(fixture, 'library');
const priorityLibrary = path.join(fixture, 'priority-library');
const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const recipe = (title, nodes, entry = 'prove') => ({
  $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
  title,
  description: 'Disposable adapter selection proof through the CLI.',
  workflow: { entry, nodes },
});
try {
  const control = process.argv.includes('--negative-control');
  const controlName = process.argv.includes('--shadow-control') ? 'adapters-shadow' : 'adapters';
  writeFileSync(path.join(fixture, '.coherence-fixture'), 'disposable\n');
  writeJson(path.join(library, 'recipe-library.json'), { platforms: ['terminal', 'desktop'] });
  const leaf = (title) =>
    recipe(title, {
      prove: {
        action: 'command',
        cmd:
          title === 'Terminal'
            ? "node -e \"require('node:fs').writeFileSync('selected.txt','terminal')\""
            : 'node -e "process.exit(17)"',
        intent: 'Prove that the selected adapter variant executes.',
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    });
  writeJson(path.join(library, 'recipes/shared/orders/fixture.recipe.json'), leaf('Shared'));
  writeJson(path.join(library, 'recipes/terminal/orders/fixture.recipe.json'), leaf('Terminal'));
  writeJson(path.join(library, 'recipes/desktop/orders/fixture.recipe.json'), leaf('Desktop'));
  const shadowLeaf = (file, value) =>
    recipe('Shadow precedence proof', {
      prove: {
        action: 'command',
        cmd: `node -e "require('node:fs').writeFileSync('${file}','${value}')"`,
        intent: 'Prove the selected source by its actual side effect.',
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    });
  writeJson(
    path.join(priorityLibrary, 'recipes/orders/shadowed.recipe.json'),
    shadowLeaf('shadow-canonical.txt', 'high'),
  );
  writeJson(
    path.join(library, 'recipes/terminal/orders/shadowed.recipe.json'),
    shadowLeaf('shadow-qualified.txt', 'terminal'),
  );
  writeJson(
    path.join(fixture, 'recipe.json'),
    recipe('Custom adapter selection', {
      prove: {
        action: 'call',
        ref: 'orders.fixture',
        intent: 'Resolve the custom adapter logical ID.',
        next: 'legacy',
      },
      legacy: {
        action: 'call',
        ref: 'terminal.orders.fixture',
        intent: 'Resolve the existing qualified custom adapter reference.',
        next: 'shadow-canonical',
      },
      'shadow-canonical': {
        action: 'call',
        ref: 'orders.shadowed',
        intent: 'Use the higher-priority generic recipe.',
        next: 'shadow-qualified',
      },
      'shadow-qualified': {
        action: 'call',
        ref: 'terminal.orders.shadowed',
        intent: 'Preserve the qualified lower-priority custom variant.',
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    }),
  );
  writeJson(path.join(fixture, 'manifest.json'), {
    $schema: 'https://farmslot.io/schemas/action-manifest-v1.schema.json',
    actions: {
      call: {
        description: 'Call an installed library recipe.',
        examples: [
          {
            action: 'call',
            ref: 'orders.fixture',
            intent: 'Resolve the installed fixture.',
            next: 'done',
          },
        ],
        schema: { type: 'object', properties: {}, additionalProperties: false },
      },
      command: {
        description: 'Execute the exact disposable fixture command.',
        examples: [
          {
            action: 'command',
            cmd: 'node -e \"process.exit(0)\"',
            intent: 'Execute the reviewed fixture command.',
            next: 'done',
          },
        ],
        schema: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd'],
          additionalProperties: false,
        },
      },
      end: { description: 'Finish execution.', examples: [{ action: 'end', status: 'pass' }] },
    },
  });
  const args = [
    '--import',
    'tsx',
    path.join(root, 'packages/cli/src/entry.ts'),
    '--json',
    'recipe',
    'run',
    path.join(fixture, 'recipe.json'),
    '--artifacts-dir',
    path.join(fixture, 'artifacts'),
    '--action-manifest',
    path.join(fixture, 'manifest.json'),
    '--project-root',
    fixture,
    '--adapter',
    'terminal',
    '--library-source',
    `priority=${priorityLibrary}`,
    '--library-source',
    `fixture=${library}`,
  ];
  const execute = (extra) =>
    spawnSync(process.execPath, [...args, ...extra], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: path.join(root, 'packages/cli/tsconfig.json'),
        FARMSLOT_HOME: path.join(fixture, 'home'),
        FARMSLOT_GATEWAY: 'ws://127.0.0.1:9',
        GW_URL: 'ws://127.0.0.1:9',
        ...(control
          ? {
              FARMSLOT_COHERENCE_CONTROL: controlName,
              FARMSLOT_COHERENCE_FIXTURE: fixture,
              FARMSLOT_COHERENCE_CONTROL_RECEIPT: path.join(fixture, 'control-applied'),
              NODE_OPTIONS: `--import ${path.join(root, 'scripts/runner-validation/gateway/native-coherence-control.mjs')}`,
            }
          : {}),
      },
    });
  let result = execute([]);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    assert.ok(result.stdout.trim(), result.stderr || 'CLI returned no structured result');
    const response = JSON.parse(result.stdout);
    assert.equal(response.error?.code, 'RECIPE_TRUST_REQUIRED', result.stderr || result.stdout);
    const digest = response.error.userAction.match(/--approve-plan (sha256:[a-f0-9]+)/)?.[1];
    assert.ok(digest, 'fixture execution needs its exact reviewed plan');
    result = execute(['--approve-plan', digest]);
  }
  assert.equal(
    result.status,
    0,
    `custom adapter variant must execute successfully: ${result.stderr || result.stdout}`,
  );
  assert.equal(readFileSync(path.join(fixture, 'selected.txt'), 'utf8'), 'terminal');
  assert.equal(readFileSync(path.join(fixture, 'shadow-canonical.txt'), 'utf8'), 'high');
  assert.equal(readFileSync(path.join(fixture, 'shadow-qualified.txt'), 'utf8'), 'terminal');
  const summary = JSON.parse(readFileSync(path.join(fixture, 'artifacts/summary.json'), 'utf8'));
  assert.equal(summary.status, 'pass');
  console.log(
    JSON.stringify({
      passed: true,
      canonicalRef: 'orders.fixture',
      legacyRef: 'terminal.orders.fixture',
      selectedAdapter: 'terminal',
    }),
  );
} catch (error) {
  const receipt = path.join(fixture, 'control-applied');
  try {
    console.error(`Applied control: ${readFileSync(receipt, 'utf8')}`);
  } catch (readError) {
    if (readError.code !== 'ENOENT') throw readError;
  }
  throw error;
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

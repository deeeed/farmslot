import { resolveSlotPoolDir } from '../../src/node/slot-by-repo.js';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import test, { type TestContext } from 'node:test';

import {
  currentFarmPaths,
  isNodeFarmPaths,
  legacyRemoteFarmPaths,
  resolveFarmPaths,
} from '../../src/node/farm-paths.js';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'farm-paths-process-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('process paths cache each home and refresh when its instance marker changes', (t) => {
  const root = fixture(t);
  const envA = { FARMSLOT_HOME: path.join(root, 'a'), FARMSLOT_ROOT: root };
  const envB = { ...envA, FARMSLOT_HOME: path.join(root, 'b') };
  const first = currentFarmPaths('gateway', envA);
  assert.strictEqual(currentFarmPaths('gateway', envA), first);
  assert.notStrictEqual(currentFarmPaths('gateway', envB), first);
  assert.strictEqual(currentFarmPaths('gateway', envA), first);
  const marker = path.join(envA.FARMSLOT_HOME, 'config', 'instance.json');
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ layout: 2 }));
  const migrated = currentFarmPaths('gateway', envA);
  assert.equal(migrated.layout, 2);
  assert.equal(migrated.state.runs, path.join(envA.FARMSLOT_HOME, 'state', 'runs'));
  writeFileSync(marker, JSON.stringify({ layout: 2, dataRoot: 'other' }));
  utimesSync(marker, new Date(1_000), new Date(2_000));
  assert.equal(currentFarmPaths('gateway', envA).data.root, path.join(envA.FARMSLOT_HOME, 'other'));
  rmSync(marker);
  assert.equal(currentFarmPaths('gateway', envA).layout, 'legacy');
});

test('legacy file overrides retain raw handling, warn once per variable, and layout 2 ignores them', (t) => {
  const root = fixture(t);
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  const env = {
    FARMSLOT_HOME: path.join(root, 'home'),
    FARMSLOT_ROOT: root,
    FARMSLOT_DISPATCH_QUEUE_FILE: '~/queue.json',
    FARMSLOT_EVAL_SUITE_CAP_FILE: 'relative/caps.json',
    FARMSLOT_BACKLOG_SPEC_DIR: '',
    FARMSLOT_FEEDBACK_LEDGER: '  relative/feedback.json  ',
    FARMSLOT_SOURCES_CONFIG: 'relative/sources.json',
    FARMSLOT_EXTRA_LOG_DIRS: ` logs ${path.delimiter} other `,
    FARMSLOT_INTELLIGENCE_AUDIT_DIR: '',
    FARMSLOT_OBSERVABILITY_AGREEMENT_DIR: 'relative/agreement',
  };
  const paths = currentFarmPaths('gateway', env);
  assert.equal(paths.state.dispatchQueue, '~/queue.json');
  assert.equal(paths.state.evalCaps, 'relative/caps.json');
  assert.equal(paths.state.backlogSpecs, '');
  assert.equal(paths.state.feedbackLedger, 'relative/feedback.json');
  assert.equal(paths.state.intelligenceAudit, '');
  assert.equal(paths.state.observabilityAgreement, 'relative/agreement');
  assert.equal(paths.configFiles.sources, 'relative/sources.json');
  assert.deepEqual(paths.state.extraLogDirs, [path.resolve('logs'), path.resolve('other')]);
  currentFarmPaths('gateway', env);
  currentFarmPaths('node', env);
  for (const name of paths.envOverrides)
    assert.equal(
      warnings.filter((message) => message.includes(`${name} is deprecated`)).length,
      1,
      name,
    );
  const count = warnings.length;
  mkdirSync(path.join(env.FARMSLOT_HOME, 'config'), { recursive: true });
  writeFileSync(path.join(env.FARMSLOT_HOME, 'config', 'instance.json'), '{"layout":2}');
  const migrated = currentFarmPaths('gateway', env);
  assert.deepEqual(migrated.envOverrides, []);
  assert.equal(warnings.length, count);
  assert.equal(migrated.configFiles.sources, path.join(env.FARMSLOT_HOME, 'config/sources.json'));
  assert.equal(
    migrated.state.dispatchQueue,
    path.join(env.FARMSLOT_HOME, 'state/dispatch-queue.json'),
  );
});

test('legacy remote fallback keeps helper and template selection distinct without gateway roots', () => {
  const paths = legacyRemoteFarmPaths({ FARMSLOT_WORKSPACE: '  ~/farmslot-node-dev  ' });
  assert.equal(paths.code.node, '~/farmslot-node');
  assert.equal(paths.code.support, '~/farmslot-node/support');
  assert.equal(paths.code.templateNode, '~/farmslot-node-dev');
  assert.equal(paths.pool, '~/farmslot-node/pool');
  assert.equal(legacyRemoteFarmPaths({}, '/old/node').state.runs, '/old/node/.runs');
});

test('node report validation checks nested paths and rejects malformed optional reports', (t) => {
  const root = fixture(t);
  const report = resolveFarmPaths({ role: 'node', home: root, checkoutRoot: root, env: {} });
  assert.equal(isNodeFarmPaths(JSON.parse(JSON.stringify(report))), true);
  for (const invalid of [
    undefined,
    null,
    {},
    { ...report, role: 'gateway' },
    { ...report, code: {} },
    { ...report, pool: 2 },
    { ...report, state: { ...report.state, runs: '\0' } },
  ]) {
    assert.equal(isNodeFarmPaths(invalid), false);
  }
});

test('standalone installed protocol resolves the installation and runtime roots, not node_modules', async (t) => {
  const root = fixture(t);
  const packageRoot = path.join(root, 'node_modules/@farmslot/protocol');
  const file = path.join(packageRoot, 'dist/node/farm-paths.js');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(path.join(packageRoot, 'package.json'), '{"type":"module"}');
  for (const name of ['farm-paths', 'farm-paths-storage', 'farmslot-home']) {
    const source = readFileSync(new URL(`../../src/node/${name}.ts`, import.meta.url), 'utf8');
    writeFileSync(
      path.join(path.dirname(file), `${name}.js`),
      ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    );
  }
  const installed: typeof import('../../src/node/farm-paths.js') = await import(
    pathToFileURL(file).href
  );
  const env = { FARMSLOT_HOME: path.join(root, 'home'), FARMSLOT_ROOT: '' };
  const paths = installed.currentFarmPaths('node', env);
  assert.equal(paths.code.node, root);
  assert.equal(paths.pool, path.join(root, 'pool'));
  assert.equal(
    paths.code.agentRuntimeScripts,
    path.join(root, 'node_modules/@farmslot/agent-runtime/scripts'),
  );
});

test('legacy template fallback and request-home CLI defaults preserve their separate contexts', (t) => {
  const root = fixture(t);
  const paths = resolveFarmPaths({
    role: 'gateway',
    home: root,
    checkoutRoot: root,
    userHome: path.join(root, 'worker-home'),
    env: { FARMSLOT_PROJECTS_DIR: path.join(root, 'external-projects') },
  });
  assert.equal(paths.projects, path.join(root, 'external-projects'));
  assert.equal(paths.templateProjects, path.join(root, 'projects'));
  assert.equal(paths.code.bin, path.join(root, 'worker-home/.local/bin'));
});

test('external pool lookup ignores whitespace-only overrides and preserves its default', (t) => {
  const root = fixture(t);
  const env = { FARMSLOT_HOME: path.join(root, 'home'), FARMSLOT_ROOT: root };
  assert.equal(resolveSlotPoolDir(env)?.dir, path.join(root, 'pool'));
  const spaces = { ...env, FARMSLOT_POOL_DIR: '  ' };
  assert.equal(resolveSlotPoolDir(spaces)?.dir, path.join(root, 'pool'));
  assert.equal(currentFarmPaths('gateway', spaces).pool, path.resolve('  '));
});

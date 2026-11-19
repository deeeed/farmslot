import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isRecipeFlowUpdate,
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecipeActionManifestDocument,
  type RecipeFlowUpdate,
} from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { projectRecipeInvocationTiming } from '../src/core/flow-timing.js';
import { createRecipeRunner } from '../src/core/runner.js';
import type { SummaryDocument } from '../src/core/types.js';

import { inner, root, unit } from './flow.fixture.js';

const manifest: RecipeActionManifestDocument = {
  $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  actions: {
    command: {
      description: 'Observe actual output',
      schema: {
        type: 'object',
        properties: { cmd: { type: 'string' } },
        additionalProperties: false,
      },
      examples: [{ action: 'command', intent: 'Observe', cmd: 'printf OK', next: 'done' }],
    },
    assert_output: {
      description: 'Check observed output',
      schema: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          stream: { type: 'string' },
          contains: { type: 'string' },
        },
        additionalProperties: false,
      },
      examples: [
        {
          action: 'assert_output',
          intent: 'Verify',
          source: 'observe',
          contains: 'OK',
          next: 'done',
        },
      ],
    },
    wait: {
      description: 'A fixture action',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      examples: [{ action: 'wait', intent: 'Observe fixture state', next: 'done' }],
    },
    switch: {
      description: 'Select fixture branch',
      result_cases: ['yes', 'no'],
      schema: { type: 'object', properties: {}, additionalProperties: false },
      examples: [{ action: 'switch', intent: 'Choose fixture branch', next: 'done' }],
    },
    'app.hud': {
      description: 'Observe HUD updates',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      examples: [{ action: 'app.hud', intent: 'Show fixture progress', next: 'done' }],
    },
    call: {
      description: 'Call a fixture',
      examples: [{ action: 'call', intent: 'Call fixture', ref: 'fixture.inner', next: 'done' }],
    },
    end: { description: 'Finish', examples: [{ action: 'end', status: 'pass' }] },
  },
};

for (const scenario of [
  'yes',
  'no',
  'failure',
  'partial',
  'terminal',
  'resolution',
  'cancelled',
  'hud_failure',
] as const) {
  const branch = scenario === 'no' ? 'no' : 'yes';
  test(`real runner publishes global ${scenario} progress on existing HUD updates and final summary`, async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'recipe-flow-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const library = path.join(dir, 'library');
    await mkdir(path.join(library, 'recipes/fixture'), { recursive: true });
    const document = (value: Record<string, unknown>) => ({
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Composed flow renderer fixture',
      ...value,
    });
    await writeFile(
      path.join(library, 'recipes/fixture/inner.recipe.json'),
      JSON.stringify(
        document(
          scenario === 'failure'
            ? {
                ...inner,
                workflow: {
                  ...inner.workflow,
                  nodes: {
                    ...inner.workflow.nodes,
                    read: { ...inner.workflow.nodes.read, contains: 'MISSING' },
                  },
                },
              }
            : inner,
        ),
      ),
    );
    await writeFile(
      path.join(library, 'recipes/fixture/unit.recipe.json'),
      JSON.stringify(document(unit)),
    );
    const simple =
      scenario === 'terminal' || scenario === 'resolution' || scenario === 'hud_failure';
    const scenarioRoot = simple
      ? {
          ...root,
          workflow: {
            entry: scenario === 'terminal' ? 'done' : 'work',
            teardown: 'cleanup',
            nodes: {
              ...(scenario === 'terminal'
                ? {}
                : {
                    work: {
                      action: 'command',
                      intent: 'Use observed fixture data',
                      cmd: scenario === 'resolution' ? '{{outputs.missing.cmd}}' : 'printf OK',
                      next: 'done',
                    },
                  }),
              done: { action: 'end', status: scenario === 'terminal' ? 'fail' : 'pass' },
              cleanup: root.workflow.nodes.cleanup,
              clean: root.workflow.nodes.clean,
            },
          },
        }
      : root;
    let failHud = scenario === 'hud_failure';
    const updates: RecipeFlowUpdate[] = [];
    const runner = createRecipeRunner({
      actionManifest: manifest,
      defaultSource: { kind: 'operator', trust: 'trusted' },
      adapters: [
        ...createStandardCoreAdapters({ actions: ['command', 'assert_output'] }).map((adapter) => ({
          ...adapter,
          source: { kind: 'bundled' as const, trust: 'trusted' as const },
        })),
        ...['wait', 'switch', 'app.hud'].map((action) => ({
          action,
          source: { kind: 'bundled', trust: 'trusted' },
          async execute(node) {
            if (action === 'app.hud') {
              const flow = node.recipe_flow;
              assert.ok(
                isRecipeFlowUpdate(flow),
                'existing HUD event must carry qualified SDK progress',
              );
              updates.push(structuredClone(flow));
              if (failHud && node.status === 'pass') {
                failHud = false;
                throw new Error('Fixture HUD delivery failed after the completed action');
              }
            }
            return action === 'switch' ? { case: branch } : {};
          },
        })),
      ],
    });
    const result = await runner.run({
      recipeDocument: document(scenarioRoot),
      projectRoot: dir,
      artifactsDir: path.join(dir, 'output'),
      librarySources: [{ root: library, provenance: { kind: 'library', trust: 'trusted' } }],
      recordVideo: false,
      ...(scenario === 'partial' ? { stopAfterNode: 'first' } : {}),
      ...(scenario === 'cancelled'
        ? { signal: AbortSignal.abort(new Error('Fixture cancelled before first action')) }
        : {}),
      recordingReason: 'SDK composition/progress fixture has no UI actions',
    });
    assert.equal(result.status, ['yes', 'no', 'partial'].includes(scenario) ? 'pass' : 'fail');
    const summary: SummaryDocument = JSON.parse(await readFile(result.summaryPath, 'utf8'));
    assert.ok(summary.flow);
    assert.equal(summary.flow.recipeRunId, summary.recipeRunId);
    const full = scenario === 'yes' || scenario === 'no';
    assert.equal(summary.flow.progress.total, full ? (branch === 'yes' ? 11 : 12) : null);
    assert.equal(summary.flow.progress.remaining, full ? 0 : null);
    const counts = {
      yes: 11,
      no: 12,
      failure: 4,
      partial: 5,
      terminal: 1,
      resolution: 1,
      cancelled: 1,
      hud_failure: 2,
    };
    assert.equal(summary.flow.progress.completed, counts[scenario]);
    if (full)
      assert.equal(
        updates.find((update) => update.activeId === 'second/nested/read')!.progress.current,
        6,
      );
    assert.ok(updates.some((update) => update.progress.total === null));
    if (scenario === 'partial')
      assert.ok(
        updates.every((update) => update.progress.total === null),
        'partial updates never claim a full denominator',
      );
    if (['terminal', 'resolution', 'cancelled', 'hud_failure'].includes(scenario)) {
      const cleanupUpdates = updates.filter((update) => update.activeId === 'cleanup');
      assert.ok(cleanupUpdates.length >= 2);
      assert.ok(
        cleanupUpdates.every(
          (update) => update.progress.total === null && update.progress.remaining === null,
        ),
        'a non-pass main graph never publishes an exact cleanup denominator',
      );
    }
    assert.equal(updates.at(-1)!.progress.total, summary.flow.progress.total);
    assert.equal(summary.flow.ancestry, null);
    for (const update of updates) {
      assert.notEqual(update.ancestry, undefined, 'new producer supplies ancestry on every update');
      if (update.activeId === null) assert.equal(update.ancestry, null);
      else {
        assert.ok(update.ancestry);
        assert.equal(update.ancestry.breadcrumbs[0]?.id, '$root');
        assert.equal(update.ancestry.breadcrumbs.at(-1)?.id, update.activeId);
        assert.equal(update.ancestry.depth, update.ancestry.breadcrumbs.length - 1);
      }
    }
    for (const call of ['first', 'second']) {
      const nested = updates.find((update) => update.activeId === call + '/nested/read');
      if (nested) {
        assert.deepEqual(
          nested.ancestry?.breadcrumbs.map((item) => item.id),
          ['$root', call, call + '/nested', call + '/nested/read'],
        );
        assert.equal(nested.ancestry?.breadcrumbs.at(-1)?.label, 'Read shared state');
      }
    }

    const resolution = JSON.parse(
      await readFile(path.join(dir, 'output/recipe-resolution.json'), 'utf8'),
    );
    const trace = JSON.parse(await readFile(path.join(dir, 'output/trace.json'), 'utf8'));
    const entries = Array.isArray(trace) ? trace : trace.entries;
    const timing = projectRecipeInvocationTiming({
      tree: resolution.flow,
      trace: entries,
      summary,
    });
    assert.deepEqual(
      summary.flow.timing,
      timing,
      'summary and report share the recorded-interval calculation',
    );
    assert.equal(timing.nodes.$root?.inclusiveMs, summary.durationMs);
    assert.ok(
      updates.every((update) => update.timing),
      'existing HUD event supplies SDK timing',
    );
    if (full) {
      assert.equal(timing.nodes['first/nested/read']?.qualification.inclusive, 'measured');
      assert.equal(timing.nodes['second/nested/read']?.qualification.self, 'measured');
      assert.equal(timing.nodes[branch === 'yes' ? 'reject' : 'accept']?.inclusiveMs, null);
    }
    if (!simple) {
      assert.ok(
        resolution.flow.nodes.some((node: { id: string }) => node.id === 'second/nested/read'),
      );
      assert.deepEqual(
        resolution.flow.nodes.find((node: { id: string }) => node.id === 'first/nested/read')
          .claimIds,
        ['first/nested/AC-1'],
      );
    }
    if (process.env.FARMSLOT_FLOW_FIXTURE_DIR) {
      const target = path.join(process.env.FARMSLOT_FLOW_FIXTURE_DIR, scenario);
      await mkdir(target, { recursive: true });
      await cp(path.join(dir, 'output'), target, { recursive: true });
      await writeFile(
        path.join(process.env.FARMSLOT_FLOW_FIXTURE_DIR, scenario + '-hud-updates.json'),
        JSON.stringify(updates, null, 2),
      );
    }
  });
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import { farmslotRoot } from './repo-root.js';

type JsonSchema = {
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  type?: string | string[];
  propertyNames?: { enum?: string[] };
};

async function readProjectSchema(): Promise<JsonSchema> {
  return JSON.parse(
    await readFile(path.join(farmslotRoot, 'schemas', 'project.schema.json'), 'utf-8'),
  ) as JsonSchema;
}

function hookSchema(schema: JsonSchema, hookName: string): JsonSchema {
  const hook = schema.properties?.hooks?.properties?.[hookName];
  assert.ok(hook, `schemas/project.schema.json should define hooks.${hookName}`);
  return hook;
}

function validateHooksAgainstSchema(schema: JsonSchema, hooks: Record<string, unknown>): string[] {
  const hooksSchema = schema.properties?.hooks;
  const allowedHooks = hooksSchema?.properties ?? {};
  const errors: string[] = [];
  for (const [hookName, hookValue] of Object.entries(hooks)) {
    const hook = allowedHooks[hookName];
    if (!hook) {
      if (hooksSchema?.additionalProperties === false) {
        errors.push(`hooks.${hookName} is not declared by project.schema.json`);
      }
      continue;
    }
    if (hook.type === 'string' && typeof hookValue !== 'string') {
      errors.push(`hooks.${hookName} must be a string command`);
    }
  }
  return errors;
}

test('project schema restricts monitoring.flows keys to the known flow types', async () => {
  const schema = await readProjectSchema();
  const flows = schema.properties?.monitoring?.properties?.flows;
  assert.ok(flows, 'schemas/project.schema.json should define monitoring.flows');
  // A typo'd flow name would otherwise validate and then silently never match
  // at runtime — the enum makes it a schema error instead.
  assert.deepEqual(
    [...(flows.propertyNames?.enum ?? [])].sort(),
    ['dev', 'fix-bug', 'pr-complete', 'review-pr', 'update-branch'],
  );
});

test('project schema declares Recipe v1 hooks as string commands', async () => {
  const schema = await readProjectSchema();
  for (const hookName of ['recipe_action_manifest', 'recipe_doctor', 'recipe_run']) {
    assert.equal(hookSchema(schema, hookName).type, 'string');
  }
  assert.equal(schema.properties?.hooks?.additionalProperties, false);
});

test('project schema rejects invalid Recipe v1 hook shapes', async () => {
  const schema = await readProjectSchema();
  assert.deepEqual(
    validateHooksAgainstSchema(schema, {
      recipe_action_manifest: 'node runner.js manifest',
      recipe_doctor: 'node runner.js doctor --json',
      recipe_run: 'node runner.js --recipe {{recipe_path}} --artifacts-dir {{artifacts_dir}}',
    }),
    [],
  );
  assert.deepEqual(validateHooksAgainstSchema(schema, { recipe_run: { cmd: 'node runner.js' } }), [
    'hooks.recipe_run must be a string command',
  ]);
  assert.deepEqual(validateHooksAgainstSchema(schema, { recipe_unknown: 'node runner.js' }), [
    'hooks.recipe_unknown is not declared by project.schema.json',
  ]);
});

test('project schema restricts the iOS inventory provider to compatible fallback watches', async () => {
  const schema = await readProjectSchema();
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  const resource = {
    type: 'device',
    platform: 'ios',
    label: 'iOS simulator',
    streamable: true,
    controllable: true,
    watch: {
      type: 'process-poll',
      provider: 'ios-simulator-inventory',
      target: '{{simulator}}',
      cmd: "xcrun simctl list devices booted 2>/dev/null | grep -q '{{simulator}}'",
    },
  };
  const project = (candidate: unknown) => ({ name: 'schema-test', resources: { sim: candidate } });

  assert.equal(validate(project(resource)), true, JSON.stringify(validate.errors));
  assert.equal(validate(project({ ...resource, type: 'service' })), false);
  assert.equal(validate(project({ ...resource, platform: 'android' })), false);
  assert.equal(
    validate(project({ ...resource, watch: { ...resource.watch, type: 'port-listen' } })),
    false,
  );
  const { cmd: _cmd, ...watchWithoutCommand } = resource.watch;
  assert.equal(validate(project({ ...resource, watch: watchWithoutCommand })), false);
  assert.equal(validate(project({ ...resource, watch: { ...resource.watch, cmd: '' } })), false);
  assert.equal(validate(project({ ...resource, watch: { ...resource.watch, cmd: '   ' } })), false);
  assert.equal(
    validate(project({ ...resource, watch: { ...resource.watch, target: '   ' } })),
    false,
  );
});

test('project schema accepts an opt-in host-pressure mode and rejects anything else', async () => {
  const schema = await readProjectSchema();
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  const providers = {
    'browser-cdp': {
      label: 'Browser CDP',
      version: '1.0.0',
      share_policy: 'exclusive',
      cost: { class: 'medium', resources: [] },
      actions: {
        acquire: { kind: 'slot-action', action_id: 'browser-start' },
        health: { kind: 'slot-action', action_id: 'browser-health' },
        release: { kind: 'slot-action', action_id: 'browser-stop' },
      },
      release_effects: ['stop browser'],
    },
  };
  const project = (admission: unknown) => ({
    name: 'schema-test',
    runtime_capabilities: { providers, host_pressure_admission: admission },
  });

  for (const mode of ['off', 'refuse', 'queue']) {
    assert.equal(validate(project({ mode })), true, JSON.stringify(validate.errors));
  }
  assert.equal(
    validate({ name: 'schema-test', runtime_capabilities: { providers } }),
    true,
    'the block is optional — absent means off',
  );
  assert.equal(validate(project({ mode: 'enabled' })), false);
  assert.equal(validate(project({})), false, 'mode is required once the block exists');
  assert.equal(validate(project({ mode: 'refuse', cpu_critical_percent: 101 })), false);
  assert.equal(validate(project({ mode: 'refuse', load1_critical_multiplier: 0 })), false);
  assert.equal(validate(project({ mode: 'refuse', unknown_knob: 1 })), false);
});

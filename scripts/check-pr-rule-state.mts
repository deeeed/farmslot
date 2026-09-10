#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import type { PRRulesListResult } from '../packages/protocol/src/index.js';
loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const id = process.env.PR_RULE_VALIDATION_ID;
if (process.argv[2] === 'ui-ready') {
  assert(id, 'Supply the isolated validation rule ID');
  const helper = fileURLToPath(
    new URL('../apps/companion/scripts/agentic/cdp-eval.mjs', import.meta.url),
  );
  // Keep polling outside Hermes: its CDP awaitPromise can return a pending RN Promise.
  // Inspect committed accessibility props only; never invoke handlers or change UI state.
  const expression = `
    const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) throw new Error('React inspector unavailable');
    const buttons = [];
    function walk(fiber) {
      if (!fiber) return;
      const props = fiber.memoizedProps;
      if (props?.testID === ${JSON.stringify(`companion-pr-rule-toggle-${id}`)} && props.accessibilityState) buttons.push(props);
      walk(fiber.child);
      walk(fiber.sibling);
    }
    for (const renderer of hook.renderers.keys()) {
      for (const root of hook.getFiberRoots(renderer)) walk(root.current);
    }
    return { ready: buttons.length > 0 && buttons.every(props => props.accessibilityLabel === 'Disable rule' && props.accessibilityState.disabled === false) };
  `;
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline) {
    const { stdout } = await promisify(execFile)(process.execPath, [helper, expression], {
      timeout: 10_000,
    });
    if (JSON.parse(stdout).ready === true) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert(ready, 'Rule control must become enabled after activation finishes');
  console.log(JSON.stringify({ passed: true, id, ready }));
  process.exit(0);
}
const enabled = process.argv[2] === 'enabled';
assert(id && ['enabled', 'disabled'].includes(process.argv[2]));
const client = new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 15_000,
});
const connection = await client.connect();
try {
  const deadline = Date.now() + 15_000;
  let matched = false;
  while (Date.now() < deadline) {
    const state = await connection.call<PRRulesListResult>('prRules.list');
    const rule = state.rules.find((item) => item.id === id);
    assert(
      rule?.config.name === 'Rule actions validation',
      'Only inspect the isolated validation rule',
    );
    if (rule.enabled === enabled) {
      matched = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(matched, `The native rule control must persist ${enabled ? 'enabled' : 'disabled'}`);
  console.log(JSON.stringify({ passed: true, id, enabled }));
} finally {
  connection.close();
}

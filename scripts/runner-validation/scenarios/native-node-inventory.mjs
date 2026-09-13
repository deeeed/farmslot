import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'native-node-inventory';
export const RUNNER_AGNOSTIC = true;

/** Stop/restart only the owned validation daemon between stages; all assertions use gateway RPC. */
export async function runScenario({ outDir }) {
  const stage = process.env.FARMSLOT_NATIVE_INVENTORY_STAGE;
  const node = process.env.FARMSLOT_NATIVE_EXECUTION_NODE;
  const report = { runner: 'codex', stage, executionNodeId: node, checks: [], pass: false };
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.ok(node && node !== 'local');
    assert.ok(['checkpoint', 'offline', 'reconnect'].includes(stage));
    const statePath = path.resolve(process.env.FARMSLOT_NATIVE_INVENTORY_STATE ?? '');
    assert.ok(
      statePath.startsWith(path.join(ROOT, 'temp/native-validation/')),
      'Use a private validation state path',
    );
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'),
          'gateway',
          'native.session.list',
          '{}',
        ],
        {
          cwd: ROOT,
          env: process.env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 70000,
        },
      ),
    );
    const sessions = result.sessions.filter((session) => session.executionNodeId === node);
    if (stage === 'checkpoint') {
      assert.ok(sessions.length, 'Create real node sessions before checkpointing inventory');
      fs.writeFileSync(
        statePath,
        JSON.stringify({ node, ids: sessions.map((session) => session.id) }),
        { mode: 0o600 },
      );
      report.checks.push({ name: 'connected-node-sessions-in-aggregate-inventory', pass: true });
    } else {
      const previous = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(previous.node, node);
      if (stage === 'offline') {
        assert.equal(sessions.length, 0, 'Stop the validation daemon before the offline stage');
        assert.ok(
          result.unavailableExecutionNodes?.some((entry) => entry.executionNodeId === node),
          'Offline node vanished without an inventory warning',
        );
        report.checks.push({ name: 'offline-node-is-explicit-in-aggregate-inventory', pass: true });
      } else {
        for (const id of previous.ids)
          assert.ok(
            sessions.some((session) => session.id === id),
            'Reconnected node lost a durable session',
          );
        assert.ok(
          !result.unavailableExecutionNodes?.some((entry) => entry.executionNodeId === node),
        );
        report.checks.push({
          name: 'reconnected-node-restores-original-session-inventory',
          pass: true,
        });
      }
    }
    report.pass = true;
  } catch (error) {
    report.error = error.stderr
      ? 'Gateway inventory request failed; inspect validation logs'
      : error.message;
  }
  const outPath = writeEvidence(report, `${SCENARIO_ID}-${stage}`, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, outPath, pass: report.pass, report };
}

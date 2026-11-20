import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { SlotVars } from '../core/config.js';

const nativeExec = await import('../core/exec.js');
const calls: unknown[][] = [];
let result = { stdout: 'turns=3\ntotal_tokens=124\n', stderr: '', exitCode: 0 };
mock.module('../core/exec.js', {
  namedExports: {
    ...nativeExec,
    // Only the local fixture host runs in this process; every other host is a remote slot.
    isLocal: (host: string) => host === 'localhost',
    execOnSlot: async (...args: unknown[]) => {
      calls.push(args);
      return result;
    },
  },
});
const { extractRunnerSessionUsage, extractRunWorkerSessionUsage } =
  await import('./session-usage.js');
const { makeRun } = await import('../run-completion/test-fixtures.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const { claudeSessionUsageProvider } = await import('../runners/session-usage-provider.js');
const { liteLlmEndpointId } = await import('@farmslot/agent-runtime/scripts/litellm-endpoint.cjs');

test('remote usage uses supported node execution and preserves slot support selection', async () => {
  const vars = { host: 'remote.example', machine: 'remote-test', resourceVars: {} } as SlotVars;
  const parent = { stepNumber: 1, label: 'Parent step', checkedAt: '2026-11-19T00:00:00.000Z' };
  const child = { ...parent, label: 'Child rule' };
  const usage = await extractRunnerSessionUsage({
    slotId: 'slot-1',
    vars,
    runner: 'codex',
    runnerSessionId: 'conversation',
    runnerSessionPath: "/tmp/native session's.jsonl",
    checklistMarks: [child],
    parentChecklistMarks: [parent],
  });
  assert.equal(usage.turns, 3);
  assert.equal(usage.totalTokens, 124);
  assert.equal(usage.runnerSessionId, 'conversation');
  assert.equal(calls[0][0], vars);
  assert.match(String(calls[0][1]), /runSessionUsage/);
  assert.ok(
    String(calls[0][1]).includes(
      JSON.stringify({ maxBytes: 64 * 1024, parentChecklistMarks: [parent] }),
    ),
  );
  assert.equal(String(calls[0][1]).includes('scripts/session-usage.sh'), false);
  assert.deepEqual(calls[0][2], {
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    selectNodeSupport: false,
  });
  result = { stdout: '', stderr: 'node transcript unavailable', exitCode: 1 };
  const failed = await extractRunnerSessionUsage({
    slotId: 'slot-1',
    vars,
    runner: 'codex',
    runnerSessionPath: '/tmp/native.jsonl',
  });
  assert.equal(failed.source, 'unavailable');
  assert.match(failed.error ?? '', /node transcript unavailable/);
  assert.equal(failed.turns, undefined);
});

test('a remote Pi receipt is quoted from the gateway LiteLLM prices, not the slot environment', async (t) => {
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'litellm-prices-'));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const baseUrl = 'https://litellm.example';
  const apiKey = 'test-key';
  writeFileSync(
    path.join(
      cacheDir,
      `${createHash('sha256').update(`${baseUrl}\n${apiKey}`).digest('hex')}.json`,
    ),
    JSON.stringify({
      fetchedAt: Date.now(),
      data: [
        {
          model_name: 'claude-opus-5-5',
          model_info: {
            input_cost_per_token: 0.000004,
            output_cost_per_token: 0.00002,
            cache_read_input_token_cost: 0.0000004,
            cache_creation_input_token_cost: 0.000005,
          },
        },
      ],
    }),
  );
  const vars = makeVars({
    host: 'remote.example',
    machine: 'remote-test',
    // No project command env: the machine pool env alone carries the LiteLLM credentials.
    projectName: '',
    machineEnv: {
      LITELLM_URL: baseUrl,
      LITELLM_API_KEY: apiKey,
      FARMSLOT_LITELLM_PRICING_CACHE_DIR: cacheDir,
    },
  });
  calls.length = 0;
  result = { stdout: 'turns=1\ntotal_tokens=10\n', stderr: '', exitCode: 0 };
  await extractRunnerSessionUsage({
    slotId: 'slot-1',
    vars,
    runner: 'pi',
    runnerSessionId: 'pi-session',
    runnerSessionPath: '/worker/pi.jsonl',
  });
  const command = String(calls[0][1]);
  assert.match(command, /"liteLlmPrices":\[\["claude-opus-5-5"/);
  // Prices that would push the one JSON argument past its budget are left off.
  calls.length = 0;
  await extractRunnerSessionUsage({
    slotId: 'slot-1',
    vars,
    runner: 'pi',
    runnerSessionPath: '/worker/pi.jsonl',
    // About 46 KiB of JSON that shell quoting expands past the budget.
    checklistMarks: Array.from({ length: 300 }, (_, index) => ({
      stepNumber: index + 1,
      label: "'".repeat(80),
      checkedAt: '2026-11-19T00:00:00.000Z',
    })),
  });
  assert.equal(String(calls[0][1]).includes('liteLlmPrices"'), false);
  // A static review is quoted from the endpoint it was launched with, not the machine pool's.
  const launchUrl = 'https://litellm-launch.example';
  writeFileSync(
    path.join(
      cacheDir,
      `${createHash('sha256').update(`${launchUrl}\n${apiKey}`).digest('hex')}.json`,
    ),
    JSON.stringify({
      fetchedAt: Date.now(),
      data: [
        {
          model_name: 'launch-endpoint-model',
          model_info: { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
        },
      ],
    }),
  );
  // The launch sets both names and unsets LITELLM_URL: set, then unset, so it resolved the base URL.
  const launchMutation = {
    unset: ['LITELLM_URL'],
    set: {
      LITELLM_URL: baseUrl,
      LITELLM_BASE_URL: `${launchUrl}/`,
      LITELLM_API_KEY: apiKey,
      FARMSLOT_LITELLM_PRICING_CACHE_DIR: cacheDir,
    },
  };
  const priceLaunch = async (
    endpointId: string | undefined,
    options: {
      unverified?: boolean;
      mutation?: { unset: string[]; set: Record<string, string> };
      checklistMarks?: Parameters<typeof extractRunnerSessionUsage>[0]['checklistMarks'];
    } = {},
  ) => {
    calls.length = 0;
    const receipt = await extractRunnerSessionUsage({
      slotId: 'slot-1',
      vars,
      runner: 'pi',
      runnerSessionPath: '/worker/pi.jsonl',
      checklistMarks: options.checklistMarks,
      launchPricing: {
        endpointId,
        unverified: options.unverified,
        environment: async () => options.mutation ?? launchMutation,
      },
    });
    // Every fallback still runs the receipt command and keeps its token counts.
    assert.equal(receipt.totalTokens, 10);
    return String(calls[0][1]);
  };
  // The launch route's identity: the pricing endpoint with `/v1`, as Pi's models.json names it.
  const verifiedId = liteLlmEndpointId(`${launchUrl}/v1`);
  const verified = await priceLaunch(verifiedId);
  assert.match(verified, /launch-endpoint-model/);
  assert.equal(verified.includes('claude-opus-5-5'), false);
  // No route recorded (a launch from before route receipts) leaves the slot's lookup.
  assert.equal((await priceLaunch(undefined)).includes('liteLlmPrices"'), false);
  // A recorded route the gateway cannot verify, a transcript with mixed or unknown routes, a
  // verified route whose prices cannot load or fit, all quote nothing: tokens stay, cost unpriced.
  const unpriced = '"liteLlmPrices":[]';
  assert.equal((await priceLaunch(liteLlmEndpointId(baseUrl))).includes(unpriced), true);
  assert.equal((await priceLaunch(undefined, { unverified: true })).includes(unpriced), true);
  assert.equal(
    (
      await priceLaunch(verifiedId, {
        mutation: {
          unset: [],
          set: {
            LITELLM_BASE_URL: launchUrl,
            LITELLM_API_KEY: apiKey,
            // Not a directory: the price cache cannot be read or written.
            FARMSLOT_LITELLM_PRICING_CACHE_DIR: path.join(cacheDir, 'missing/\0'),
          },
        },
      })
    ).includes(unpriced),
    true,
  );
  assert.equal(
    (
      await priceLaunch(verifiedId, {
        checklistMarks: Array.from({ length: 300 }, (_, index) => ({
          stepNumber: index + 1,
          label: "'".repeat(80),
          checkedAt: '2026-11-19T00:00:00.000Z',
        })),
      })
    ).includes(unpriced),
    true,
  );
  // A local static review with mixed or unknown routes is reported unpriced too, with its tokens;
  // one with no recorded route keeps the gateway's own lookup.
  const transcript = path.join(cacheDir, 'pi-local.jsonl');
  writeFileSync(
    transcript,
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        provider: 'litellm',
        model: 'claude-opus-5-5',
        usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
      },
    }) + '\n',
  );
  const local = (
    launchPricing?: Parameters<typeof extractRunnerSessionUsage>[0]['launchPricing'],
  ) =>
    extractRunnerSessionUsage({
      slotId: 'slot-1',
      vars: makeVars({
        host: 'localhost',
        machine: 'localhost',
        projectName: '',
        machineEnv: vars.machineEnv,
      }),
      runner: 'pi',
      runnerSessionPath: transcript,
      launchPricing,
    });
  const legacy = await local({ environment: async () => launchMutation });
  assert.equal(legacy.totalTokens, 1100);
  assert.equal(legacy.costUsd, 0.006);
  const mixed = await local({ unverified: true, environment: async () => launchMutation });
  assert.equal(mixed.totalTokens, 1100);
  assert.equal(mixed.costUsd, null);
  assert.equal(mixed.costStatus, 'unpriced');
  // Other runners keep their command unchanged.
  calls.length = 0;
  await extractRunnerSessionUsage({
    slotId: 'slot-1',
    vars,
    runner: 'codex',
    runnerSessionPath: '/worker/codex.jsonl',
  });
  assert.equal(String(calls[0][1]).includes('liteLlmPrices"'), false);
  // A gateway with no LiteLLM prices leaves the slot's own lookup as it was.
  calls.length = 0;
  await extractRunnerSessionUsage({
    slotId: 'slot-1',
    vars: makeVars({
      host: 'remote.example',
      machine: 'remote-test',
      projectName: '',
      // Isolated from any LiteLLM configuration the test process inherits.
      machineEnv: { LITELLM_URL: '', LITELLM_BASE_URL: '', LITELLM_API_KEY: '' },
    }),
    runner: 'pi',
    runnerSessionPath: '/worker/pi.jsonl',
  });
  assert.equal(String(calls[0][1]).includes('liteLlmPrices"'), false);
});

test('successful limited receipts keep fresh totals and skip stored detail and archive reads', async (t) => {
  const vars = { host: 'remote.example', machine: 'remote-test', resourceVars: {} } as SlotVars;
  const sessions = ['/worker/remote.jsonl', '/worker/sibling.jsonl'].map(
    (runnerSessionPath, index) => ({
      contextId: 'dev',
      runnerSessionId: String(index),
      runnerSessionPath,
    }),
  );
  t.mock.method(claudeSessionUsageProvider, 'recoverSessions', async () => sessions);
  const archive = t.mock.method(
    claudeSessionUsageProvider,
    'recoverArchive',
    async () => undefined,
  );
  const totalsOnly = {
    attribution: 'issuedAt',
    toolCalls: 5,
    compactions: 1,
    toolCallsByName: { shell: 5 },
    toolCallsBeforeFirstMark: null,
    untimedToolCalls: 0,
    steps: [],
  };
  result = {
    stdout: `turns=1\ntotal_tokens=9\ncost_usd=0.02\nmodel=remote-priced-model\ntool_usage=${JSON.stringify(totalsOnly)}\nreceipt_detail_limited=yes\n`,
    stderr: '',
    exitCode: 0,
  };
  const run = makeRun({
    flowType: 'dev',
    slotId: 'remote-test',
    metrics: { nudgeCount: 0, runner: 'claude', model: 'claude-opus-5-5' },
  });
  const detail = {
    ...totalsOnly,
    attribution: 'issuedAt' as const,
    toolCallsBeforeFirstMark: 5,
    steps: [
      {
        segment: 'before-first-mark' as const,
        startedAt: '2026-11-19T00:00:00.000Z',
        endedAt: '2026-11-19T00:00:01.000Z',
        wallMs: 1000,
        stepNumber: 1,
        title: 'Obsolete checklist row',
        markedAt: '2026-11-19T00:00:01.000Z',
        toolCalls: 5,
        toolCallsByName: { shell: 5 },
        totalTokens: 9,
      },
    ],
  };
  run.sessionUsage = sessions.map((session) => ({
    runner: 'claude',
    runnerSessionPath: session.runnerSessionPath,
    runnerSessionId: session.runnerSessionId,
    measuredAt: '2026-11-19T00:00:00.000Z',
    source: 'runner-transcript',
    scope: 'session-total',
    totalTokens: 9,
    costUsd: 0.02,
    actualModel: 'remote-priced-model',
    toolUsage: detail,
  }));
  for (let read = 0; read < 2; read++) {
    const usage = await extractRunWorkerSessionUsage(run, vars);
    assert.equal(usage?.totalTokens, 18);
    assert.equal(usage?.actualModel, 'remote-priced-model');
    assert.equal(usage?.costUsd, 0.04);
    assert.equal(usage?.toolUsage?.toolCalls, 10);
    assert.deepEqual(usage?.toolUsage?.steps, []);
    assert.equal(usage?.toolUsage?.toolCallsBeforeFirstMark, null);
    assert.match(usage?.captureGaps?.[0] ?? '', /exceeds the remote receipt limit/);
  }
  assert.equal(archive.mock.callCount(), 0);
});

import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import type { RunTicketData } from '@farmslot/protocol';

// F327: a ticket titled DO NOT MERGE must keep the marker in its run branch. Run 9819c7bf's
// Extension slug lost it, and a Terminal worker renamed its branch to add it back.
let llmSlug: string | undefined;
const llm = await import('../llm/index.js');
mock.module('../llm/index.js', {
  namedExports: {
    ...llm,
    callLLM: async () => {
      if (llmSlug === undefined) throw new Error('no model in this fixture');
      return {
        text: JSON.stringify({ summary: 'Summary', branchSlug: llmSlug }),
        usage: { provider: 'fixture', model: 'fixture', durationMs: 0 },
      };
    },
  },
});
const llmConfig = await import('../llm/config.js');
mock.module('../llm/config.js', {
  namedExports: {
    ...llmConfig,
    getLLMConfig: () => ({
      ...llmConfig.getLLMConfig(),
      intelligenceModel: 'fixture',
      defaultProvider: 'fixture',
    }),
  },
});
const { buildSmartBranch, generateSummary } = await import('./engine.js');

// The branch format the Extension, Mobile and Terminal packs share.
const PACK_FORMAT = '{{ticket}}-{{type}}-{{slug}}{{variant_suffix}}';
const ticket = (title: string): RunTicketData => ({
  source: 'jira',
  title,
  description: '',
  acceptanceCriteria: [],
  affectedArea: '',
  stepsToReproduce: [],
  screenshots: [],
  labels: [],
});
const slugFor = async (title: string) => (await generateSummary(ticket(title), 'dev')).branchSlug;

beforeEach(() => {
  llmSlug = undefined;
});

test('the 9819c7bf title keeps DO NOT MERGE although the model slug dropped it', async () => {
  llmSlug = 'adr58-poc-eth-perps-banner';
  const slug = await slugFor(
    ' [ADR58 POC - DO NOT MERGE] Extension: show debug banner after Perps order creation',
  );
  assert.equal(slug, 'do-not-merge-adr58-poc-eth-per');
  assert.equal(
    buildSmartBranch('dev', 'TAT-3216', slug, undefined, null, PACK_FORMAT),
    'TAT-3216-feat-do-not-merge-adr58-poc-eth-per',
  );
});

test('a Terminal title keeps the marker on the fallback slug too', async () => {
  const slug = await slugFor('Terminal: chart order lines for native orders (DO NOT MERGE)');
  assert.equal(slug, 'do-not-merge-terminal-chart-or');
  assert.equal(
    buildSmartBranch('dev', 'TAT-4211', slug, undefined, null, PACK_FORMAT),
    'TAT-4211-feat-do-not-merge-terminal-chart-or',
  );
});

test('every spelling of the marker becomes one canonical segment, never twice', async () => {
  llmSlug = 'chart-order-lines';
  for (const title of [
    '[DO NOT MERGE] Chart order lines',
    'DO-NOT-MERGE: chart order lines',
    'do_not_merge chart order lines',
    'Chart order lines [Do Not Merge]',
    '[DNM] Chart order lines',
    'DNM: chart order lines',
    'DO.NOT.MERGE chart order lines',
    'DO_NOT_MERGE_POC chart order lines',
    'Chart order lines - do not merge',
    'Do Not Merge: chart order lines',
    'do not merge. Chart order lines',
    'Temp PR, do not merge, chart order lines',
    '[POC - do not merge] Chart order lines',
    'Chart order lines. Do not merge.',
    ' Do Not Merge: chart order lines',
  ])
    assert.equal(await slugFor(title), 'do-not-merge-chart-order-lines', title);
  llmSlug = 'poc-do-not-merge-banner';
  assert.equal(await slugFor('PoC banner - DO NOT MERGE'), 'do-not-merge-poc-banner');
});

test('the fallback slug carries the marker once for joined and short spellings', async () => {
  llmSlug = undefined;
  for (const title of ['DO_NOT_MERGE: chart order lines', '[DNM] Chart order lines'])
    assert.equal(await slugFor(title), 'do-not-merge-chart-order-lines', title);
});

test('a sentence that says do not merge is not a marker', async () => {
  llmSlug = 'orders-position-row';
  for (const title of [
    'Perps: do not merge TP/SL orders with the position row',
    'Do not merge duplicate token balances',
    'Token rows do not merge',
    'Do not merge-commit release branches',
  ])
    assert.equal(await slugFor(title), 'orders-position-row', title);
});

test('a slug built from such a sentence loses the words', async () => {
  llmSlug = undefined;
  assert.equal(await slugFor('Do not merge duplicate token balances'), 'duplicate-token-b');
  assert.equal(
    await slugFor('Perps: do not merge TP/SL orders with the position row'),
    'perps-tpsl-orders',
  );
  assert.equal(await slugFor('Token rows do not merge'), 'token-rows');
  llmSlug = 'do-not-merge-duplicate-rows';
  assert.equal(await slugFor('Do not merge duplicate rows'), 'duplicate-rows');
});

test('the marker survives the default branch shape and its truncation', async () => {
  llmSlug = 'a-very-long-slug-that-fills-every-character';
  const slug = await slugFor('[DO NOT MERGE] Mobile: long title');
  assert.equal(
    buildSmartBranch('fix-bug', 'TAT-1234', slug),
    'fix/tat-1234-do-not-merge-a-very-long-slug',
  );
});

test('a title without the marker keeps its slug as generated', async () => {
  llmSlug = 'chart-order-lines';
  assert.equal(await slugFor('Chart order lines'), 'chart-order-lines');
  llmSlug = undefined;
  assert.equal(
    await slugFor('Do not show merge conflicts twice'),
    'do-not-show-merge-conflicts-tw',
  );
});

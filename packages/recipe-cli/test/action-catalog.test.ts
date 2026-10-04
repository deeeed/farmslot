import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actionCapabilityMatrix,
  actionCategory,
  type CatalogAction,
  findRelatedActions,
  fuzzyResolveActions,
  missingActionCapabilities,
  resolveActionCapabilityRefusal,
  searchActions,
  shortActionNames,
  summarizeActionCategories,
} from '../src/index.js';

const action = (name: string, fields: string[], description: string): CatalogAction => ({
  name,
  category: actionCategory(name, ['metamask']),
  fields,
  description,
});

const actions = [
  action('ui.press', ['selector'], 'Press a UI target.'),
  action('wait', ['duration_ms'], 'Wait for a fixed interval.'),
  action('metamask.wallet.select_account', ['address', 'name'], 'Select a wallet account.'),
  action('metamask.wallet.list_accounts', ['scope'], 'List redacted accounts.'),
];
const names = (entries: readonly { name: string }[]) => entries.map(({ name }) => name);

test('actionCategory groups official actions by role and vendor actions by domain', () => {
  assert.equal(actionCategory('metamask.perps.open_position', ['metamask']), 'perps');
  assert.equal(actionCategory('metamask.perps.open_position'), 'metamask');
  assert.equal(actionCategory('app.lifecycle'), 'runtime');
  assert.equal(actionCategory('cdp.target'), 'runtime');
  assert.equal(actionCategory('ui.press'), 'ui');
  assert.equal(actionCategory('assert_text'), 'assertion');
  assert.equal(actionCategory('watch_logs'), 'evidence');
  assert.equal(actionCategory('call'), 'control');
  assert.equal(actionCategory('shop.checkout'), 'shop');
  assert.equal(actionCategory('screenshot'), 'utility');
});

test('fuzzyResolveActions resolves exact names, short names and partial short names by tier', () => {
  assert.deepEqual(names(fuzzyResolveActions(actions, 'metamask.wallet.list_accounts')), [
    'metamask.wallet.list_accounts',
  ]);
  assert.deepEqual(names(fuzzyResolveActions(actions, 'list_accounts')), [
    'metamask.wallet.list_accounts',
  ]);
  assert.deepEqual(names(fuzzyResolveActions(actions, 'account')), [
    'metamask.wallet.select_account',
    'metamask.wallet.list_accounts',
  ]);
});

test('shortActionNames keeps only unambiguous final segments', () => {
  assert.deepEqual(
    [...shortActionNames(['a.open', 'b.open', 'a.close', 'wait'])],
    [
      ['a.open', null],
      ['b.open', null],
      ['a.close', 'close'],
      ['wait', 'wait'],
    ],
  );
});

test('searchActions ranks names, fields, descriptions and categories and tolerates typos', () => {
  const wallet = names(searchActions(actions, 'wallet account'));
  assert.ok(wallet.includes('metamask.wallet.select_account'));
  assert.ok(wallet.includes('metamask.wallet.list_accounts'));
  assert.equal(searchActions(actions, 'selct account')[0]?.name, 'metamask.wallet.select_account');
  assert.equal(searchActions(actions, 'selector')[0]?.name, 'ui.press');
  assert.deepEqual(searchActions(actions, 'wallet nothing-like-this'), []);
  assert.deepEqual(searchActions(actions, '  '), []);
});

test('related actions and categories are deterministic', () => {
  const selected = actions.find(({ name }) => name.endsWith('select_account'))!;
  assert.ok(findRelatedActions(actions, selected).includes('metamask.wallet.list_accounts'));
  assert.deepEqual(summarizeActionCategories(actions), [
    { name: 'control', count: 1 },
    { name: 'ui', count: 1 },
    { name: 'wallet', count: 2 },
  ]);
});

test('the capability matrix compares adapters and explains what one adapter lacks', () => {
  const matrix = actionCapabilityMatrix([
    { adapter: 'mobile', actions: [actions[0]!, actions[2]!] },
    { adapter: 'web', actions: [action('ui.press', ['button'], ''), actions[1]!] },
  ]);
  assert.deepEqual(matrix, [
    {
      name: 'metamask.wallet.select_account',
      category: 'wallet',
      description: 'Select a wallet account.',
      fields: ['address', 'name'],
      support: { mobile: 'available', web: 'unavailable' },
      satisfyingAdapters: ['mobile'],
    },
    {
      name: 'ui.press',
      category: 'ui',
      description: 'Press a UI target.',
      fields: ['button', 'selector'],
      support: { mobile: 'available', web: 'available' },
      satisfyingAdapters: ['mobile', 'web'],
    },
    {
      name: 'wait',
      category: 'control',
      description: 'Wait for a fixed interval.',
      fields: ['duration_ms'],
      support: { mobile: 'unavailable', web: 'available' },
      satisfyingAdapters: ['web'],
    },
  ]);
  assert.deepEqual(resolveActionCapabilityRefusal('select_account', 'web', matrix), {
    capability: 'metamask.wallet.select_account',
    satisfyingAdapters: ['mobile'],
  });
  assert.equal(resolveActionCapabilityRefusal('select_account', 'mobile', matrix), undefined);
  assert.equal(resolveActionCapabilityRefusal('unknown', 'web', matrix), undefined);
  assert.deepEqual(missingActionCapabilities('mobile', ['wait', 'wait', 'ui.press', 'x'], matrix), [
    { capability: 'wait', satisfyingAdapters: ['web'] },
  ]);
});

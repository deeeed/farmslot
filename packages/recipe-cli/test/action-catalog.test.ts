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
  // 'wallet' scores 100 (category) for both; 'account' is a name term (80) of select_account but
  // only a substring (70) of list_accounts.
  assert.deepEqual(names(searchActions(actions, 'wallet account')), [
    'metamask.wallet.select_account',
    'metamask.wallet.list_accounts',
  ]);
  // Equal scores sort by name.
  assert.deepEqual(names(searchActions(actions, 'wallet')), [
    'metamask.wallet.list_accounts',
    'metamask.wallet.select_account',
  ]);
  assert.equal(searchActions(actions, 'selct account')[0]?.name, 'metamask.wallet.select_account');
  assert.equal(searchActions(actions, 'selector')[0]?.name, 'ui.press');
  assert.deepEqual(searchActions(actions, 'wallet nothing-like-this'), []);
  assert.deepEqual(searchActions(actions, '  '), []);
});

test('related actions rank by category, then shared name terms, then name', () => {
  const related = [
    action('metamask.perps.open_position', [], ''),
    action('metamask.perps.close_position', [], ''),
    action('metamask.perps.read_account', [], ''),
    action('metamask.perps.start_session', [], ''),
    action('metamask.wallet.open_position_sheet', [], ''),
    action('metamask.wallet.close_all', [], ''),
    action('metamask.perps.cancel_order', [], ''),
    action('metamask.perps.edit_order', [], ''),
    action('ui.position_badge', [], ''),
  ];
  // Same category +100, each shared name term +30: close_position 130, the other perps actions
  // 100 (by name), open_position_sheet 60 and position_badge 30 fall past the default limit of 5.
  assert.deepEqual(findRelatedActions(related, related[0]!), [
    'metamask.perps.close_position',
    'metamask.perps.cancel_order',
    'metamask.perps.edit_order',
    'metamask.perps.read_account',
    'metamask.perps.start_session',
  ]);
  assert.deepEqual(findRelatedActions(related, related[0]!, 2), [
    'metamask.perps.close_position',
    'metamask.perps.cancel_order',
  ]);
  // A generic operation term ('close') counts 5, a specific one ('position') 30: position_badge
  // outranks close_all, which would win the name tie-break if both counted 30.
  const closePosition = related[1]!;
  assert.deepEqual(findRelatedActions([closePosition, related[5]!, related[8]!], closePosition), [
    'ui.position_badge',
    'metamask.wallet.close_all',
  ]);
});

test('categories are counted and sorted', () => {
  assert.deepEqual(summarizeActionCategories(actions), [
    { name: 'control', count: 1 },
    { name: 'ui', count: 1 },
    { name: 'wallet', count: 2 },
  ]);
});

test('the capability matrix compares adapters and explains what one adapter lacks', () => {
  const matrix = actionCapabilityMatrix([
    { adapter: 'mobile', actions: [action('ui.press', ['button'], ''), actions[2]!] },
    { adapter: 'web', actions: [actions[0]!, actions[1]!] },
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

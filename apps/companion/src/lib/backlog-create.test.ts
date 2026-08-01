import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BACKLOG_CREATE_DEFAULT_FLOW,
  BACKLOG_CREATE_DEFAULT_SOURCE_KIND,
  COMPANION_PRIMARY_TOUCH_MIN,
  buildBacklogCreateParams,
  normalizeBacklogTitle,
  resolveBacklogProject,
} from './backlog-create';

describe('resolveBacklogProject', () => {
  it('prefers explicit project', () => {
    assert.equal(
      resolveBacklogProject({
        explicitProject: 'farmslot-farm',
        selectedProjects: ['other'],
        availableProjects: ['a', 'b'],
      }),
      'farmslot-farm',
    );
  });

  it('uses single selected filter project', () => {
    assert.equal(
      resolveBacklogProject({
        selectedProjects: ['farmslot-farm'],
        availableProjects: ['farmslot-farm', 'other'],
      }),
      'farmslot-farm',
    );
  });

  it('returns null when multiple projects are selected', () => {
    assert.equal(
      resolveBacklogProject({
        selectedProjects: ['a', 'b'],
        availableProjects: ['a', 'b'],
      }),
      null,
    );
  });

  it('falls back to single available project', () => {
    assert.equal(
      resolveBacklogProject({
        selectedProjects: [],
        availableProjects: ['only-one'],
      }),
      'only-one',
    );
  });
});

describe('buildBacklogCreateParams', () => {
  it('builds a minimal manual candidate item', () => {
    const params = buildBacklogCreateParams({
      project: 'farmslot-farm',
      title: '  Ship catalog HTML  ',
      notes: ' offline report ',
    });
    assert.deepEqual(params, {
      project: 'farmslot-farm',
      title: 'Ship catalog HTML',
      sourceKind: BACKLOG_CREATE_DEFAULT_SOURCE_KIND,
      flowType: BACKLOG_CREATE_DEFAULT_FLOW,
      notes: 'offline report',
      tags: undefined,
      autoDispatch: false,
      status: 'candidate',
    });
  });

  it('rejects empty project and title', () => {
    assert.throws(
      () => buildBacklogCreateParams({ project: '  ', title: 'x' }),
      /Select a project/,
    );
    assert.throws(
      () => buildBacklogCreateParams({ project: 'farmslot-farm', title: '   ' }),
      /Add a title/,
    );
  });
});

describe('touch target tokens', () => {
  it('keeps primary touch targets at least 44pt', () => {
    assert.equal(normalizeBacklogTitle('  a  b  '), 'a b');
    assert.ok(COMPANION_PRIMARY_TOUCH_MIN >= 44);
  });
});

import { strict as assert } from 'node:assert';
import test from 'node:test';

import { resolveSlotViewOpenFilePath } from './slot-view-file-navigation-model.js';

test('resolveSlotViewOpenFilePath returns requested path when index is empty or exact', () => {
  assert.equal(resolveSlotViewOpenFilePath([], 'src/app.ts'), 'src/app.ts');
  assert.equal(resolveSlotViewOpenFilePath(['src/app.ts'], 'src/app.ts'), 'src/app.ts');
});

test('resolveSlotViewOpenFilePath prefers exact suffix matches', () => {
  assert.equal(
    resolveSlotViewOpenFilePath(['packages/ui/src/app.ts', 'src/other.ts'], 'src/app.ts'),
    'packages/ui/src/app.ts',
  );
});

test('resolveSlotViewOpenFilePath resolves extensionless imports with common suffixes', () => {
  assert.equal(
    resolveSlotViewOpenFilePath(
      ['src/components/Button.tsx', 'src/components/Button/index.ts'],
      'src/components/Button',
    ),
    'src/components/Button.tsx',
  );
  assert.equal(
    resolveSlotViewOpenFilePath(['src/components/Card/index.tsx'], 'src/components/Card'),
    'src/components/Card/index.tsx',
  );
});

test('resolveSlotViewOpenFilePath uses fuzzy suffix fallback before returning original', () => {
  assert.equal(
    resolveSlotViewOpenFilePath(['packages/ui/components/Dialog.ts'], 'components/Dialog'),
    'packages/ui/components/Dialog.ts',
  );
  assert.equal(resolveSlotViewOpenFilePath(['src/app.ts'], 'missing/file'), 'missing/file');
});

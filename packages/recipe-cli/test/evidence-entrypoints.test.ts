import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

test('the shared evidence validator bundles for browser consumers', async () => {
  const sdk = fileURLToPath(new URL('../../adapter-sdk/src/evidence.ts', import.meta.url));
  const result = await build({
    stdin: {
      contents: `export { validateRecordedEvidencePackage } from ${JSON.stringify(sdk)};`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  assert.ok(result.outputFiles[0]?.text.includes('validateRecordedEvidencePackage'));
  assert.ok(
    Object.keys(result.metafile.inputs).every((file) => !file.endsWith('/read-package.ts')),
  );
});

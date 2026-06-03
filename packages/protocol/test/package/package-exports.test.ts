import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  exports: Record<string, unknown>;
};

const exportSubpaths = Object.keys(packageJson.exports).sort();

assert.equal(
  exportSubpaths.some((subpath) => subpath.endsWith('.js')),
  false,
);
assert.equal(
  exportSubpaths.some((subpath) => subpath.includes('*')),
  false,
);
assert.equal(exportSubpaths.includes('./types'), false);
assert.equal(exportSubpaths.includes('./methods'), false);
assert.equal(exportSubpaths.includes('./recipe-compat'), false);

for (const subpath of exportSubpaths) {
  const specifier =
    subpath === '.' ? '@farmslot/protocol' : `@farmslot/protocol/${subpath.slice(2)}`;
  const moduleExports = (await import(specifier)) as Record<string, unknown>;
  assert.equal(typeof moduleExports, 'object', `${specifier} should import as an object`);
}

for (const required of [
  '.',
  './contracts',
  './contracts/runs',
  './rpc',
  './rpc/run',
  './recipe',
  './surfaces/command-center',
  './transport/events',
]) {
  assert.ok(exportSubpaths.includes(required), `${required} should be exported`);
}

for (const blockedSubpath of [
  '@farmslot/protocol/types',
  '@farmslot/protocol/methods',
  '@farmslot/protocol/recipe-compat',
  '@farmslot/protocol/recipe/common',
  '@farmslot/protocol/recipe/workflow',
  '@farmslot/protocol/recipe/manifest',
]) {
  await assert.rejects(
    import(blockedSubpath),
    /Package subpath|Cannot find module|ERR_PACKAGE_PATH_NOT_EXPORTED/,
    `${blockedSubpath} should not be public`,
  );
}

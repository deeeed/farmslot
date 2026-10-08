// The venue policy fence: a policy module is loaded by path outside the plugin
// loader's import fence, so the host checks it when it binds the adapter.
// Ported from mm-harness's web-dapp-policy-fence tests; the second suite there
// (selecting a plugin through the mm-harness CLI) stays with the host.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { libraryAdapterFiles } from '@farmslot/recipe-runner';

import {
  assertPolicyDigest,
  fencePolicy,
  POLICY_DIGEST_ENV,
  POLICY_ENV,
  PolicyFenceError,
  webDappPolicy,
} from '../src/web-dapp/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_POLICY = path.join(HERE, 'fixtures/web-dapp-policy.mjs');
const MODULE = './plugins/venue/index.mjs';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'policy-fence-')));
  dirs.push(dir);
  return dir;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// A library declaring `venue`, which extends web-dapp; its index hands web-dapp
// `policyModule` (a path) as the venue policy module.
function library(policyModule) {
  const root = tmp();
  write(
    path.join(root, 'recipe-library.json'),
    JSON.stringify({
      adapters: { venue: { module: MODULE, export: 'venueAdapter', extends: 'web-dapp' } },
    }),
  );
  write(
    path.join(root, MODULE),
    `export const venueAdapter = { id: 'venue', sdkVersion: 1, extends: 'web-dapp', policy: { module: ${JSON.stringify(policyModule)} } };\n`,
  );
  return root;
}

// As the host fences a bound policy: against the real paths of the files the
// plugin digest covers.
async function fenced(root, file) {
  const files = await libraryAdapterFiles(root, { module: MODULE });
  const covered = new Set(files.map((entry) => fs.realpathSync(path.join(root, entry))));
  return fencePolicy({ file, covered, scope: 'plugins/venue/ and actions/' });
}

describe('web-dapp venue policy fence', () => {
  it('accepts a policy in the plugin directory and digests it with what it imports', async () => {
    const root = library('');
    const policy = write(
      path.join(root, 'plugins/venue/policy.mjs'),
      "import { venue } from './venue.mjs';\nimport { join } from 'node:path';\nimport fs from 'fs';\nexport const policy = { venue, join, fs };\n",
    );
    write(
      path.join(root, 'plugins/venue/venue.mjs'),
      "export { rule as venue } from '../../actions/shared/rule.mjs';\n",
    );
    const rule = write(path.join(root, 'actions/shared/rule.mjs'), 'export const rule = 1;\n');
    const digest = await fenced(root, policy);
    assert.match(digest, /^[0-9a-f]{64}$/u);
    // A file the policy reaches through an import is part of the digest.
    fs.writeFileSync(rule, 'export const rule = 2;\n');
    assert.notEqual(await fenced(root, policy), digest);
  });

  it('refuses a policy outside the files the plugin digest covers', async () => {
    const outside = write(path.join(tmp(), 'outside-policy.mjs'), 'export const policy = {};\n');
    const root = library(outside);
    await assert.rejects(fenced(root, outside), PolicyFenceError);
    await assert.rejects(
      fenced(root, outside),
      /outside the files the plugin digest covers \(plugins\/venue\/ and actions\//u,
    );
    // Inside the library is not enough: the digest covers the module's directory and actions/ only.
    const sibling = write(
      path.join(root, 'plugins/other/policy.mjs'),
      'export const policy = {};\n',
    );
    await assert.rejects(fenced(root, sibling), /outside the files the plugin digest covers/u);
  });

  it('refuses a policy whose import leaves the digested files, through a path or a symlink', async () => {
    const root = library('');
    const outside = write(path.join(tmp(), 'helper.mjs'), 'export const helper = 1;\n');
    const viaPath = write(
      path.join(root, 'plugins/venue/policy.mjs'),
      `import { helper } from '${path.relative(path.join(root, 'plugins/venue'), outside)}';\nexport const policy = { helper };\n`,
    );
    await assert.rejects(
      fenced(root, viaPath),
      /helper\.mjs is outside the files the plugin digest covers/u,
    );
    fs.symlinkSync(outside, path.join(root, 'plugins/venue/linked.mjs'));
    const viaLink = write(
      path.join(root, 'plugins/venue/policy.mjs'),
      "import { helper } from './linked.mjs';\nexport const policy = { helper };\n",
    );
    // The loader's own listing refuses a plugin file that links out of the library.
    await assert.rejects(fenced(root, viaLink), /linked\.mjs resolves outside its library root/u);
  });

  it("follows the loader's file list through symlinks: a linked entry covers only itself, a linked helper in actions/ counts", async () => {
    // The declared entry is a symlink into another directory: the digest covers
    // the entry, not the directory it points into.
    const root = library('');
    fs.rmSync(path.join(root, MODULE));
    write(path.join(root, 'other/index.mjs'), 'export const venueAdapter = {};\n');
    const policy = write(path.join(root, 'other/policy.mjs'), 'export const policy = {};\n');
    fs.symlinkSync('../../other/index.mjs', path.join(root, MODULE));
    await assert.rejects(
      fenced(root, policy),
      /other\/policy\.mjs is outside the files the plugin digest covers/u,
    );
    // An actions/ file linked to a helper inside the library is digested under its link.
    const root2 = library('');
    write(path.join(root2, 'shared/rule.mjs'), 'export const rule = 1;\n');
    fs.mkdirSync(path.join(root2, 'actions'), { recursive: true });
    fs.symlinkSync('../shared/rule.mjs', path.join(root2, 'actions/rule.mjs'));
    const viaActions = write(
      path.join(root2, 'plugins/venue/policy.mjs'),
      "export { rule as policy } from '../../actions/rule.mjs';\n",
    );
    assert.match(await fenced(root2, viaActions), /^[0-9a-f]{64}$/u);
  });

  it('refuses package and computed imports, which it cannot place in the digest', async () => {
    const root = library('');
    const file = path.join(root, 'plugins/venue/policy.mjs');
    write(file, "import lodash from 'lodash';\nexport const policy = { lodash };\n");
    await assert.rejects(
      fenced(root, file),
      /imports 'lodash', which is neither a node built-in nor a relative path/u,
    );
    write(file, "const name = './venue.mjs';\nexport const policy = await import(name);\n");
    await assert.rejects(fenced(root, file), /computed specifier/u);
    write(
      file,
      "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const policy = require(process.env.X);\n",
    );
    await assert.rejects(fenced(root, file), /computed specifier/u);
    // A comment or a `.resolve` call is not an import.
    write(
      file,
      "// import x from 'lodash'\nimport { createRequire } from 'node:module';\nexport const where = (p) => createRequire(p).resolve('next/package.json');\nexport const policy = {};\n",
    );
    assert.match(await fenced(root, file), /^[0-9a-f]{64}$/u);
  });

  it('refuses a bound policy whose files changed since the host digested them', async () => {
    const root = library('');
    const file = write(
      path.join(root, 'plugins/venue/policy.mjs'),
      fs.readFileSync(FIXTURE_POLICY, 'utf8'),
    );
    const digest = await fenced(root, file);
    assert.doesNotThrow(() => assertPolicyDigest(file, digest));
    // As a leaf process does: load the policy the host bound, after it changed.
    fs.appendFileSync(file, '\n// edited after the bind\n');
    assert.throws(
      () => webDappPolicy({ [POLICY_ENV]: file, [POLICY_DIGEST_ENV]: digest }),
      /changed since the host bound it/u,
    );
    assert.equal(
      typeof webDappPolicy({ [POLICY_ENV]: file, [POLICY_DIGEST_ENV]: await fenced(root, file) })
        .adapterId,
      'string',
    );
  });

  it('refuses, in the process that loads it, an import the scan cannot see that leaves the digested files', async () => {
    const root = library('');
    const fixture = fs.readFileSync(FIXTURE_POLICY, 'utf8');
    const aliased =
      "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\n";
    write(path.join(root, 'outside.cjs'), "module.exports = { marker: 'outside' };\n");
    // An aliased require passes the host's scan, then loads a file no digest covers.
    const atLoad = write(
      path.join(root, 'plugins/venue/policy.mjs'),
      aliased +
        fixture.replace(
          "testnetVariable: 'NEXT_PUBLIC_HYPERLIQUID_FORCE_TESTNET'",
          "testnetVariable: load('../../outside.cjs').marker",
        ),
    );
    const digest = await fenced(root, atLoad);
    assert.throws(
      () => webDappPolicy({ [POLICY_ENV]: atLoad, [POLICY_DIGEST_ENV]: digest }),
      /imports '\.\.\/\.\.\/outside\.cjs', which resolves to .*outside\.cjs: outside the policy files the host digested/u,
    );
    // Later, while the process runs, too: even a file in the plugin's directory,
    // when the policy's digest doesn't cover it.
    write(path.join(root, 'plugins/venue/late.cjs'), 'module.exports = 1;\n');
    const later = write(
      path.join(root, 'plugins/venue/later.mjs'),
      aliased +
        fixture.replace(
          'export const policy = Object.freeze({',
          "export const policy = Object.freeze({\n  late: () => load('./late.cjs'),",
        ),
    );
    const policy = webDappPolicy({
      [POLICY_ENV]: later,
      [POLICY_DIGEST_ENV]: await fenced(root, later),
    });
    assert.throws(() => policy.late(), PolicyFenceError);
  });
});

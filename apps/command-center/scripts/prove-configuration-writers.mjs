import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.cwd(), root);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
const fixture = JSON.parse(await readFile(process.env.FARMSLOT_DOMAIN_PROOF_SETUP, 'utf8'));
const owner = JSON.parse(await readFile(process.env.FARMSLOT_SLOT_RESOURCE_PROOF, 'utf8'));
assert.equal(fixture.home, owner.home);
assert.equal(fixture.farm, owner.root);
assert.notEqual(fixture.farm, root);
const artifacts = path.resolve(process.env.FARMSLOT_DOMAIN_PROOF_ARTIFACTS);
await mkdir(artifacts, { recursive: true });
const cdpFile = path.join(root, 'apps/command-center/scripts/cdp.mjs');
const probe = path.join(root, 'apps/command-center/scripts/probes/configuration-writers.js');
const cdp = async (...args) =>
  JSON.parse(
    (
      await execute(process.execPath, [cdpFile, ...args], {
        timeout: 65000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout,
  );
const rpc = (method, params = {}) => cdp('gateway', method, JSON.stringify(params));
let tab;
async function navigate(hash) {
  const url = new URL(process.env.FARMSLOT_UI_URL);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.port, process.env.VITE_PORT);
  url.searchParams.set('config-writers', path.basename(path.dirname(artifacts)));
  url.hash = hash;
  await cdp('goto', url.href);
  const pages = (await cdp('tabs')).filter(
    (p) =>
      p.type === 'page' &&
      p.url.startsWith(url.origin) &&
      new URL(p.url).searchParams.get('config-writers') === url.searchParams.get('config-writers'),
  );
  assert.equal(pages.length, 1);
  tab = `@${pages[0].id}`;
}
const inspect = () => cdp('eval', tab, '--file', probe);
async function until(check, label) {
  const deadline = Date.now() + 12000;
  let value;
  do {
    value = await inspect();
    if (check(value)) return value;
    await delay(80);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
const revision = (value, method) =>
  value.observations[method]?.resourceState?.dependencies.find(
    (x) => x.key.family === 'configuration',
  )?.revision;
const screenshot = (name) => cdp('screenshot', tab, path.join(artifacts, `${name}.png`));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const originals = new Map();
const backups = new Set();
const produced = new Map();
const evidence = {};
const claims = {};
async function remember(file) {
  if (originals.has(file)) return;
  assert(
    file.startsWith(`${fixture.home}/`) || file === path.join(fixture.farm, '.farm-status.json'),
  );
  try {
    originals.set(file, { bytes: await readFile(file), mode: (await stat(file)).mode & 0o777 });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    originals.set(file, null);
  }
}
async function commit(file, bytes) {
  await remember(file);
  await writeFile(file, bytes, { mode: 0o600 });
  produced.set(file, hash(bytes));
}
function backup(reply) {
  assert.equal(path.dirname(reply.backup), path.dirname(owner.poolFile));
  assert(path.basename(reply.backup).startsWith(`${path.basename(owner.poolFile)}.bak.`));
  backups.add(reply.backup);
}
const failures = [];
try {
  await remember(owner.poolFile);
  await remember(path.join(fixture.farm, '.farm-status.json'));
  const pool = JSON.parse(originals.get(owner.poolFile).bytes);
  const slot = pool.slots.find((s) => s.id === owner.slotId);
  assert(slot);
  for (const name of await readdir(path.dirname(owner.poolFile)))
    if (name.startsWith(`${path.basename(owner.poolFile)}.bak.`))
      await remember(path.join(path.dirname(owner.poolFile), name));
  await navigate(`config/pool/${pool.machine}`);
  const before = await until(
    (v) =>
      v.observations?.['config.pools']?.ready && v.poolSlots.some((s) => s.slotId === owner.slotId),
    'Mount the actual pool slot',
  );
  const enabled = slot.enabled === false;
  const changed = await rpc('config.slot.update', { slotId: owner.slotId, update: { enabled } });
  assert.equal(changed.ok, true);
  for (const name of await readdir(path.dirname(owner.poolFile)))
    if (
      name.startsWith(`${path.basename(owner.poolFile)}.bak.`) &&
      !originals.has(path.join(path.dirname(owner.poolFile), name))
    )
      backups.add(path.join(path.dirname(owner.poolFile), name));
  produced.set(owner.poolFile, hash(await readFile(owner.poolFile)));
  evidence.poolStructured = await until(
    (v) =>
      v.connectionId === before.connectionId &&
      revision(v, 'config.pools') > revision(before, 'config.pools') &&
      v.poolSlots.some(
        (s) =>
          s.slotId === owner.slotId &&
          s.enabled === enabled &&
          s.title === (enabled ? 'Disable slot' : 'Enable slot'),
      ),
    'A real slot configuration write must update the actual structured pool controls',
  );
  await screenshot('pool-structured-update');
  claims.poolStructuredWriter = true;
  await cdp('click', tab, '.cp-pool-header > button');
  const editor = await until(
    (v) => v.editor && !v.editor.dirty,
    'Open the actual clean pool JSON editor',
  );
  evidence.poolEditorBefore = editor;
  const replacement = JSON.parse(await readFile(owner.poolFile, 'utf8'));
  replacement.slots.find((s) => s.id === owner.slotId).enabled = !enabled;
  const raw = JSON.stringify(replacement, null, 3) + '\n';
  const written = await rpc('config.pool.update', { machine: pool.machine, content: raw });
  backup(written);
  produced.set(owner.poolFile, hash(await readFile(owner.poolFile)));
  evidence.poolEditor = await until(
    (v) =>
      v.connectionId === editor.connectionId &&
      v.editor?.value === raw &&
      !v.editor.dirty &&
      v.observations?.['config.pool.raw']?.ready &&
      revision(v, 'config.pool.raw') > revision(editor, 'config.pool.raw'),
    'An external pool write must update the actual clean raw editor through its canonical observer',
  );
  await screenshot('pool-clean-editor-update');
  const draft = raw + '\n';
  await cdp('fill', tab, '.cp-json-editor', draft);
  await until(
    (v) => v.editor?.dirty && v.editor.value === draft,
    'Type a real unsaved raw pool draft',
  );
  const again = await rpc('config.pool.update', { machine: pool.machine, content: raw + ' ' });
  backup(again);
  const committedAgain = await readFile(owner.poolFile, 'utf8');
  produced.set(owner.poolFile, hash(Buffer.from(committedAgain)));
  evidence.poolWriter = { requested: raw + ' ', committed: committedAgain };
  evidence.poolDraft = await until(
    (v) =>
      v.editor?.dirty &&
      v.editor.value === draft &&
      v.observations?.['config.pool.raw']?.ready &&
      revision(v, 'config.pool.raw') > revision(evidence.poolEditor, 'config.pool.raw') &&
      v.observations['config.pool.raw'].data.raw === committedAgain,
    'Pool invalidation must preserve the real unsaved draft while updating its observation',
  );
  await screenshot('pool-dirty-draft-retained');
  claims.poolEditorWriter = true;

  const template = path.join(
    process.env.FARMSLOT_PROJECTS_DIR,
    fixture.project,
    'templates/worker/dev.md',
  );
  await remember(template);
  await mkdir(path.dirname(template), { recursive: true });
  const first = `# Template before ${randomUUID()}\n`;
  const after = `# Template after ${randomUUID()}\n`;
  await commit(template, first);
  await navigate(`config/project/${fixture.project}`);
  await until((v) => v.observations?.['config.projects']?.ready, 'Mount the project');
  await cdp('click', tab, '.cp-pool-header .tab-group button:nth-child(2)');
  await until(
    (v) => v.observations?.['config.templates']?.ready,
    'Observe the actual template collection',
  );
  await cdp('click', tab, 'template-viewer >>> .tab-group button:nth-child(2)');
  const templateBefore = await until(
    (v) => v.templates?.raw === first,
    'Render the actual template bytes',
  );
  const temporary = `${template}.writer-tmp`;
  await writeFile(temporary, after, { flag: 'wx' });
  await rename(temporary, template);
  produced.set(template, hash(Buffer.from(after)));
  evidence.template = await until(
    (v) =>
      v.connectionId === templateBefore.connectionId &&
      v.templates?.raw === after &&
      revision(v, 'config.templates') > revision(templateBefore, 'config.templates'),
    'Atomic template replacement must update the mounted raw preview without Refresh',
  );
  await screenshot('template-external-replacement');
  claims.templateWriter = true;

  const auth = path.join(fixture.home, 'auth-profiles.json');
  await remember(auth);
  const source = originals.get(auth)
    ? JSON.parse(originals.get(auth).bytes)
    : { version: 1, profiles: {} };
  const provider = ['google', 'anthropic', 'openai'].find(
    (name) => !Object.values(source.profiles).some((p) => p.provider === name),
  );
  assert(provider, 'Select an unused provider in the private fixture');
  const id = `d07-${randomUUID()}`;
  const canary = `D07_PRIVATE_${randomUUID()}`;
  await navigate('config/llm');
  const authBefore = await until(
    (v) => v.observations?.['llm.auth.list']?.ready,
    'Mount actual provider registration',
  );
  await commit(
    auth,
    JSON.stringify({
      ...source,
      profiles: { ...source.profiles, [id]: { type: 'api_key', provider, key: canary } },
    }),
  );
  evidence.registration = await until(
    (v) =>
      v.connectionId === authBefore.connectionId &&
      v.observations?.['llm.auth.list']?.ready &&
      revision(v, 'llm.auth.list') > revision(authBefore, 'llm.auth.list') &&
      v.providers?.cards.some((p) => p.storedProfileId === id) &&
      v.providers.text.includes(id),
    'A private registration file write must update the actual provider card without exposing its key',
  );
  assert(!JSON.stringify(evidence.registration).includes(canary));
  await screenshot('provider-registration-external');
  claims.registrationWriter = true;
} catch (error) {
  failures.push(error);
} finally {
  for (const [file, original] of originals) {
    try {
      if (file === path.join(fixture.farm, '.farm-status.json'))
        assert(
          JSON.parse(await readFile(file, 'utf8')).slots.every(
            (slot) => slot.slot === owner.slotId,
          ),
          'Only restore the owned single-slot status fixture',
        );
      if (produced.has(file))
        assert.equal(
          hash(await readFile(file)),
          produced.get(file),
          'Refuse to overwrite a foreign fixture change',
        );
      if (original) {
        await writeFile(file, original.bytes);
        await chmod(file, original.mode);
      } else await rm(file, { force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  for (const file of backups)
    if (!originals.has(file)) {
      try {
        assert.equal(
          JSON.parse(await readFile(file, 'utf8')).machine,
          JSON.parse(originals.get(owner.poolFile).bytes).machine,
        );
        await rm(file);
      } catch (error) {
        failures.push(error);
      }
    }
  await writeFile(
    path.join(artifacts, 'configuration-writers-receipt.json'),
    JSON.stringify({ claims, evidence, failures: failures.map((e) => e.message) }, null, 2),
  );
}
if (failures.length)
  throw new AggregateError(failures, 'Configuration writer proof or cleanup failed');
console.log(JSON.stringify(claims));

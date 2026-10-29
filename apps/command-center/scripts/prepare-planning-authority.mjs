// Read actual isolated ownership/project facts. No product state or client store is seeded.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.cwd(), root);
const manifest = JSON.parse(await readFile(process.env.FARMSLOT_SLOT_RESOURCE_PROOF, 'utf8'));
const farm = await realpath(process.env.FARMSLOT_ROOT);
const home = await realpath(process.env.FARMSLOT_HOME);
assert.notEqual(farm, root);
assert.equal(await realpath(manifest.sourceRoot), root);
assert.equal(await realpath(manifest.root), farm);
assert.equal(await realpath(manifest.home), home);
const target = await automationGatewayTarget();
assert.equal(new URL(target.url).hostname, '127.0.0.1');
assert.equal(new URL(target.url).port, '7913');
const project = process.env.FARMSLOT_PLANNING_RACE_PROJECT;
assert(project && project === manifest.project);
const socket = new WebSocket(target.url);
try {
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Actual fixture-read deadline')), 10000);
    const finish = (error, value) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    let principal;
    socket.once('error', () => finish(new Error('Isolated fixture transport failed')));
    socket.once('open', () =>
      socket.send(
        JSON.stringify({
          type: 'req',
          id: 'setup-auth',
          method: 'auth.connect',
          params: { ...target.credential, clientKind: 'ui', clientName: 'planning-fixture-read' },
        }),
      ),
    );
    socket.on('message', (raw) => {
      try {
        const frame = JSON.parse(String(raw));
        if (frame.id === 'setup-auth') {
          assert(frame.ok && frame.payload.principal.roles.some((row) => row.role === 'admin'));
          principal = frame.payload.principal;
          socket.send(
            JSON.stringify({
              type: 'req',
              id: 'setup-projects',
              method: 'config.projects',
              params: {},
              resourceRead: { version: 1 },
            }),
          );
        } else if (frame.id === 'setup-projects') {
          assert(frame.ok && frame.resourceState?.epoch);
          assert(frame.payload.projects.some((row) => row.name === project));
          finish(undefined, {
            principal,
            method: 'config.projects',
            resourceState: frame.resourceState,
            payloadSha256: createHash('sha256').update(JSON.stringify(frame.payload)).digest('hex'),
            completedAt: Date.now(),
          });
        }
      } catch (error) {
        finish(error);
      }
    });
  });
  const output = path.resolve(process.env.FARMSLOT_DOMAIN_PROOF_SETUP);
  assert(!output.startsWith(root + '/'));
  await writeFile(
    output,
    JSON.stringify({
      setupComplete: true,
      farm,
      home,
      sourceRoot: root,
      ownerId: result.principal.id,
      project,
      created: [],
      actualSetupRead: result,
    }) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(JSON.stringify({ preparedFromActualReads: true, ownerId: result.principal.id }));
} finally {
  socket.close();
}

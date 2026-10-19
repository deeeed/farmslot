// Opt-in real-provider proof. No farm run, slot, publication or retained session is changed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import {
  Methods,
  type NativeCommandReceipt,
  type NativeSessionInfo,
  type NativeSessionReadResult,
  PIPELINE_VISUAL_RESULT_SCHEMA,
} from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

function squarePng(red: boolean): Buffer {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const bytes = Buffer.concat([Buffer.from(type), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(bytes));
    return Buffer.concat([length, bytes, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(128, 0);
  header.writeUInt32BE(128, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(128 * (128 * 3 + 1), 255);
  for (let y = 0; y < 128; y++) {
    const row = y * 385;
    pixels[row] = 0;
    for (let x = 0; x < 128; x++)
      if (x >= 24 && x < 104 && y >= 24 && y < 104) {
        const start = row + 1 + x * 3;
        pixels[start] = red ? 220 : 0;
        pixels[start + 1] = red ? 0 : 170;
        pixels[start + 2] = 0;
      }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test(
  'real native provider returns bound visual results through the authenticated gateway',
  { timeout: 300_000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-visual-result-'));
    const state = path.join(root, 'native');
    process.env.FARMSLOT_NATIVE_STATE_DIR = state;
    process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
    process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
    process.env.NODE_TEST_CONTEXT = '1';
    const server = createServer();
    let wss: import('ws').WebSocketServer | undefined;
    const sessions: string[] = [];
    let client: import('../../../../packages/cli/src/gateway-client.js').GatewayClient | undefined;
    t.after(async () => {
      const failures: unknown[] = [];
      const attempt = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      };
      if (client)
        for (const sessionId of sessions)
          await attempt(() => client!.call(Methods.NATIVE_SESSION_CLOSE, { sessionId }));
      if (wss) {
        for (const connection of wss.clients) connection.terminate();
        await attempt(() => new Promise<void>((resolve) => wss!.close(() => resolve())));
      }
      if (server.listening)
        await attempt(
          () =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        );
      let hostStopped = false;
      await attempt(async () => {
        const hostText = await readFile(path.join(state, 'host.json'), 'utf8').catch(
          (error: unknown) => {
            // Failed imports or admission can finish before a proof host is created.
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
              return undefined;
            throw error;
          },
        );
        if (!hostText) {
          hostStopped = true;
          return;
        }
        const host = JSON.parse(hostText);
        const command = execFileSync('ps', ['-p', String(host.pid), '-o', 'command='], {
          encoding: 'utf8',
        });
        assert.ok(command.includes(state), 'Only the host launched for this proof may be stopped');
        process.kill(host.pid, 'SIGTERM');
        const deadline = Date.now() + 10_000;
        while (true) {
          let alive = true;
          try {
            process.kill(host.pid, 0);
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
              throw error;
            alive = false;
          }
          if (!alive) break;
          assert.ok(Date.now() < deadline, 'The owned proof host did not stop');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        hostStopped = true;
      });
      if (hostStopped) await attempt(() => rm(root, { force: true, recursive: true }));
      if (failures.length) throw new AggregateError(failures, 'Owned native proof cleanup failed');
    });
    const { createGatewayAuthRuntime } = await import('../security/auth.js');
    const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'auth') });
    const person = runtime.writer.createPrincipal(
      { type: 'person', displayName: 'Isolated visual proof' },
      [{ role: 'admin', scope: { kind: 'global' } }],
    );
    process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = person.id;
    const credential = runtime.writer.issueCredential(person.id, 'Disposable proof');
    const grant = runtime.writer.exchangePersonCredential(credential.secret, {
      deviceName: 'Loopback native proof',
      deviceKind: 'cli',
    });
    const { createWebSocketServer } = await import('../server.js');
    const { GatewayClient } = await import('../../../../packages/cli/src/gateway-client.js');
    wss = createWebSocketServer(server, runtime);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    client = new GatewayClient({
      url: `ws://127.0.0.1:${address.port}/ws`,
      timeout: 60_000,
      credential: { token: grant.accessToken },
    });
    const runner = process.env.FARMSLOT_VISUAL_REVIEW_RUNNER ?? 'codex';
    const receipts = [];
    for (const red of [true, false]) {
      const cwd = path.join(root, randomUUID());
      await mkdir(cwd);
      execFileSync('git', ['init', '--quiet'], { cwd });
      const image = squarePng(red);
      await writeFile(path.join(cwd, 'square.png'), image);
      const digest = `sha256:${createHash('sha256').update(image).digest('hex')}`;
      const created: { session: NativeSessionInfo } = await client.call(
        Methods.NATIVE_SESSION_CREATE,
        { runner, cwd, resultSchema: PIPELINE_VISUAL_RESULT_SCHEMA },
      );
      const session: NativeSessionInfo = created.session;
      sessions.push(session.id);
      const commandId = randomUUID();
      await client.call(Methods.NATIVE_SESSION_SEND, {
        sessionId: session.id,
        commandId,
        text: `Inspect square.png with your image tool. Judge this claim: "The centered square is red on a white background." Confirm only if it is red, reject otherwise. Do not change files. Return only the constrained JSON with schemaVersion 1, recipeRunId "provider-visual-fixture" and one judgment with claimId "red-square", observed verdict/reason, reviewedFiles [{"path":"square.png","digest":"${digest}"}], moments [].`,
      });
      let snapshot: NativeSessionReadResult | undefined;
      const deadline = Date.now() + 120_000;
      while (
        !snapshot?.commands.some((c) => c.commandId === commandId && c.state === 'completed')
      ) {
        snapshot = await client.call<NativeSessionReadResult>(Methods.NATIVE_SESSION_READ, {
          sessionId: session.id,
          limit: 500,
        });
        assert.notEqual(snapshot.session.state, 'failed', snapshot.session.error);
        assert.ok(Date.now() < deadline, 'The native visual command did not complete');
        if (snapshot.commands.find((c) => c.commandId === commandId)?.state === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(snapshot);
      const command: NativeCommandReceipt = snapshot.commands.find(
        (c) => c.commandId === commandId,
      )!;
      assert.equal(command.generation, session.generation);
      assert.equal(command.accepted, true);
      assert.equal(command.structuredResult?.schema, PIPELINE_VISUAL_RESULT_SCHEMA);
      assert.ok(command.structuredResult && !('closureIdentity' in command.structuredResult.value));
      assert.equal(
        command.structuredResult?.value.judgments[0]?.verdict,
        red ? 'confirmed' : 'rejected',
      );
      assert.ok(
        snapshot.events.some(
          (event) =>
            event.tool &&
            JSON.stringify(event.data ?? event.tool.input ?? '').includes('square.png'),
        ),
        'A structured image-tool invocation must be observed',
      );
      receipts.push({
        sessionId: session.id,
        generation: session.generation,
        commandId,
        digest,
        result: command.structuredResult,
      });
    }
    if (process.env.FARMSLOT_VISUAL_RESULT_RECEIPT)
      await writeFile(
        process.env.FARMSLOT_VISUAL_RESULT_RECEIPT,
        JSON.stringify(
          {
            runner,
            status: 'pass',
            scope:
              'real provider visual result transport; pipeline authority has separate contract checks',
            receipts,
          },
          null,
          2,
        ),
      );
  },
);

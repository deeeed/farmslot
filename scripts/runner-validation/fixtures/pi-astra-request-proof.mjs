// Private gateway proof: record only model/effort/tool count, never headers or prompts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const config = process.env.FARMSLOT_PI_ASTRA_PROOF;
if (config && Number(process.env.FARMSLOT_PI_ASTRA_GATEWAY_PID) === process.pid) {
  assert.ok(config.includes('/temp/native-validation/'));
  fs.writeFileSync(`${config}.${process.pid}.loaded`, '', { mode: 0o600 });
  const providerForUrl = (value) => {
    const url = new URL(value);
    if (url.origin === 'http://127.0.0.1:2455' && url.pathname === '/v1/responses')
      return 'codex-lb';
    if (url.hostname === 'chatgpt.com' && url.pathname === '/backend-api/codex/responses')
      return 'openai-codex';
    return undefined;
  };
  const observe = (body, transport, provider) => {
    if (!fs.existsSync(config)) return;
    const target = JSON.parse(fs.readFileSync(config, 'utf8'));
    if (target.gatewayPid !== process.pid || body.model !== 'gpt-6-astra') return;
    const proof = {
      gatewayPid: process.pid,
      provider,
      model: body.model,
      effort: body.reasoning?.effort,
      tools: body.tools?.length ?? 0,
      transport,
      store: body.store,
    };
    fs.appendFileSync(`${config}.requests`, JSON.stringify(proof) + '\n', { mode: 0o600 });
    assert.equal(
      provider,
      target.provider ?? 'openai-codex',
      'Astra used another provider endpoint',
    );
    assert.equal(proof.effort, 'low', 'Astra request omitted configured low effort');
    assert.equal(proof.tools, 0, 'Intelligence smoke must not expose tools');
  };
  const send = globalThis.WebSocket?.prototype.send;
  if (send)
    globalThis.WebSocket.prototype.send = function (data, ...args) {
      const provider = providerForUrl(this.url);
      if (provider && typeof data === 'string') observe(JSON.parse(data), 'websocket', provider);
      return send.call(this, data, ...args);
    };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    const provider = providerForUrl(input instanceof Request ? input.url : String(input));
    if (provider) {
      const request = new Request(input instanceof Request ? input.clone() : input, init);
      const body = Buffer.from(await request.arrayBuffer());
      if (body.length) {
        const text =
          request.headers.get('content-encoding') === 'zstd'
            ? zstdDecompressSync(body).toString('utf8')
            : body.toString('utf8');
        observe(JSON.parse(text), 'sse', provider);
      }
    }
    return originalFetch(input, init);
  };
}

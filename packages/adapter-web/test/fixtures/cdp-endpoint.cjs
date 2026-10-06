'use strict';

const http = require('node:http');

const { WebSocketServer } = require('ws');

// A browser CDP endpoint in process: /json/version, then WebSocket clients
// whose commands are recorded and answered by `answer(message)` (an object
// result, or an Error for a CDP error). `emit` sends an event to every client.
async function startCdpEndpoint(answer) {
  const server = http.createServer((_req, res) => {
    res.end(
      JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/x`,
      }),
    );
  });
  const wss = new WebSocketServer({ server });
  const calls = [];
  const emit = (method, params = {}, sessionId) => {
    for (const client of wss.clients) {
      client.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
    }
  };
  wss.on('connection', (socket) =>
    socket.on('message', async (raw) => {
      const message = JSON.parse(String(raw));
      calls.push(message);
      const result = await answer(message, emit);
      socket.send(
        JSON.stringify(
          result instanceof Error
            ? { id: message.id, error: { message: result.message } }
            : { id: message.id, result: result ?? {} },
        ),
      );
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    calls,
    emit,
    clients: () => wss.clients.size,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(resolve);
      }),
  };
}

module.exports = { startCdpEndpoint };

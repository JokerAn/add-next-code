import http from 'node:http';

export async function startFakeFimServer() {
  const requests = [];
  let reply = { text: '42;', delayMs: 10 };
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const buffers = [];
    for await (const part of req) {
      buffers.push(part);
    }
    const record = { body: JSON.parse(Buffer.concat(buffers).toString()), aborted: false };
    requests.push(record);
    const step = { ...reply };
    res.on('close', () => { record.aborted = !res.writableEnded; });
    setTimeout(() => {
      if (res.destroyed) {
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({
        choices: [{ text: step.text, index: 0, finish_reason: 'stop' }],
      })}\n\ndata: [DONE]\n\n`);
    }, step.delayMs);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/beta/completions`,
    requests,
    setReply(value) { reply = { text: '42;', delayMs: 10, ...value }; },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

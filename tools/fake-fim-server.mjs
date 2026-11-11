#!/usr/bin/env node
// 可控的假 FIM 服务（DeepSeek /beta/completions 的子集），用于集成测试与调参。
// 用法：
//   node tools/fake-fim-server.mjs --port 8787 [--text "foo()"] [--latency 200] [--chunk 4] [--status 200]
//                                  [--script script.json] [--log requests.jsonl]
// script.json 为数组，第 N 个请求使用第 N 项（超出后复用最后一项）：
//   { "status": 200, "latencyMs": 300, "chunkDelayMs": 20, "text": "abc", "chunkSize": 3,
//     "hangAfterChunks": 2,      // 发送若干块后保持连接不再发送（模拟卡住）
//     "dropAfterChunks": 2,      // 发送若干块后直接断开连接
//     "json": true,              // 忽略 stream，返回 application/json
//     "retryAfter": "7",         // 与 429 配合
//     "error": "message" }       // 非 200 时的响应体消息
import http from 'node:http';
import fs from 'node:fs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const port = Number(arg('port', '8787'));
const baseText = arg('text', 'completion()');
const baseLatency = Number(arg('latency', '200'));
const baseChunk = Number(arg('chunk', '4'));
const baseStatus = Number(arg('status', '200'));
const scriptPath = arg('script');
const logPath = arg('log');
const script = scriptPath ? JSON.parse(fs.readFileSync(scriptPath, 'utf8')) : [];

let n = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(entry) {
  const line = JSON.stringify(entry);
  console.log(line);
  if (logPath) {
    fs.appendFileSync(logPath, line + '\n');
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
  }
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // 保持空对象
  }
  const idx = n++;
  const step = script.length > 0 ? script[Math.min(idx, script.length - 1)] : {};
  const status = step.status ?? baseStatus;
  const latency = step.latencyMs ?? baseLatency;
  const text = step.text ?? baseText;
  const size = step.chunkSize ?? baseChunk;
  const chunkDelay = step.chunkDelayMs ?? 0;

  log({
    seq: idx,
    at: Date.now(),
    auth: req.headers.authorization ? 'present' : 'missing', // 不记录 Key 本身
    model: body.model,
    promptChars: (body.prompt ?? '').length,
    suffixChars: body.suffix == null ? null : body.suffix.length,
    maxTokens: body.max_tokens,
    stop: body.stop ?? null,
    stream: body.stream === true,
  });

  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  await sleep(latency);
  if (closed) {
    log({ seq: idx, event: 'client-closed-before-response' });
    return;
  }

  if (status !== 200) {
    const headers = { 'content-type': 'application/json' };
    if (step.retryAfter) {
      headers['retry-after'] = String(step.retryAfter);
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify({ error: { message: step.error ?? `fake error ${status}` } }));
    return;
  }

  if (step.json || body.stream !== true) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'fake', object: 'text_completion', choices: [{ text, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1 } }));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const pieces = [];
  for (let i = 0; i < text.length; i += size) {
    pieces.push(text.slice(i, i + size));
  }
  let sent = 0;
  for (const p of pieces) {
    if (closed) {
      log({ seq: idx, event: 'client-closed-mid-stream', sent });
      return;
    }
    if (step.dropAfterChunks !== undefined && sent >= step.dropAfterChunks) {
      res.destroy();
      log({ seq: idx, event: 'dropped', sent });
      return;
    }
    if (step.hangAfterChunks !== undefined && sent >= step.hangAfterChunks) {
      log({ seq: idx, event: 'hanging', sent });
      return; // 不结束响应
    }
    res.write(`data: ${JSON.stringify({ id: 'fake', object: 'text_completion', choices: [{ text: p, index: 0, finish_reason: null }] })}\n\n`);
    sent++;
    if (chunkDelay) {
      await sleep(chunkDelay);
    }
  }
  res.write(`data: ${JSON.stringify({ id: 'fake', object: 'text_completion', choices: [{ text: '', index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: pieces.length, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 56 } })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  console.error(`fake FIM server: http://127.0.0.1:${port}/beta/completions`);
});

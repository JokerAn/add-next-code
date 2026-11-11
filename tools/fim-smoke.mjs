#!/usr/bin/env node
// 阶段 0.2 / 0.3 / 0.4：直连 FIM 接口做连通性与测量。
// API Key 只从环境变量 DEEPSEEK_API_KEY 读取，绝不通过命令行参数传入（避免进入 shell 历史）。
//
// 用法：
//   DEEPSEEK_API_KEY=sk-... node tools/fim-smoke.mjs connect
//   DEEPSEEK_API_KEY=sk-... node tools/fim-smoke.mjs stop
//   DEEPSEEK_API_KEY=sk-... node tools/fim-smoke.mjs length   [--max-chars 128000]
//   DEEPSEEK_API_KEY=sk-... node tools/fim-smoke.mjs cache
//   DEEPSEEK_API_KEY=sk-... node tools/fim-smoke.mjs errors
//   DEEPSEEK_API_KEY=sk-... node tools/fim-smoke.mjs header --file <源文件> --line <0 基行号> --col <列> [--header "<注释文本>"]
// 可选：--endpoint <url> 或环境变量 FIM_ENDPOINT（默认 https://api.deepseek.com/beta/completions）、--model <name>（默认 deepseek-flash）
import fs from 'node:fs';

const [mode = 'connect', ...rest] = process.argv.slice(2);
function opt(name, def) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : def;
}
const endpoint = opt('endpoint', process.env.FIM_ENDPOINT ?? 'https://api.deepseek.com/beta/completions');
const model = opt('model', 'deepseek-flash');
const key = process.env.DEEPSEEK_API_KEY;

if (!key && mode !== 'errors') {
  console.error('请先设置环境变量 DEEPSEEK_API_KEY');
  process.exit(2);
}

async function call({ prompt, suffix, maxTokens = 64, stop, apiKey = key, mdl = model, temperature = 0.2, stream = true }) {
  const body = { model: mdl, prompt, suffix: suffix === '' ? null : suffix, max_tokens: maxTokens, temperature, stream };
  if (stream) {
    body.stream_options = { include_usage: true };
  }
  if (stop) {
    body.stop = stop;
  }
  const t0 = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify(body),
  });
  const out = { status: res.status, contentType: res.headers.get('content-type'), retryAfter: res.headers.get('retry-after'), headerMs: Date.now() - t0 };
  if (!res.ok) {
    out.body = (await res.text()).slice(0, 400);
    out.totalMs = Date.now() - t0;
    return out;
  }
  if (!stream) {
    const j = await res.json();
    out.text = j.choices?.[0]?.text;
    out.finish = j.choices?.[0]?.finish_reason;
    out.usage = j.usage;
    out.totalMs = Date.now() - t0;
    return out;
  }
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  const rawLines = [];
  for await (const chunk of res.body) {
    if (out.firstByteMs === undefined) {
      out.firstByteMs = Date.now() - t0;
    }
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') continue;
      if (rawLines.length < 6) rawLines.push(line.slice(0, 240));
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        text += j.choices?.[0]?.text ?? '';
        if (j.choices?.[0]?.finish_reason) out.finish = j.choices[0].finish_reason;
        if (j.usage) out.usage = j.usage;
      } catch {
        // 忽略无法解析的行
      }
    }
  }
  out.totalMs = Date.now() - t0;
  out.text = text;
  out.rawFirstLines = rawLines;
  return out;
}

const show = (title, v) => console.log(`\n=== ${title}\n${JSON.stringify(v, null, 2)}`);

const SAMPLE_PREFIX = '<script>\nexport default {\n  data() {\n    return { list: [], loading: false };\n  },\n  methods: {\n    async fetchList() {\n      this.loading = true;\n      const res = await ';
const SAMPLE_SUFFIX = ';\n      this.list = res.data;\n      this.loading = false;\n    },\n  },\n};\n</script>\n';

if (mode === 'connect') {
  show('流式：SSE 原始首行、finish、usage、首字节/总耗时', await call({ prompt: SAMPLE_PREFIX, suffix: SAMPLE_SUFFIX }));
  show('非流式（对照）', await call({ prompt: SAMPLE_PREFIX, suffix: SAMPLE_SUFFIX, stream: false }));
} else if (mode === 'stop') {
  show('stop 未设置', await call({ prompt: 'const a = 1;\nconst b = ', suffix: '\nconst c = 3;', maxTokens: 64 }));
  show('stop = ["\\n"]（单行模式）', await call({ prompt: 'const a = 1;\nconst b = ', suffix: ';\nconst c = 3;', maxTokens: 64, stop: ['\n'] }));
} else if (mode === 'length') {
  // 输入上限：逐步加长 prompt，直到报错。每步一次请求，请留意费用。
  const maxChars = Number(opt('max-chars', '128000'));
  const unit = '// filler line for length probing: const value = compute(items, options);\n';
  for (let chars = 1000; chars <= maxChars; chars *= 2) {
    const prompt = unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars) + 'const result = ';
    const r = await call({ prompt, suffix: ';\n', maxTokens: 16 });
    console.log(JSON.stringify({ chars, status: r.status, firstByteMs: r.firstByteMs, totalMs: r.totalMs, promptTokens: r.usage?.prompt_tokens, err: r.body?.slice(0, 160) }));
    if (r.status !== 200) break;
  }
} else if (mode === 'cache') {
  const prompt = ('// stable prefix for cache probing\n' + 'const value = compute(items, options);\n'.repeat(120)) + 'const next = ';
  show('第 1 次', (({ text, usage, totalMs }) => ({ text, usage, totalMs }))(await call({ prompt, suffix: ';\n', maxTokens: 16 })));
  await new Promise((r) => setTimeout(r, 1500));
  show('第 2 次（相同前缀，观察 prompt_cache_hit_tokens 是否非零）', (({ text, usage, totalMs }) => ({ text, usage, totalMs }))(await call({ prompt, suffix: ';\n', maxTokens: 16 })));
} else if (mode === 'errors') {
  show('假 Key', await call({ prompt: 'a', suffix: 'b', apiKey: 'sk-invalid-key-for-testing' }));
  if (key) {
    show('错误模型名', await call({ prompt: 'a', suffix: 'b', mdl: 'no-such-model' }));
    show('超大 max_tokens', await call({ prompt: 'a', suffix: 'b', maxTokens: 999999 }));
  } else {
    console.log('（未设置 DEEPSEEK_API_KEY，跳过错误模型名与超大 max_tokens）');
  }
} else if (mode === 'header') {
  const file = opt('file');
  const line = Number(opt('line'));
  const col = Number(opt('col'));
  if (!file || Number.isNaN(line) || Number.isNaN(col)) {
    console.error('header 模式需要 --file <路径> --line <行号(0基)> --col <列>');
    process.exit(2);
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const cur = lines[line] ?? '';
  const before = [...lines.slice(Math.max(0, line - 150), line), cur.slice(0, col)].join('\n');
  const after = [cur.slice(col), ...lines.slice(line + 1, line + 40)].join('\n');
  const header = opt('header', '// [context] reference only, not part of this file\n// file: sample (vue2)\n// members: methods: fetchList, onSearch\n// [/context]\n').replace(/\\n/g, '\n');
  const stop = /\S/.test(cur.slice(col).replace(/[)\]}>'"`;,\s]/g, '')) ? ['\n'] : undefined;
  show('无头部', (({ text, finish, usage, totalMs }) => ({ text, finish, usage, totalMs }))(await call({ prompt: before, suffix: after, stop })));
  show('有头部（检查是否出现 [context]、是否把头部内容续写进结果）', (({ text, finish, usage, totalMs }) => ({ text, finish, usage, totalMs }))(await call({ prompt: header + before, suffix: after, stop })));
} else {
  console.error('未知模式：', mode);
  process.exit(2);
}

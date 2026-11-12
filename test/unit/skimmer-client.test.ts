import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkimmerClient, type SkimmerOptions } from '../../src/core/skimmer/client';
import { skimmerEnvironment } from '../../src/core/skimmer/environment';
import { parseCompletionContext, type CompletionContextRequest } from '../../src/core/skimmer/protocol';
import type { SkimmerQueryRecord } from '../../src/core/metrics';

const fake = vi.hoisted(() => ({
  exec: vi.fn(async (_command: string, _args: string[], _options: { env: Record<string, string> }) => ({ stdout: 'v24.21.0\n' })),
  mkdir: vi.fn(async (): Promise<void> => undefined),
  clients: [] as Array<{
    onclose?: () => void;
    close: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
  }>,
  transports: [] as unknown[],
  connect: vi.fn(async () => undefined),
  close: vi.fn(async (): Promise<void> => undefined),
  tools: vi.fn(async () => ({ tools: [{ name: 'skimmer_get_completion_context' }] })),
  call: vi.fn(),
}));

vi.mock('node:util', async (original) => ({
  ...await original<typeof import('node:util')>(), promisify: () => fake.exec,
}));
vi.mock('node:fs/promises', () => ({ mkdir: fake.mkdir }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    onclose?: () => void;
    constructor() {
      fake.clients.push(this);
    }
    connect = fake.connect;
    listTools = fake.tools;
    getServerVersion = () => ({ version: 'test' });
    callTool = vi.fn((...args: unknown[]) => fake.call(...args));
    close = vi.fn(async () => {
      await fake.close();
      this.onclose?.();
    });
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async (original) => ({
  ...await original<typeof import('@modelcontextprotocol/sdk/client/stdio.js')>(),
  StdioClientTransport: class {
    stderr = { on() {} };
    constructor(options: unknown) {
      fake.transports.push(options);
    }
  },
}));

function payload(state = 'ready', overlay = 'ready') {
  return {
    protocol: 1, framework: 'vue2', overlay: { state: overlay }, index: { state },
    self: { members: [{ kind: 'methods', name: 'load' }], truncated: false },
    related: [], dropped: [], elapsedMs: 1,
  };
}
function result(state = 'ready') {
  return { structuredContent: payload(state) };
}
const input: CompletionContextRequest = {
  protocol: 1, project_path: '/project', file_path: '/project/App.vue',
  document: { text: '<script>export default {}</script>' },
  cursor: { line: 0, character: 0 }, identifiers: [], dirty_files: [],
  max_items: 8, budget_chars: 2000, deadline_ms: 500,
};
let client: SkimmerClient;
let options: SkimmerOptions;
let status: ReturnType<typeof vi.fn<(text: string) => void>>;
let onQuery: ReturnType<typeof vi.fn<(record: SkimmerQueryRecord) => void>>;

async function ready(): Promise<void> {
  client.ensureStarted();
  await vi.advanceTimersByTimeAsync(0);
  expect(client.ready).toBe(true);
}
function indexCalls() {
  return fake.call.mock.calls.filter(([args]) => args.name === 'skimmer_index_project');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fake.clients.length = 0;
  fake.transports.length = 0;
  fake.exec.mockResolvedValue({ stdout: 'v24.21.0\n' });
  fake.mkdir.mockResolvedValue(undefined);
  fake.connect.mockResolvedValue(undefined);
  fake.close.mockResolvedValue(undefined);
  fake.tools.mockResolvedValue({ tools: [{ name: 'skimmer_get_completion_context' }] });
  fake.call.mockResolvedValue(result());
  options = { enabled: true, command: 'npx', args: ['-y', 'test'], nodePath: 'node', cacheDir: '/cache' };
  status = vi.fn();
  onQuery = vi.fn();
  client = new SkimmerClient({ options: () => options, status, log: vi.fn(), onIndexChanged: vi.fn(), onQuery });
});
afterEach(async () => {
  await client.dispose();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Skimmer 客户端', () => {
  it('握手成功只表示连接可用，不提前报告摘要就绪', async () => {
    await ready();
    expect(status).toHaveBeenLastCalledWith('已连接，等待上下文');
  });

  it('激活不启动子进程；I18 每次查询携带全文，重启后仍可直接查询', async () => {
    expect(fake.exec).not.toHaveBeenCalled();
    await ready();
    await client.query(input, Date.now() + 500);
    await client.query({ ...input, document: { text: 'changed' } }, Date.now() + 500);
    await client.restart();
    await ready();
    // 模拟文档重开、编辑器版本回退；协议只依赖本次全文。
    await client.query({ ...input, document: { text: 'reopened' } }, Date.now() + 500);
    const calls = fake.call.mock.calls.filter(([args]) => args.name === 'skimmer_get_completion_context');
    expect(calls.map(([args]) => args.arguments.document.text)).toEqual([
      input.document.text, 'changed', 'reopened',
    ]);
    expect(fake.clients).toHaveLength(2);
  });

  it('I16 进程退出后十分钟内不重启，到期才可重连', async () => {
    await ready();
    fake.clients[0]!.onclose?.();
    client.ensureStarted();
    await vi.advanceTimersByTimeAsync(599_999);
    client.ensureStarted();
    expect(fake.clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await ready();
    expect(fake.clients).toHaveLength(2);
  });

  it('I17 缺少补全工具后关闭进程，本会话不重复启动', async () => {
    fake.tools.mockResolvedValue({ tools: [] });
    client.ensureStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.ready).toBe(false);
    expect(fake.clients[0]!.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    client.ensureStarted();
    expect(fake.clients).toHaveLength(1);
    expect(await client.query(input, Date.now() + 500)).toBeUndefined();
    expect(fake.call).not.toHaveBeenCalled();
  });

  it('Node 版本不满足时不创建 transport', async () => {
    fake.exec.mockResolvedValue({ stdout: 'v20.0.0' });
    client.ensureStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.transports).toHaveLength(0);
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('Node.js >=22'));
  });

  it('I25 占用状态五分钟内不发索引，释放后立即取消退避并索引', async () => {
    await ready();
    fake.call.mockResolvedValue(result('locked'));
    await client.query(input, Date.now() + 500);
    await vi.advanceTimersByTimeAsync(60_000);
    await client.query(input, Date.now() + 500);
    expect(indexCalls()).toHaveLength(0);
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('仅本文件'));
    fake.call.mockResolvedValue(result('empty'));
    await client.query(input, Date.now() + 500);
    expect(indexCalls()).toHaveLength(1);
  });

  it('仍被占用时，五分钟到期最多重试一次索引', async () => {
    await ready();
    fake.call.mockImplementation(async (args) => args.name === 'skimmer_index_project'
      ? { isError: true } : result('locked'));
    await client.query(input, Date.now() + 500);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await client.query(input, Date.now() + 500);
    await client.query(input, Date.now() + 500);
    expect(indexCalls()).toHaveLength(1);
  });

  it('非锁原因索引失败仍遵守五分钟退避', async () => {
    await ready();
    fake.call.mockImplementation(async (args) => args.name === 'skimmer_index_project'
      ? { isError: true } : result('empty'));
    await client.query(input, Date.now() + 500);
    await client.query(input, Date.now() + 500);
    expect(indexCalls()).toHaveLength(1);
  });

  it('项目被后台回收后，已有数据库但无watcher时重新索引', async () => {
    await ready();
    await client.query(input, Date.now() + 500);
    await vi.advanceTimersByTimeAsync(0);
    expect(indexCalls()).toHaveLength(1);
    const data = payload();
    fake.call.mockImplementation(async (args) => args.name === 'skimmer_index_project'
      ? result() : { structuredContent: { ...data, index: { state: 'ready', watching: false } } });
    await client.query(input, Date.now() + 500);
    expect(indexCalls()).toHaveLength(2);
  });

  it('截止时发出取消信号，连续五次超时暂停一分钟', async () => {
    await ready();
    const signals: AbortSignal[] = [];
    fake.call.mockImplementation((_args, _schema, opts: { signal: AbortSignal }) => {
      signals.push(opts.signal);
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    });
    for (let i = 0; i < 5; i++) {
      const pending = client.query(input, Date.now() + 50);
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toBeUndefined();
    }
    expect(signals).toHaveLength(5);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(await client.query(input, Date.now() + 500)).toBeUndefined();
    expect(fake.call).toHaveBeenCalledTimes(5);
    expect(onQuery).toHaveBeenCalledTimes(5);
    expect(onQuery.mock.calls.every(([record]) => record.outcome === 'timeout' && record.elapsedMs === 50)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    fake.call.mockResolvedValue(result('indexing'));
    expect(await client.query(input, Date.now() + 500)).toBeDefined();
    expect(onQuery).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'ok' }));
  });

  it('等待旧进程关闭后才允许创建新进程，dispose 可等待同一关闭流程', async () => {
    await ready();
    let finish!: () => void;
    fake.close.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const restarting = client.restart();
    await vi.advanceTimersByTimeAsync(0);
    client.ensureStarted();
    expect(fake.clients).toHaveLength(1);
    finish();
    await restarting;
    await ready();
    const disposing = client.dispose();
    await disposing;
    client.ensureStarted();
    expect(fake.clients).toHaveLength(2);
    expect(client.ready).toBe(false);
  });

  it('mkdir 期间禁用或重启不会创建旧 transport', async () => {
    let finish!: () => void;
    fake.mkdir.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    client.ensureStarted();
    await vi.advanceTimersByTimeAsync(0);
    options.enabled = false;
    const restarting = client.restart();
    finish();
    await restarting;
    expect(fake.transports).toHaveLength(0);
  });

  it('查询在重启之后延迟返回时被丢弃', async () => {
    await ready();
    let reply!: (value: unknown) => void;
    fake.call.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
    const pending = client.query(input, Date.now() + 500);
    await client.restart();
    reply(result());
    expect(await pending).toBeUndefined();
    expect(onQuery).toHaveBeenCalledOnce();
    expect(onQuery).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'cancelled' }));
  });

  it('只统计实际补全查询，成功响应保留有界丢弃计数且不包含文件名', async () => {
    expect(await client.query(input, Date.now() + 500)).toBeUndefined();
    expect(onQuery).not.toHaveBeenCalled();
    await ready();
    fake.call.mockResolvedValue({
      structuredContent: {
        ...payload('indexing'), elapsedMs: 12,
        dropped: [
          { file: 'private/Child.vue', reason: 'dirty' }, { file: 'private/barrel.ts', reason: 'stale' },
          { file: 'private/Other.vue', reason: 'dirty' }, { file: 'private/Large.vue', reason: 'budget' },
        ],
      },
    });
    await client.query(input, Date.now() + 500);
    expect(onQuery).toHaveBeenCalledExactlyOnceWith({
      outcome: 'ok', elapsedMs: 0, serverElapsedMs: 12,
      overlay: 'ready', index: 'indexing', selfMembers: 1, relatedItems: 0,
      dropped: { dirty: 2, stale: 1, budget: 1 },
    });
    expect(JSON.stringify(onQuery.mock.calls)).not.toContain('private');
    expect(indexCalls()).toHaveLength(0);
  });

  it('工具报错与不兼容响应计为失败，后续被阻止的调用不重复统计', async () => {
    await ready();
    fake.call.mockResolvedValueOnce({ isError: true });
    await client.query(input, Date.now() + 500);
    expect(onQuery).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'error' }));
    fake.call.mockResolvedValueOnce({ structuredContent: { protocol: 99 } });
    await client.query(input, Date.now() + 500);
    expect(onQuery).toHaveBeenCalledTimes(2);
    expect(onQuery.mock.calls.map(([record]) => record.outcome)).toEqual(['error', 'error']);
    expect(await client.query(input, Date.now() + 500)).toBeUndefined();
    expect(onQuery).toHaveBeenCalledTimes(2);
  });

  it('查询尚在途时跳过的并发调用不算查询次数', async () => {
    await ready();
    let reply!: (value: unknown) => void;
    fake.call.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
    const pending = client.query(input, Date.now() + 500);
    expect(await client.query(input, Date.now() + 500)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(25);
    reply(result('indexing'));
    expect(await pending).toBeDefined();
    expect(onQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'ok', elapsedMs: 25 }));
  });

  it('查询在途时进程意外退出计为失败，主动重启才计为取消', async () => {
    await ready();
    let reject!: (error: Error) => void;
    fake.call.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = client.query(input, Date.now() + 500);
    fake.clients[0]!.onclose?.();
    reject(new Error('connection closed'));
    expect(await pending).toBeUndefined();
    expect(onQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'error' }));
  });

  it('服务端耗时缺失或非法时保留未知，不将它计作零毫秒响应', async () => {
    await ready();
    fake.call.mockResolvedValueOnce({ structuredContent: { ...payload('indexing'), elapsedMs: Number.NaN } });
    await client.query(input, Date.now() + 500);
    expect(onQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'ok', serverElapsedMs: undefined }));
  });

  it.each(['stale', 'failed'])('后台索引完成保留最近一次 $0 摘要状态', async (overlay) => {
    await ready();
    let finishIndex!: (value: unknown) => void;
    fake.call.mockImplementation(async (args) => args.name === 'skimmer_index_project'
      ? new Promise((resolve) => { finishIndex = resolve; }) : result('empty'));
    await client.query(input, Date.now() + 500);
    fake.call.mockResolvedValueOnce({
      structuredContent: { ...payload('indexing', overlay), ...(overlay === 'failed' ? { self: null } : {}) },
    });
    await client.query(input, Date.now() + 500);
    finishIndex({});
    await vi.advanceTimersByTimeAsync(0);
    const message = status.mock.lastCall?.[0] ?? '';
    expect(message).toContain('索引已更新');
    expect(message).toContain(overlay === 'stale' ? '使用旧摘要' : '整文件摘要暂不可用');
    expect(message).not.toContain('就绪');
    expect(onQuery).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: 'ok', overlay, index: 'indexing', selfMembers: overlay === 'failed' ? 0 : 1, relatedItems: 0,
    }));
  });

  it('旧项目的索引完成不覆盖另一个项目的最新查询状态', async () => {
    await ready();
    let finishIndex!: (value: unknown) => void;
    fake.call.mockImplementation(async (args) => args.name === 'skimmer_index_project'
      ? new Promise((resolve) => { finishIndex = resolve; }) : result('empty'));
    await client.query(input, Date.now() + 500);
    fake.call.mockResolvedValueOnce({ structuredContent: { ...payload('indexing', 'failed'), self: null } });
    await client.query({ ...input, project_path: '/other', file_path: '/other/App.vue' }, Date.now() + 500);
    const calls = status.mock.calls.length;
    finishIndex({});
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(calls);
    expect(status.mock.lastCall?.[0]).toContain('整文件摘要暂不可用');
  });

  it.each([
    { self: false, related: false, message: '本次无增强内容，基础补全可用' },
    { self: true, related: false, message: '本文件成员可用' },
    { self: false, related: true, message: '关联接口可用' },
  ])('摘要 failed 时准确说明可用内容：$message', async ({ self, related, message }) => {
    await ready();
    fake.call.mockResolvedValue({
      structuredContent: {
        ...payload('indexing', 'failed'),
        self: self ? payload().self : null,
        related: related ? [{
          kind: 'module', name: 'load', file: 'private/service.ts', binding: 'static',
          fingerprint: { mtimeMs: 1, size: 1 }, interface: [],
        }] : [],
      },
    });
    await client.query(input, Date.now() + 500);
    expect(status.mock.lastCall?.[0]).toContain('整文件摘要暂不可用');
    expect(status.mock.lastCall?.[0]).toContain(message);
    expect(onQuery).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: 'ok', overlay: 'failed', selfMembers: Number(self), relatedItems: Number(related),
    }));
    expect(JSON.stringify(onQuery.mock.calls)).not.toMatch(/private|load/);
  });
});

describe('Skimmer 运行边界', () => {
  it('Node 探测与子进程只继承运行、代理、证书变量，不继承凭据或 SKIMMER 覆盖', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'must-not-forward');
    vi.stubEnv('OPENAI_API_KEY', 'must-not-forward');
    vi.stubEnv('NODE_OPTIONS', '--require=/tmp/unsafe');
    vi.stubEnv('SKIMMER_DB', '/tmp/shared.db');
    vi.stubEnv('SKIMMER_AUTO_INDEX', 'true');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.test');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/certs/dev.pem');
    const env = skimmerEnvironment('/safe-cache', '/tools/node/bin/node');
    expect(env).toMatchObject({
      SKIMMER_CACHE_DIR: '/safe-cache', HTTPS_PROXY: 'http://proxy.test', NODE_EXTRA_CA_CERTS: '/certs/dev.pem',
    });
    expect(env.PATH).toContain('/tools/node/bin');
    for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'SKIMMER_DB', 'SKIMMER_AUTO_INDEX']) {
      expect(env).not.toHaveProperty(key);
    }
    await ready();
    const probeEnv = fake.exec.mock.calls[0]?.[2]?.env;
    const processEnv = (fake.transports[0] as { env: Record<string, string> }).env;
    expect(probeEnv).toEqual(processEnv);
    expect(processEnv).not.toHaveProperty('DEEPSEEK_API_KEY');
  });

  it('不兼容响应被拒绝，启发式或损坏依赖不会进入相关接口', () => {
    expect(() => parseCompletionContext({ protocol: 2 })).toThrow(/protocol=1/);
    const base = {
      kind: 'component', name: 'Child', file: 'Child.vue',
      binding: 'static', interface: [], fingerprint: { mtimeMs: 1, size: 2 },
    };
    const decoded = parseCompletionContext({
      ...payload(), related: [
        { ...base, binding: 'heuristic' },
        { ...base, dependencies: [{ file: 'barrel.ts', fingerprint: { size: -1, mtimeMs: 1 } }] },
        { ...base, dependencies: [{ file: 'barrel.ts', fingerprint: { size: 3, mtimeMs: 1 } }] },
      ],
    });
    expect(decoded.related).toHaveLength(1);
    expect(decoded.related[0]!.dependencies).toHaveLength(1);
  });

  it('解码丢弃原因时拒绝未知与损坏条目，并限制数量和非法服务端耗时', () => {
    const decoded = parseCompletionContext({
      ...payload(),
      elapsedMs: Number.POSITIVE_INFINITY,
      dropped: [
        { file: 'a.vue', reason: 'dirty' }, { file: 'b.ts', reason: 'stale' }, { file: 'c.ts', reason: 'budget' },
        { file: 'secret', reason: 'unknown' }, { file: 123, reason: 'dirty' }, null,
        ...Array.from({ length: 205 }, () => ({ file: 'long'.repeat(2000), reason: 'dirty' })),
      ],
    });
    expect(decoded.dropped.slice(0, 3)).toEqual([
      { file: 'a.vue', reason: 'dirty' }, { file: 'b.ts', reason: 'stale' }, { file: 'c.ts', reason: 'budget' },
    ]);
    expect(decoded.dropped).toHaveLength(197);
    expect(decoded.dropped.at(-1)?.file).toHaveLength(4096);
    expect(decoded.elapsedMs).toBeUndefined();
    expect(parseCompletionContext({ ...payload(), elapsedMs: -1, dropped: null }).dropped).toEqual([]);
    expect(parseCompletionContext({ ...payload(), elapsedMs: -1 }).elapsedMs).toBeUndefined();
  });
});

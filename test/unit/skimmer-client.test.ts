import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkimmerClient, type SkimmerOptions } from '../../src/core/skimmer/client';
import { skimmerEnvironment } from '../../src/core/skimmer/environment';
import { parseCompletionContext, type CompletionContextRequest } from '../../src/core/skimmer/protocol';

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
  client = new SkimmerClient({ options: () => options, status, log: vi.fn(), onIndexChanged: vi.fn() });
});
afterEach(async () => {
  await client.dispose();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Skimmer 客户端', () => {
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
    await vi.advanceTimersByTimeAsync(60_000);
    fake.call.mockResolvedValue(result('indexing'));
    expect(await client.query(input, Date.now() + 500)).toBeDefined();
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
});

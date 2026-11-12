import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { IncompatibleSkimmerError, parseCompletionContext, type CompletionContextRequest, type CompletionContextResponse } from './protocol';
import { skimmerEnvironment } from './environment';
import type { SkimmerQueryRecord } from '../metrics';

const exec = promisify(execFile);

export interface SkimmerOptions {
  enabled: boolean;
  command: string;
  args: string[];
  nodePath: string;
  cacheDir: string;
}

interface Session {
  client: Client;
  transport: StdioClientTransport;
  generation: number;
}

export interface SkimmerClientDeps {
  options(): SkimmerOptions;
  status(text: string): void;
  log(text: string): void;
  /** 服务重启或索引变化后使旧的增强补全缓存失效。 */
  onIndexChanged(): void;
  /** 仅统计实际发出的补全查询，启动、索引和退避跳过均不计入。 */
  onQuery?(record: SkimmerQueryRecord): void;
}

/** 一个扩展窗口一个长期 stdio 连接；握手和首次索引都不阻塞基础补全。 */
export class SkimmerClient {
  private session?: Session;
  private connecting?: Session;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private generation = 0;
  private attempts = 0;
  private retryAt = 0;
  private blocked = false;
  private disposed = false;
  private querying = false;
  private timeouts = 0;
  private queryPauseUntil = 0;
  private readonly indexed = new Set<string>();
  private readonly indexing = new Set<string>();
  private readonly indexRetryAt = new Map<string, number>();
  private readonly lockedProjects = new Set<string>();
  private lastContext?: { project: string; text: string };

  constructor(private readonly d: SkimmerClientDeps) {
    this.d.status(this.d.options().enabled ? '待启动' : '关闭');
  }

  get ready(): boolean {
    return this.session !== undefined;
  }

  ensureStarted(): void {
    if (this.disposed || !this.d.options().enabled || this.session || this.starting || this.closing || this.blocked) {
      return;
    }
    if (Date.now() < this.retryAt || this.attempts >= 3) {
      return;
    }
    this.attempts++;
    const generation = this.generation;
    this.starting = this.start(generation).finally(() => {
      this.starting = undefined;
    });
  }

  private async start(generation: number): Promise<void> {
    const opts = this.d.options();
    const env = skimmerEnvironment(opts.cacheDir, opts.nodePath);
    this.d.status('启动中');
    let session: Session | undefined;
    try {
      let version: string;
      try {
        version = (await exec(opts.nodePath, ['--version'], { timeout: 5000, windowsHide: true, env })).stdout.trim();
      } catch {
        throw new IncompatibleSkimmerError('找不到 Node.js，请配置 skimmer.nodePath');
      }
      if (Number(/^v?(\d+)/.exec(version)?.[1] ?? 0) < 22) {
        throw new IncompatibleSkimmerError('Skimmer 需要 Node.js >=22');
      }
      if (generation !== this.generation || this.disposed) {
        return;
      }
      await fs.mkdir(opts.cacheDir, { recursive: true });
      if (generation !== this.generation || this.disposed) {
        return;
      }
      const transport = new StdioClientTransport({
        command: opts.command, args: opts.args,
        env, stderr: 'pipe',
      });
      // stderr 可能包含项目路径或解析诊断，不转存到常规日志。
      transport.stderr?.on('data', () => {});
      const client = new Client({ name: 'add-next-code', version: '0.0.1' }, { capabilities: {} });
      session = { client, transport, generation };
      this.connecting = session;
      client.onclose = () => {
        if (this.session === session) {
          this.session = undefined;
          this.indexed.clear();
          this.indexing.clear();
          this.indexRetryAt.clear();
          this.lockedProjects.clear();
          this.lastContext = undefined;
          this.retryAt = Date.now() + 10 * 60_000;
          this.d.status('降级：连接断开，稍后重连');
          this.d.onIndexChanged();
        }
      };
      const timeout = this.attempts === 1 ? 120_000 : 20_000;
      await client.connect(transport, { timeout });
      let cursor: string | undefined;
      let found = false;
      for (let page = 0; page < 20 && !found; page++) {
        const tools = await client.listTools(cursor ? { cursor } : {}, { timeout: 10_000 });
        found = tools.tools.some((tool) => tool.name === 'skimmer_get_completion_context');
        cursor = tools.nextCursor;
        if (!cursor) {
          break;
        }
      }
      if (!found) {
        throw new IncompatibleSkimmerError('当前 npm 包缺少补全接口，请使用包含阶段 B 接口的版本或本地构建');
      }
      if (this.disposed || generation !== this.generation) {
        await client.close();
        return;
      }
      this.session = session;
      this.d.log(`[skimmer] 已连接 ${client.getServerVersion()?.version ?? 'unknown'} / Node ${version}`);
      this.d.status('已连接，等待上下文');
    } catch (error) {
      if (session) {
        await session.client.close().catch(() => undefined);
      }
      if (generation !== this.generation || this.disposed) {
        return;
      }
      this.blocked = error instanceof IncompatibleSkimmerError;
      this.retryAt = Date.now() + 10 * 60_000;
      const reason = error instanceof IncompatibleSkimmerError
        ? error.message : '启动失败；请检查命令、网络或 Node.js 安装';
      this.d.status(`降级：${reason}`);
      this.d.log(`[skimmer] ${reason}`);
    } finally {
      if (this.connecting === session) {
        this.connecting = undefined;
      }
    }
  }

  ensureIndex(project: string): void {
    const session = this.session;
    if (!session || this.indexed.has(project) || this.indexing.has(project) ||
      Date.now() < (this.indexRetryAt.get(project) ?? 0)) {
      return;
    }
    this.indexing.add(project);
    this.indexStatus(project, '索引中');
    void session.client.callTool({
      name: 'skimmer_index_project',
      arguments: { project_path: project, respect_gitignore: true },
    }, undefined, { timeout: 30 * 60_000, maxTotalTimeout: 30 * 60_000 }).then((result) => {
      if (this.session !== session) {
        return;
      }
      if (result.isError) {
        this.indexRetryAt.set(project, Date.now() + 5 * 60_000);
        this.indexStatus(project, '索引暂不可用');
      } else {
        this.indexed.add(project);
        this.indexRetryAt.delete(project);
        this.indexStatus(project, '索引已更新');
        this.d.onIndexChanged();
      }
    }).catch(() => {
      if (this.session === session) {
        this.indexRetryAt.set(project, Date.now() + 5 * 60_000);
        this.indexStatus(project, '索引失败，稍后重试');
      }
    }).finally(() => {
      if (this.session === session) {
        this.indexing.delete(project);
      }
    });
  }

  private indexStatus(project: string, text: string): void {
    // 旧项目的后台索引不能覆盖最近一次查询的状态。
    if (!this.lastContext || this.lastContext.project === project) {
      this.d.status(`${text}；${this.lastContext?.text ?? '等待上下文，基础补全可用'}`);
    }
  }

  private contextStatus(project: string, text: string): void {
    this.lastContext = { project, text };
    this.d.status(text);
  }

  async query(input: CompletionContextRequest, deadlineAt: number): Promise<CompletionContextResponse | undefined> {
    this.ensureStarted();
    const session = this.session;
    const remaining = deadlineAt - Date.now();
    if (!session || this.querying || remaining <= 0 || Date.now() < this.queryPauseUntil) {
      return undefined;
    }
    this.querying = true;
    const startedAt = Date.now();
    const record: SkimmerQueryRecord = {
      outcome: 'error', elapsedMs: 0, dropped: { dirty: 0, stale: 0, budget: 0 },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const result = await session.client.callTool({
        name: 'skimmer_get_completion_context', arguments: { ...input },
      }, undefined, { signal: controller.signal, timeout: remaining });
      if (this.session !== session || controller.signal.aborted) {
        return undefined;
      }
      if (result.isError) {
        this.contextStatus(input.project_path, '降级：本次上下文查询失败');
        return undefined;
      }
      const text = Array.isArray(result.content)
        ? result.content.find((part: unknown): part is { type: 'text'; text: string } =>
          typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' &&
          'text' in part && typeof part.text === 'string')
        : undefined;
      const payload: unknown = result.structuredContent ??
        (text?.type === 'text' ? JSON.parse(text.text) as unknown : undefined);
      const data = parseCompletionContext(payload);
      record.outcome = 'ok';
      record.serverElapsedMs = data.elapsedMs;
      record.overlay = data.overlay.state;
      record.index = data.index.state;
      record.selfMembers = data.self?.members.length ?? 0;
      record.relatedItems = data.related.length;
      for (const item of data.dropped) {
        record.dropped[item.reason]++;
      }
      this.timeouts = 0;
      const parts = [
        data.overlay.state === 'ready' ? '当前摘要就绪'
          : data.overlay.state === 'stale' ? '使用旧摘要：本文件摘要暂时滞后' : '整文件摘要暂不可用',
      ];
      if (record.selfMembers > 0) {
        parts.push('本文件成员可用');
      }
      if (data.index.state !== 'locked' && record.relatedItems > 0) {
        parts.push('关联接口可用');
      }
      if (record.selfMembers === 0 && (data.index.state === 'locked' || record.relatedItems === 0)) {
        parts.push('本次无增强内容，基础补全可用');
      }
      this.contextStatus(input.project_path, parts.join('；'));
      if (data.index.state === 'locked') {
        this.lockedProjects.add(input.project_path);
        this.indexed.delete(input.project_path);
        const retryAt = this.indexRetryAt.get(input.project_path);
        if (retryAt === undefined) {
          this.indexRetryAt.set(input.project_path, Date.now() + 5 * 60_000);
        } else if (Date.now() >= retryAt) {
          this.ensureIndex(input.project_path);
        }
        this.indexStatus(input.project_path, '仅本文件：另一窗口占用项目索引');
      } else {
        // 一次成功取得占用的查询即可结束 locked 退避，不再等满五分钟。
        if (this.lockedProjects.delete(input.project_path)) {
          this.indexRetryAt.delete(input.project_path);
        }
        if (data.index.state === 'indexing') {
          this.indexStatus(input.project_path, '索引中');
          return data;
        }
        if (data.index.state === 'empty' || data.index.watching === false) {
          this.indexed.delete(input.project_path);
        }
        this.ensureIndex(input.project_path);
      }
      return data;
    } catch (error) {
      if (this.session !== session) {
        return undefined;
      }
      if (error instanceof IncompatibleSkimmerError) {
        this.blocked = true;
        this.session = undefined;
        await session.client.close().catch(() => undefined);
        this.d.status(`降级：${error.message}`);
      } else if (controller.signal.aborted || Date.now() >= deadlineAt) {
        if (++this.timeouts >= 5) {
          this.queryPauseUntil = Date.now() + 60_000;
          this.timeouts = 0;
          this.contextStatus(input.project_path, '降级：连续超时，暂停查询 60 秒');
        }
      } else {
        this.contextStatus(input.project_path, '降级：本次上下文查询失败');
      }
      return undefined;
    } finally {
      clearTimeout(timer);
      this.querying = false;
      if (this.session !== session && record.outcome !== 'ok') {
        record.outcome = this.generation !== session.generation ? 'cancelled' : 'error';
      } else if (record.outcome !== 'ok' && (controller.signal.aborted || Date.now() >= deadlineAt)) {
        record.outcome = 'timeout';
      }
      record.elapsedMs = Math.max(0, Date.now() - startedAt);
      this.d.onQuery?.(record);
    }
  }

  /** 配置或命令触发；关闭旧会话后，下一次有效补全再懒启动。 */
  async restart(): Promise<void> {
    this.generation++;
    const previous = this.session ?? this.connecting;
    const starting = this.starting;
    this.session = undefined;
    this.connecting = undefined;
    this.attempts = 0;
    this.retryAt = 0;
    this.blocked = false;
    this.timeouts = 0;
    this.queryPauseUntil = 0;
    this.indexed.clear();
    this.indexing.clear();
    this.indexRetryAt.clear();
    this.lockedProjects.clear();
    this.lastContext = undefined;
    const closing = (this.closing ?? Promise.resolve()).then(async () => {
      if (previous) {
        await previous.client.close().catch(() => undefined);
      }
      // Node 探测或 mkdir 阶段还没有 transport，也必须等旧启动任务识别代次变更。
      await starting;
    });
    this.closing = closing;
    await closing;
    if (this.closing !== closing) {
      return;
    }
    this.closing = undefined;
    this.d.onIndexChanged();
    if (!this.disposed) {
      this.d.status(this.d.options().enabled ? '待启动' : '关闭');
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.restart();
  }
}

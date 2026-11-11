// 6.8 总装：不依赖 vscode，可用假时钟与假模型服务做集成级测试。
import { dropEntriesAffectedByChange, type CompletionCache } from './cache';
import type { Collector } from './collector';
import { depsValid, type DepsIo } from './deps';
import type { FimClient, FimResult } from './fim/client';
import { FimError } from './fim/errors';
import { buildFimRequest, modelKeyOf } from './fim/prompt';
import type { HealthState } from './backoff';
import type { Metrics, Outcome, CacheState, CallRecord } from './metrics';
import { postprocess } from './postprocess';
import type { Scheduler } from './scheduler';
import { sleepUntil } from './time';
import type { CancelToken, Config, Header, Position, SelectedInfo, TextSource, TriggerKind } from './types';
import { EMPTY_HEADER } from './types';
import { buildWindow, cursorOf, readPrefix, type WindowResult } from './window';

/** 活文档：版本、光标等在请求期间会变化，每次都要重新读取。 */
export interface LiveDoc {
  readonly key: string;
  readonly languageId: string;
  readonly fileLabel: string;
  readonly source: TextSource;
  version(): number;
  /** 当前活动编辑器是否仍是单光标、空选择区且停在 position */
  cursorIsAt(position: Position): boolean;
}

export interface PipelineRequest {
  doc: LiveDoc;
  position: Position;
  sci?: SelectedInfo;
  trigger: TriggerKind;
  token: CancelToken;
  /** 宿主的运行开关与发送许可，在每个异步边界后重新校验。 */
  isValid?(): boolean;
}

export interface Completion {
  /** 待插入的文本（不含 sci.text） */
  text: string;
}

export interface PipelineDeps {
  cfg(): Config;
  cache: CompletionCache;
  scheduler: Scheduler;
  fim: FimClient;
  collector: Collector;
  depsIo: DepsIo;
  health: HealthState;
  metrics: Metrics;
  log(line: string): void;
  /** 模型请求开始（+1）/ 落定（-1），用于状态栏 */
  onRequest?(delta: 1 | -1): void;
}

export class CompletionPipeline {
  private seq = 0;
  private generation = 0;
  /** 文档 key → 上一次真正发出自动模型请求的时间 */
  private readonly lastAutoSentAt = new Map<string, number>();

  constructor(private readonly d: PipelineDeps) {}

  /** 开关、发送许可或配置变化时，让等待中和在途中的调用一并失效。 */
  invalidate(): void {
    this.generation++;
    this.d.scheduler.abortAll();
  }

  /** 文档关闭时清理 */
  onDocumentClosed(docKey: string): void {
    this.d.cache.dropDoc(docKey);
    this.lastAutoSentAt.delete(docKey);
  }

  /** onDidChangeTextDocument：只做缓存条目筛选，不读取文本 */
  onDocumentChanged(docKey: string, changeStartLines: number[]): void {
    dropEntriesAffectedByChange(this.d.cache, docKey, changeStartLines);
  }

  async run(req: PipelineRequest): Promise<Completion | undefined> {
    const d = this.d;
    const cfg = d.cfg();
    const startedAt = Date.now();
    const seq = ++this.seq;
    const snap = { version: req.doc.version(), epoch: cfg.epoch, generation: this.generation };
    const manual = req.trigger === 'manual';

    const stillValid = (): boolean =>
      !req.token.isCancellationRequested &&
      this.generation === snap.generation &&
      req.isValid?.() !== false &&
      req.doc.version() === snap.version &&
      d.cfg().epoch === snap.epoch &&
      req.doc.cursorIsAt(req.position);

    const rec: CallRecord = {
      seq,
      trigger: req.trigger,
      lang: req.doc.languageId,
      sci: req.sci !== undefined,
      prefixChars: 0,
      suffixChars: 0,
      headerChars: 0,
      cache: 'miss',
      outcome: 'empty',
      requested: false,
    };
    const finish = (outcome: Outcome, cache?: CacheState): undefined => {
      rec.outcome = outcome;
      if (cache) {
        rec.cache = cache;
      }
      rec.tEnd2End = Date.now() - startedAt;
      d.log(d.metrics.record(rec));
      return undefined;
    };
    const done = (text: string, cache?: CacheState): Completion => {
      rec.outcome = 'shown';
      if (cache) {
        rec.cache = cache;
      }
      rec.tEnd2End = Date.now() - startedAt;
      d.log(d.metrics.record(rec));
      return { text };
    };

    // ── 窗口（O(窗口)）与缓存 ──
    const win: WindowResult = buildWindow(req.doc.source, req.position, req.sci, cfg);
    rec.prefixChars = win.prefix.length;
    rec.suffixChars = win.suffix.length;
    const cursor = cursorOf(req.position, req.sci);
    const modelKey = modelKeyOf(cfg);

    const hit = d.cache.lookup({
      docKey: req.doc.key,
      modelKey,
      suffix: win.suffix,
      cursorLine: cursor.before.line,
      readPrefix: (sl, sc, maxChars) => readPrefix(req.doc.source, sl, sc, cursor, maxChars),
    });
    if (hit) {
      if (await depsValid(hit.entry.deps, d.depsIo)) {
        if (!stillValid()) {
          return finish('stale', hit.remainder ? 'remainder' : 'hit');
        }
        return done(hit.text, hit.remainder ? 'remainder' : 'hit');
      }
      d.cache.drop(hit.entry);
    }

    if (!d.health.canRequest(manual)) {
      return finish('backoff');
    }

    // ── 防抖与限频（仅自动触发）──
    const waitStart = Date.now();
    if (!manual) {
      const sendAt = Math.max(
        Date.now() + cfg.debounceMs,
        (this.lastAutoSentAt.get(req.doc.key) ?? 0) + cfg.minIntervalMs,
      );
      await sleepUntil(sendAt, req.token);
      if (!stillValid()) {
        return finish(req.token.isCancellationRequested ? 'cancelled' : 'stale');
      }
    }
    rec.tWait = Date.now() - waitStart;
    // 等待期间健康状态可能变化
    if (!d.health.canRequest(manual)) {
      return finish('backoff');
    }

    // ── 上下文收集：防抖与限频通过之后才开始 ──
    const ctxStart = Date.now();
    const outcome = await d.collector(
      {
        docKey: req.doc.key,
        languageId: req.doc.languageId,
        fileLabel: req.doc.fileLabel,
        source: req.doc.source,
        version: snap.version,
        line: cursor.before.line,
        character: cursor.before.character,
        windowStartLine: win.startLine,
        windowText: win.prefix + win.suffix,
        cfg,
      },
      Date.now() + cfg.extraWaitMs,
    );
    let header: Header = outcome.header;
    rec.framework = outcome.framework;
    rec.region = outcome.region;
    rec.sym = outcome.status['symbols'];
    rec.skimmer = outcome.status['skimmer'];
    rec.tContext = Date.now() - ctxStart;
    rec.headerChars = header.text.length;
    if (!stillValid()) {
      return finish(req.token.isCancellationRequested ? 'cancelled' : 'stale');
    }
    if (!(await depsValid(header.deps, d.depsIo))) {
      // 来源在收集期间变了：本次退回基础模式
      header = EMPTY_HEADER;
      rec.headerChars = 0;
    }
    if (!stillValid()) {
      return finish(req.token.isCancellationRequested ? 'cancelled' : 'stale');
    }

    // ── 发送 ──
    const request = (signal: AbortSignal) => buildFimRequest(win, header, manual, cfg, signal);
    const key = JSON.stringify([modelKey, win.prefix, win.suffix, header.text, manual]);
    if (cfg.dumpPrompts) {
      d.log(`[prompt#${seq}]\n${header.text}${win.prefix}<|cursor|>${win.suffix}`);
    }

    let result: FimResult | undefined;
    try {
      result = await d.scheduler.run(
        key,
        (signal) => {
          rec.requested = true;
          if (!manual) {
            this.lastAutoSentAt.set(req.doc.key, Date.now());
          }
          d.onRequest?.(1);
          return d.fim.complete(request(signal)).finally(() => d.onRequest?.(-1));
        },
        () => stillValid() && d.health.canRequest(manual),
        req.token,
      );
    } catch (err) {
      if (err instanceof FimError) {
        if (rec.requested) {
          d.health.onError(err);
        }
        return finish(`error:${err.kind}`);
      }
      if (rec.requested) {
        d.health.onError(new FimError('transient', (err as Error).message));
      }
      return finish('error:transient');
    }
    if (!result) {
      return finish(req.token.isCancellationRequested ? 'cancelled' : !d.health.canRequest(manual) ? 'backoff' : 'stale');
    }
    rec.tFirstByte = result.firstByteMs;
    rec.tTotal = result.totalMs;
    rec.finish = result.finishReason;
    rec.usage = result.usage;
    if (result.finishReason === 'timeout') {
      if (rec.requested) {
        d.health.onError(new FimError('transient', '请求超时'));
      }
      return finish('timeout');
    }
    if (result.finishReason === 'aborted') {
      return finish(req.token.isCancellationRequested ? 'cancelled' : 'stale');
    }
    if (rec.requested) {
      d.health.onSuccess();
    }

    // ── 后处理、复核、写缓存 ──
    const text = postprocess({ text: result.text, prefix: win.prefix, suffix: win.suffix, maxLines: cfg.maxLines });
    if (!text) {
      return finish('empty');
    }
    if (!stillValid()) {
      return finish(req.token.isCancellationRequested ? 'cancelled' : 'stale');
    }
    // 在途期间来源依赖变了：不显示、不缓存
    if (!(await depsValid(header.deps, d.depsIo)) || !stillValid()) {
      return finish('stale');
    }
    d.cache.put({
      docKey: req.doc.key,
      modelKey,
      windowStartLine: win.startLine,
      windowStartChar: win.startChar,
      anchorLine: win.anchorLine,
      prefix: win.prefix,
      suffix: win.suffix,
      completion: text,
      deps: header.deps,
    });
    return done(text);
  }
}

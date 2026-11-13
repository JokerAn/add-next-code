// 6.8 总装：不依赖 vscode，可用假时钟与假模型服务做集成级测试。
import { dropEntriesAffectedByChange, type CompletionCache } from './cache';
import type { CollectOutcome, Collector } from './collector';
import { depsValid, type DepsIo } from './deps';
import type { FimClient, FimResult } from './fim/client';
import { FimError } from './fim/errors';
import { buildFimRequest, isSingleLineMode, modelKeyOf } from './fim/prompt';
import type { HealthState } from './backoff';
import { cutBalanced, cutStatement, effectiveDebounceMs, lineModeOf, shouldSkipAutoTrigger } from './linePolicy';
import type { Metrics, Outcome, CacheState, CallRecord } from './metrics';
import { enclosingOpeners, isNamedFunctionOpener } from './blockAnchor';
import { insertReference } from './nearCursor';
import { intentComment } from './snippets';
import { postprocessTraced } from './postprocess';
import { estimateCost } from './pricing';
import type { Scheduler } from './scheduler';
import { sleepUntil } from './time';
import { countNewProps, cutAtMembers, fixRedeclare, focusQueryAt, fullText, inventedMembers, unverifiedStateItemProps } from './usage';
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
  /** 本次调用的序号，用于把"采纳"记回统计 */
  seq: number;
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

/** 同一段意图注释之下（intent），或同一个代码块里（block），上一次收集到的头部 */
interface HeaderMemo {
  kind: 'intent' | 'block';
  /** 意图注释行，或包着光标的块开头行（去掉首尾空白） */
  anchor: string;
  /** 收集时光标所在行 */
  line: number;
  at: number;
  epoch: number;
  outcome: CollectOutcome;
}

/** 负缓存：同样的提示词上次被后处理整条拒绝后，这段时间内不再重复请求 */
const NEGATIVE_TTL_MS = 2 * 60_000;
const NEGATIVE_MAX = 64;

const MEMO_TTL_MS = 5 * 60_000;
const MEMO_MAX_LINES = 60;
const MEMO_MAX_DOCS = 32;
/** 在光标上方这么多行里找意图注释 */
const MEMO_ANCHOR_SPAN = 150;

export class CompletionPipeline {
  private seq = 0;
  private readonly headerMemo = new Map<string, HeaderMemo>();
  /** 文档 key → 最近一次扫描出的非空行集合（用于 O(1) 校验头部 evidence 是否仍在） */
  private readonly lineSetMemo = new Map<string, { version: number; present: Set<string> }>();
  /** 请求键 → 被拒绝的时间与所属文档。temperature 为 0 时同样的提示词得到同样的结果，没必要再问一次 */
  private readonly rejected = new Map<string, { at: number; doc: string }>();
  private generation = 0;
  /** 文档 key → 上一次真正发出自动模型请求的时间 */
  private readonly lastAutoSentAt = new Map<string, number>();

  constructor(private readonly d: PipelineDeps) {}

  /** 开关、发送许可或配置变化时，让等待中和在途中的调用一并失效。 */
  invalidate(): void {
    this.generation++;
    this.headerMemo.clear();
    this.lineSetMemo.clear();
    this.rejected.clear();
    this.d.scheduler.abortAll();
  }

  /** 文档关闭时清理 */
  onDocumentClosed(docKey: string): void {
    this.d.cache.dropDoc(docKey);
    this.lastAutoSentAt.delete(docKey);
    this.headerMemo.delete(docKey);
    this.lineSetMemo.delete(docKey);
    for (const [key, entry] of this.rejected) {
      if (entry.doc === docKey) {
        this.rejected.delete(key);
      }
    }
  }

  /** onDidChangeTextDocument：只做缓存条目筛选，不读取文本 */
  onDocumentChanged(docKey: string, changeLines: number[]): void {
    dropEntriesAffectedByChange(this.d.cache, docKey, changeLines);
  }

  /**
   * 可沿用的头部：同一文档、同一份配置、5 分钟内、离收集时的位置不超过 60 行；
   * 锚点还在：意图注释仍在光标上方，或当时的块开头行仍然包着光标；光标自己没有写新的意图；
   * 头部引用的文件内代码都还在；跨文件依赖没变。
   */
  private async reusableHeader(
    doc: LiveDoc, line: number, prefix: string, intent: string | undefined, openers: readonly string[], epoch: number,
  ): Promise<CollectOutcome | undefined> {
    const memo = this.headerMemo.get(doc.key);
    if (!memo) {
      return undefined;
    }
    const drop = (): undefined => {
      this.headerMemo.delete(doc.key);
      return undefined;
    };
    if (memo.epoch !== epoch || Date.now() - memo.at > MEMO_TTL_MS || Math.abs(line - memo.line) > MEMO_MAX_LINES) {
      return drop();
    }
    // 光标自己的意图换了：新的任务，重新收集
    if (intent !== undefined && intent !== memo.anchor) {
      return drop();
    }
    if (memo.kind === 'intent') {
      const above = prefix.split('\n').slice(-MEMO_ANCHOR_SPAN, -1);
      if (!above.some((text) => text.trim() === memo.anchor)) {
        return drop();
      }
    } else {
      const idx = openers.indexOf(memo.anchor);
      if (idx < 0 || openers.slice(0, idx).some(isNamedFunctionOpener)) {
        return drop();
      }
    }
    if (memo.outcome.evidence.length > 0) {
      const ver = doc.version();
      let cached = this.lineSetMemo.get(doc.key);
      if (!cached || cached.version !== ver) {
        const present = new Set<string>();
        for (let i = 0; i < doc.source.lineCount; i++) {
          const t = doc.source.lineAt(i).trim();
          if (t !== '') {
            present.add(t);
          }
        }
        cached = { version: ver, present };
        this.lineSetMemo.delete(doc.key);
        this.lineSetMemo.set(doc.key, cached);
        if (this.lineSetMemo.size > MEMO_MAX_DOCS) {
          this.lineSetMemo.delete(this.lineSetMemo.keys().next().value as string);
        }
      }
      if (!memo.outcome.evidence.every((text) => cached.present.has(text))) {
        return drop();
      }
    }
    if (!(await depsValid(memo.outcome.header.deps, this.d.depsIo))) {
      return drop();
    }
    return memo.outcome;
  }

  async run(req: PipelineRequest): Promise<Completion | undefined> {
    const d = this.d;
    const cfg = d.cfg();
    const startedAt = Date.now();
    const seq = ++this.seq;
    const snap = { version: req.doc.version(), epoch: cfg.epoch, generation: this.generation };
    const manual = req.trigger === 'manual';

    /** 使本次调用作废的第一个原因；仍然有效时为 undefined。 */
    const invalidReason = (): string | undefined =>
      req.token.isCancellationRequested ? 'token'
        : this.generation !== snap.generation ? 'generation'
        : req.isValid?.() === false ? 'gate'
        : req.doc.version() !== snap.version ? 'version'
        : d.cfg().epoch !== snap.epoch ? 'config'
        : !req.doc.cursorIsAt(req.position) ? 'cursor'
        : undefined;
    const stillValid = (): boolean => invalidReason() === undefined;

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
      line: req.position.line,
      col: req.position.character,
      stage: 'cache',
    };
    const finish = (outcome: Outcome, cache?: CacheState): undefined => {
      rec.outcome = outcome;
      if (outcome === 'cancelled' || outcome === 'stale') {
        // 没有作废原因的 stale 只可能来自来源依赖变化
        rec.why = invalidReason() ?? 'deps';
      }
      if (cache) {
        rec.cache = cache;
      }
      rec.tEnd2End = Date.now() - startedAt;
      d.log(d.metrics.record(rec));
      return undefined;
    };
    /** 调试用：补全原文只在 debug.dumpCompletions 开启时写入日志 */
    const dump = (label: string, text: string): void => {
      if (cfg.dumpCompletions) {
        d.log(`[completion#${seq} ${label}]\n${text}`);
      }
    };
    const done = (text: string, cache?: CacheState): Completion => {
      rec.outcome = 'shown';
      if (cache) {
        rec.cache = cache;
      }
      rec.outChars = text.length;
      rec.outLines = text.split('\n').length;
      rec.tEnd2End = Date.now() - startedAt;
      d.log(d.metrics.record(rec));
      dump('shown', text);
      return { text, seq };
    };

    // ── 窗口（O(窗口)）与缓存 ──
    const win: WindowResult = buildWindow(req.doc.source, req.position, req.sci, cfg);
    rec.prefixChars = win.prefix.length;
    rec.suffixChars = win.suffix.length;
    rec.winStart = win.startLine;
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

    // ── 空行分级与行尾克制：信号最弱或已完整结束的位置只补一条语句，或在自动模式下不请求 ──
    const lineMode = cfg.blankLine === 'always' ? 'free' : lineModeOf(win.prefix, win.suffix);
    if (
      !manual &&
      (lineMode === 'empty' ||
        (lineMode === 'statement' && cfg.blankLine === 'strict') ||
        (cfg.blankLine !== 'always' && shouldSkipAutoTrigger(win.prefix, win.suffix)))
    ) {
      rec.mode = lineMode;
      return finish('skipped');
    }
    const statement = lineMode === 'statement' || lineMode === 'empty';
    rec.mode = isSingleLineMode(win.suffix) ? 'single' : lineMode;

    if (!d.health.canRequest(manual)) {
      return finish('backoff');
    }

    // ── 防抖与限频（仅自动触发）──
    rec.stage = 'wait';
    const waitStart = Date.now();
    if (!manual) {
      const waitMs = effectiveDebounceMs(cfg.debounceMs, cfg.adaptiveDebounce, win.prefix, lineMode);
      const sendAt = Math.max(
        Date.now() + waitMs,
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
    rec.stage = 'context';
    const ctxStart = Date.now();
    const collectInput = {
      docKey: req.doc.key,
      languageId: req.doc.languageId,
      fileLabel: req.doc.fileLabel,
      source: req.doc.source,
      version: snap.version,
      line: cursor.before.line,
      character: cursor.before.character,
      windowStartLine: win.startLine,
      windowStartChar: win.startChar,
      windowText: win.prefix + win.suffix,
      cfg,
    };
    // 同一段意图注释之下连续的几次请求沿用同一份头部：头部在提示词最前面，它一变，服务端的前缀缓存就全部失效
    let outcome: CollectOutcome | undefined;
    const reuseMode = cfg.reuseHeader;
    const intent = reuseMode !== 'off' ? intentComment(req.doc.source, cursor.before.line) : undefined;
    const openers = reuseMode === 'block'
      ? enclosingOpeners(req.doc.source, cursor.before.line, cursor.before.character) : [];
    // 光标前正在补候选名字（this.、row.、半个标识符）时，头部末尾的候选行必须按这个位置重新生成
    const wantsFocus = focusQueryAt(req.doc.source.lineAt(cursor.before.line).slice(0, cursor.before.character)) !== undefined;
    if (reuseMode !== 'off' && !manual && !wantsFocus) {
      outcome = await this.reusableHeader(req.doc, cursor.before.line, win.prefix, intent?.text, openers, cfg.epoch);
    }
    rec.hdr = outcome ? 'reuse' : 'fresh';
    if (outcome) {
      rec.hdrBy = this.headerMemo.get(req.doc.key)?.kind;
    } else {
      outcome = await d.collector(collectInput, Date.now() + cfg.extraWaitMs);
      // 有意图注释时以它为锚点；没有时以包着光标的块开头行为锚点（在块里逐行往下写）。
      // 带候选名字行的结果不记：那一行只对当时的光标位置有效。
      const anchorText = intent?.text ?? openers[0];
      const hasFocus = outcome.status['usage'] !== undefined && outcome.status['usage'] !== 'empty';
      if (anchorText !== undefined && outcome.header.text !== '' && !hasFocus) {
        const kind = intent ? 'intent' : 'block';
        this.headerMemo.delete(req.doc.key);
        this.headerMemo.set(req.doc.key, { kind, anchor: anchorText, line: cursor.before.line, at: Date.now(), epoch: cfg.epoch, outcome });
        rec.hdrBy = kind;
        if (this.headerMemo.size > MEMO_MAX_DOCS) {
          this.headerMemo.delete(this.headerMemo.keys().next().value as string);
        }
      }
    }
    let header: Header = outcome.header;
    rec.framework = outcome.framework;
    rec.region = outcome.region;
    rec.sym = outcome.status['symbols'];
    rec.skimmer = outcome.status['skimmer'];
    rec.focus = outcome.status['usage'];
    rec.snippets = outcome.status['snippets'];
    rec.scope = outcome.status['scope'];
    rec.diff = outcome.status['gitdiff'];
    rec.tabs = outcome.status['opentabs'];
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
    rec.stage = 'request';
    const block = lineMode === 'block';
    // 实验开关打开时，部分参照代码插在光标上方。只影响发给模型的前文；缓存、后处理、复核仍用真实的 win
    const sent = (near: readonly string[]) => (near.length > 0 ? { prefix: insertReference(win.prefix, near), suffix: win.suffix } : win);
    const promptWin = sent(outcome.near);
    if (outcome.near.length > 0) {
      rec.near = outcome.near.length;
    }
    const request = (signal: AbortSignal) => buildFimRequest(promptWin, header, manual, cfg, signal, statement, block);
    const key = JSON.stringify([modelKey, promptWin.prefix, win.suffix, header.text, manual]);
    if (cfg.dumpPrompts) {
      d.log(`[prompt#${seq}]\n${header.text}${promptWin.prefix}<|cursor|>${win.suffix}`);
    }
    // 负缓存：温度为 0 时同样的提示词必然得到同样的结果；上次已经被整条拒绝，就不再花钱问第二遍。手动触发是用户明确的要求，照常发送。
    // 键只在行尾空白上宽容（光标行之前的部分与光标之后的每一行）：日志里同一位置连续几次的后文只差一个空白，结果完全一样。
    const trimTrail = (text: string) => text.replace(/[ \t]+$/gm, '');
    const cursorLineStart = promptWin.prefix.lastIndexOf('\n') + 1;
    const rejectKey = JSON.stringify([
      modelKey, trimTrail(promptWin.prefix.slice(0, cursorLineStart)), promptWin.prefix.slice(cursorLineStart),
      trimTrail(win.suffix), header.text, manual,
    ]);
    const deterministic = !manual && cfg.temperature === 0;
    if (deterministic) {
      const earlier = this.rejected.get(rejectKey);
      if (earlier && Date.now() - earlier.at < NEGATIVE_TTL_MS) {
        rec.neg = 'hit';
        return finish('empty');
      }
      this.rejected.delete(rejectKey);
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
    rec.tFirstToken = result.firstTokenMs;
    rec.tFinish = result.finishMs;
    // 被中止或超时的请求没有真实的总耗时，不参与统计
    if (result.finishReason !== 'aborted' && result.finishReason !== 'timeout') {
      rec.tTotal = result.totalMs;
    }
    rec.finish = result.finishReason;
    rec.usage = result.usage;
    if (result.usage) {
      rec.cost = estimateCost(cfg.endpoint, cfg.model, result.usage, new Date());
    }
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
    rec.stage = 'post';
    const refine = (res: FimResult) => {
      // 非流式响应不经过流内截断，这里补一次
      const raw = (statement ? cutStatement(res.text) : cutBalanced(res.text, cfg.maxLines)) ?? res.text;
      const out = postprocessTraced({
        text: raw, prefix: win.prefix, suffix: win.suffix, maxLines: statement ? cfg.maxLines : cfg.maxLines * 2, manual,
      });
      if (raw !== res.text) {
        out.rules.unshift(statement ? 'statement' : 'balanced');
      }
      // 外层已经声明过的变量不重复声明
      if (out.text && cfg.verifyMembers !== 'off' && !req.sci) {
        const fixed = fixRedeclare(out.text, req.doc.source, req.position.line, req.position.character);
        if (fixed.names.length > 0) {
          out.text = fixed.text;
          out.rules.push('redeclare');
        }
      }
      return out;
    };
    let processed = refine(result);
    let text = processed.text;
    dump('raw', result.text);
    rec.rawChars = result.text.length;
    rec.rawLines = result.text.split('\n').length;

    // ── 实例成员与状态元素属性校验：补全里有本文件不存在的 this 成员或状态元素属性时，以草稿为线索重新检索并重发一次 ──
    let cachedFileText: string | undefined;
    const getFileText = () => (cachedFileText ??= fullText(req.doc.source));
    if (text && cfg.verifyMembers !== 'off') {
      const fileText = getFileText();
      let hardInvented = inventedMembers(text, fileText, header.text);
      const softStateProps = hardInvented.length === 0 ? unverifiedStateItemProps(text, fileText) : [];
      let suspect = hardInvented.length > 0 ? hardInvented : softStateProps;
      if (suspect.length > 0) {
        rec.stage = 'verify';
        rec.draftInvented = suspect.length;
        dump('invented', suspect.join(', '));
        const second = await d.collector({ ...collectInput, hint: text }, Date.now() + cfg.extraWaitMs);
        if (!stillValid()) {
          return finish(req.token.isCancellationRequested ? 'cancelled' : 'stale');
        }
        // 头部没有新内容时重发也只会得到同样的结果
        const unchanged = second.header.text === header.text && second.near.join('\n') === outcome.near.join('\n');
        if (unchanged || !(await depsValid(second.header.deps, d.depsIo))) {
          rec.retry = 'nohint';
        } else {
          if (cfg.dumpPrompts) {
            d.log(`[prompt#${seq} retry]\n${second.header.text}${sent(second.near).prefix}<|cursor|>${win.suffix}`);
          }
          let retried: FimResult | undefined;
          try {
            retried = await d.scheduler.run(
              JSON.stringify([modelKey, sent(second.near).prefix, win.suffix, second.header.text, manual]),
              (signal) => {
                d.onRequest?.(1);
                return d.fim.complete(buildFimRequest(sent(second.near), second.header, manual, cfg, signal, statement, block))
                  .finally(() => d.onRequest?.(-1));
              },
              () => stillValid() && d.health.canRequest(manual),
              req.token,
            );
          } catch (err) {
            // 重发失败不影响已经拿到的结果，只记入健康状态
            d.health.onError(err instanceof FimError ? err : new FimError('transient', (err as Error).message));
          }
          if (!stillValid()) {
            return finish(req.token.isCancellationRequested ? 'cancelled' : 'stale');
          }
          if (!retried || retried.finishReason === 'aborted' || retried.finishReason === 'timeout') {
            rec.retry = 'failed';
          } else {
            rec.tRetry = retried.totalMs;
            if (retried.usage) {
              const cost = estimateCost(cfg.endpoint, cfg.model, retried.usage, new Date());
              rec.usage = rec.usage ? {
                prompt: rec.usage.prompt + retried.usage.prompt,
                cacheHit: rec.usage.cacheHit + retried.usage.cacheHit,
                cacheMiss: rec.usage.cacheMiss + retried.usage.cacheMiss,
                completion: rec.usage.completion + retried.usage.completion,
              } : retried.usage;
              if (cost) {
                rec.cost = { usd: (rec.cost?.usd ?? 0) + cost.usd, noCacheUsd: (rec.cost?.noCacheUsd ?? 0) + cost.noCacheUsd };
              }
            }
            dump('retry raw', retried.text);
            const again = refine(retried);
            const nextHard = again.text ? inventedMembers(again.text, fileText, second.header.text) : hardInvented;
            const nextSoft = again.text && nextHard.length === 0
              ? unverifiedStateItemProps(again.text, fileText) : [];
            const left = nextHard.length > 0 ? nextHard : nextSoft;
            if (again.text && left.length < suspect.length) {
              processed = again;
              text = again.text;
              hardInvented = nextHard;
              suspect = left;
              header = second.header;
              rec.headerChars = header.text.length;
              rec.retry = 'better';
            } else {
              rec.retry = 'same';
            }
          }
        }
        if (hardInvented.length > 0 && cfg.verifyMembers === 'strict') {
          const kept = cutAtMembers(text, hardInvented);
          if (kept !== undefined) {
            text = kept;
            processed.rules.push('invented');
          }
        }
        rec.invented = hardInvented.length > 0 ? hardInvented.length : suspect.length;
        rec.stage = 'post';
      }
    }
    if (processed.rules.length > 0) {
      rec.pp = processed.rules;
    }
    if (!text) {
      // 完整返回、却被后处理整条拒绝的结果记下来（被取消、超时、出错的在前面已经返回，不会走到这里）
      if (deterministic) {
        this.rejected.delete(rejectKey);
        this.rejected.set(rejectKey, { at: Date.now(), doc: req.doc.key });
        rec.neg = 'stored';
        if (this.rejected.size > NEGATIVE_MAX) {
          this.rejected.delete(this.rejected.keys().next().value as string);
        }
      }
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
    const props = countNewProps(text, cachedFileText ?? req.doc.source);
    rec.props = props.props;
    rec.newProps = props.fresh;
    return done(text);
  }
}

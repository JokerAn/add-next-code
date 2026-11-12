// 12. 指标：每次调用一行 JSON（不含源码与 Key）+ 会话统计。
import type { FimUsage } from './fim/client';
import type { CostEstimate } from './pricing';
import type { CompletionContextResponse, SkimmerDropReason } from './skimmer/protocol';
import type { Framework, Region, TriggerKind } from './types';

export interface SkimmerQueryRecord {
  outcome: 'ok' | 'timeout' | 'error' | 'cancelled';
  /** 客户端从发出 MCP 查询到落定的耗时，包括管道、服务端处理和协议解码。 */
  elapsedMs: number;
  serverElapsedMs?: number;
  overlay?: CompletionContextResponse['overlay']['state'];
  index?: CompletionContextResponse['index']['state'];
  /** 服务端解码后、扩展权限与指纹过滤前的返回数量，不保存源码或文件名。 */
  selfMembers?: number;
  relatedItems?: number;
  dropped: Record<SkimmerDropReason, number>;
}

export type Outcome =
  | 'shown'
  | 'empty'
  | 'cancelled'
  | 'stale'
  | 'timeout'
  | 'backoff'
  | 'skipped'
  | `error:${string}`;

export type CacheState = 'miss' | 'hit' | 'remainder';

export interface CallRecord {
  seq: number;
  trigger: TriggerKind;
  lang: string;
  framework?: Framework;
  region?: Region;
  sci: boolean;
  prefixChars: number;
  suffixChars: number;
  headerChars: number;
  cache: CacheState;
  tWait?: number;
  tContext?: number;
  tFirstByte?: number;
  tTotal?: number;
  /** 从 Provider 被调用到返回的总耗时 */
  tEnd2End?: number;
  outcome: Outcome;
  finish?: string;
  usage?: FimUsage;
  skimmer?: string;
  sym?: string;
  /** 本次是否真正发出了模型请求 */
  requested: boolean;
  /** 按官方价目估算的费用；未知模型、非官方端点或 usage 未知时没有 */
  cost?: CostEstimate;
  /** 展示后被整条接受 */
  accepted?: boolean;
  /** 光标位置与窗口起始行（行号、列号，不含源码） */
  line?: number;
  col?: number;
  winStart?: number;
  /** 结束时所处的阶段：cache / wait / context / request / post */
  stage?: string;
  /** cancelled / stale 的原因：token / generation / gate / version / config / cursor / deps */
  why?: string;
  /** 行模式：single / free / block / statement / empty */
  mode?: string;
  /** 文件内用法索引的结果，形如 member:12 或 ident:5；没有候选时为 empty */
  focus?: string;
  /** 第一段文本、结束标记到达的时间 */
  tFirstToken?: number;
  tFinish?: number;
  /** 模型原始输出与最终展示的字符数、行数 */
  rawChars?: number;
  rawLines?: number;
  outChars?: number;
  outLines?: number;
  /** 实际改动了结果的后处理规则 */
  pp?: string[];
  /** 同文件相关片段的段数 */
  snippets?: string;
  /** 负缓存：stored 本次结果被整条拒绝并记下；hit 同样的提示词上次被拒绝过，这次没有发请求 */
  neg?: string;
  /** 头部来源：reuse 沿用了同一段意图下上一次收集的头部；fresh 重新收集 */
  hdr?: string;
  /** 沿用或记下的锚点种类：intent 意图注释；block 包着光标的代码块 */
  hdrBy?: string;
  /** 实验：放到光标上方的参照代码段数 */
  near?: number;
  /** 提示词里带上的外层变量声明个数 */
  scope?: string;
  /** 未提交改动：形如 "选中块数/候选块数"；没有相关改动为 empty */
  diff?: string;
  /** 草稿里、最终结果里本文件不存在的实例成员个数 */
  draftInvented?: number;
  invented?: number;
  /** 成员校验触发的重发：better 采用了新结果 / same 新结果没有更好 / nohint 没有新线索未重发 / failed 重发失败 */
  retry?: string;
  tRetry?: number;
  /** 展示内容里的属性名个数，以及其中在本文件从未出现过的个数 */
  props?: number;
  newProps?: number;
}

export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export class Metrics {
  private readonly records: CallRecord[] = [];
  private readonly skimmerQueries: SkimmerQueryRecord[] = [];
  private readonly max: number;
  abortSettleMs: number[] = [];
  stuck = 0;

  constructor(max = 2000) {
    this.max = max;
  }

  record(r: CallRecord): string {
    this.records.push(r);
    if (this.records.length > this.max) {
      this.records.shift();
    }
    return JSON.stringify(r);
  }

  /** 展示的补全被接受；记录已滚出统计窗口时返回 false。 */
  markAccepted(seq: number): boolean {
    const record = this.records.find((r) => r.seq === seq);
    if (!record) {
      return false;
    }
    record.accepted = true;
    return true;
  }

  recordSkimmer(record: SkimmerQueryRecord): void {
    this.skimmerQueries.push(record);
    if (this.skimmerQueries.length > this.max) {
      this.skimmerQueries.shift();
    }
  }

  get count(): number {
    return this.records.length;
  }

  summary(): string {
    const rs = this.records;
    const auto = rs.filter((r) => r.trigger === 'auto').length;
    const manual = rs.length - auto;
    const hit = rs.filter((r) => r.cache === 'hit').length;
    const rem = rs.filter((r) => r.cache === 'remainder').length;
    const requested = rs.filter((r) => r.requested);
    const shown = rs.filter((r) => r.outcome === 'shown').length;
    const byOutcome = new Map<string, number>();
    for (const r of rs) {
      byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
    }
    let promptHit = 0;
    let promptMiss = 0;
    let completion = 0;
    let unknownUsage = 0;
    for (const r of requested) {
      if (r.usage) {
        promptHit += r.usage.cacheHit;
        promptMiss += r.usage.cacheMiss;
        completion += r.usage.completion;
      } else {
        unknownUsage++;
      }
    }
    const promptKnown = promptHit + promptMiss;
    const hitRate = promptKnown > 0 ? `${Math.round((promptHit / promptKnown) * 100)}%` : '-';
    const costed = requested.filter((r) => r.cost !== undefined);
    const cost = costed.reduce((total, r) => total + (r.cost?.usd ?? 0), 0);
    const noCache = costed.reduce((total, r) => total + (r.cost?.noCacheUsd ?? 0), 0);
    const saved = noCache > 0 ? `${Math.round((1 - cost / noCache) * 100)}%` : '-';
    const usd = (v: number) => `${v.toFixed(5)} 美元`;
    // 同一条结果可能经缓存、续显多次返回，采纳率以模型新结果的展示次数为分母。
    const freshShown = rs.filter((r) => r.outcome === 'shown' && r.cache === 'miss').length;
    const accepted = rs.filter((r) => r.accepted).length;
    const acceptRate = freshShown > 0 ? `${Math.round((accepted / freshShown) * 100)}%` : '-';
    const firstToken = requested.flatMap((r) => (r.tFirstToken === undefined ? [] : [r.tFirstToken]));
    const closeWait = requested.flatMap((r) => (r.tFinish === undefined || r.tTotal === undefined ? [] : [r.tTotal - r.tFinish]));
    const tally = (values: string[]) => {
      const counts = new Map<string, number>();
      for (const value of values) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      return [...counts.entries()].map(([k, v]) => `${k}=${v}`).join('，') || '-';
    };
    const rejected = rs.filter((r) => r.outcome === 'empty' && r.requested);
    const propTotal = rs.reduce((total, r) => total + (r.props ?? 0), 0);
    const propNew = rs.reduce((total, r) => total + (r.newProps ?? 0), 0);
    const withFocus = requested.filter((r) => r.focus !== undefined && r.focus !== 'empty').length;
    const withSnippets = requested.filter((r) => r.snippets !== undefined && r.snippets !== 'empty').length;
    const withDiff = requested.filter((r) => r.diff !== undefined && r.diff !== 'empty' && r.diff !== 'timeout').length;
    const negHit = rs.filter((r) => r.neg === 'hit').length;
    const negStored = rs.filter((r) => r.neg === 'stored').length;
    const hdrReuse = requested.filter((r) => r.hdr === 'reuse').length;
    const hdrKnown = requested.filter((r) => r.hdr !== undefined).length;
    const drafts = rs.filter((r) => (r.draftInvented ?? 0) > 0);
    const returned = rs.filter((r) => r.outcome === 'shown' && r.tEnd2End !== undefined);
    const returnTimes = (matches: (r: CallRecord) => boolean) => returned.filter(matches).map((r) => r.tEnd2End as number);
    const fb = requested.filter((r) => r.tFirstByte !== undefined).map((r) => r.tFirstByte as number);
    const tot = requested.filter((r) => r.tTotal !== undefined).map((r) => r.tTotal as number);
    const ctx = rs.filter((r) => r.tContext !== undefined).map((r) => r.tContext as number);
    const queries = this.skimmerQueries;
    const queryTimes = queries.map((query) => query.elapsedMs);
    const queryAverage = queries.length > 0 ? queryTimes.reduce((total, ms) => total + ms, 0) / queries.length : undefined;
    const serverTimes = queries.flatMap((query) => query.serverElapsedMs === undefined ? [] : [query.serverElapsedMs]);
    const responses = queries.filter((query) => query.outcome === 'ok');
    const contentKnown = responses.filter((query) => query.selfMembers !== undefined && query.relatedItems !== undefined);
    const withContent = contentKnown.filter((query) => query.selfMembers! + query.relatedItems! > 0).length;
    const selfMembers = contentKnown.reduce((total, query) => total + query.selfMembers!, 0);
    const relatedItems = contentKnown.reduce((total, query) => total + query.relatedItems!, 0);
    const dropped = { dirty: 0, stale: 0, budget: 0 };
    for (const query of queries) {
      for (const reason of ['dirty', 'stale', 'budget'] as const) {
        dropped[reason] += query.dropped[reason];
      }
    }
    const fmt = (v: number | undefined) => (v === undefined ? '-' : `${Math.round(v)}ms`);
    const returnLatency = (label: string, matches: (r: CallRecord) => boolean) => {
      const values = returnTimes(matches);
      return `Provider 调用到返回 p50/p95（${label}，${values.length} 次）：${fmt(percentile(values, 50))} / ${fmt(percentile(values, 95))}`;
    };
    const lines = [
      `调用：${rs.length}（自动 ${auto} / 手动 ${manual}）`,
      `来源：缓存命中 ${hit}，续显 ${rem}，模型请求 ${requested.length}`,
      `返回补全：${shown}`,
      `采纳：${accepted} 次；模型新结果展示 ${freshShown} 次，采纳率 ${acceptRate}（整条接受才计入）`,
      `结果分布：${[...byOutcome.entries()].map(([k, v]) => `${k}=${v}`).join('，') || '-'}`,
      `Token（usage 已知部分）：输入命中 ${promptHit} / 未命中 ${promptMiss}，输出 ${completion}；usage 未知的请求 ${unknownUsage} 个`,
      `输入缓存命中率：${hitRate}；头部沿用 ${hdrReuse} / ${hdrKnown} 次请求；负缓存拦截 ${negHit} 次（记下 ${negStored} 次）`,
      `费用估算（${costed.length} 次请求，2026-11-11 官方价，未扣节假日）：${usd(cost)}；若输入全部未命中为 ${usd(noCache)}，缓存节省 ${saved}`,
      `上下文耗时 p50/p95：${fmt(percentile(ctx, 50))} / ${fmt(percentile(ctx, 95))}`,
      `首字节 p50/p95：${fmt(percentile(fb, 50))} / ${fmt(percentile(fb, 95))}`,
      `首段文本 p50/p95：${fmt(percentile(firstToken, 50))} / ${fmt(percentile(firstToken, 95))}；结束标记后等待流关闭 p50/p95：${fmt(percentile(closeWait, 50))} / ${fmt(percentile(closeWait, 95))}`,
      `取消与过期原因：${tally(rs.flatMap((r) => (r.why ? [`${r.stage ?? '?'}/${r.why}`] : [])))}`,
      `行模式（实际请求）：${tally(requested.flatMap((r) => (r.mode ? [r.mode] : [])))}`,
      `后处理规则命中：${tally(rs.flatMap((r) => r.pp ?? []))}；模型有输出但被拒绝 ${rejected.length} 次`,
      `文件内用法索引：${withFocus} / ${requested.length} 次请求带候选名字；相关片段：${withSnippets} / ${requested.length} 次请求带片段；未提交改动：${withDiff} / ${requested.length} 次请求带改动块`,
      `成员校验：${drafts.length} 次草稿含本文件不存在的成员；重发结果 ${tally(drafts.flatMap((r) => (r.retry ? [r.retry] : [])))}；最终仍含 ${drafts.filter((r) => (r.invented ?? 0) > 0).length} 次（strict 下已截断）`,
      `展示内容里的属性名 ${propTotal} 个，其中本文件从未出现过的 ${propNew} 个`,
      `请求总耗时 p50/p95：${fmt(percentile(tot, 50))} / ${fmt(percentile(tot, 95))}`,
      returnLatency('自动非缓存', (r) => r.trigger === 'auto' && r.cache === 'miss'),
      returnLatency('手动非缓存', (r) => r.trigger === 'manual' && r.cache === 'miss'),
      returnLatency('缓存命中', (r) => r.cache === 'hit'),
      returnLatency('续显', (r) => r.cache === 'remainder'),
      `取消后落定耗时 p95：${fmt(percentile(this.abortSettleMs, 95))}；卡死 ${this.stuck} 次`,
      `Skimmer 查询（最近 ${this.max} 条）：${queries.length}；成功 ${queries.filter((query) => query.outcome === 'ok').length} / 超时 ${queries.filter((query) => query.outcome === 'timeout').length} / 失败 ${queries.filter((query) => query.outcome === 'error').length} / 取消 ${queries.filter((query) => query.outcome === 'cancelled').length}`,
      `Skimmer 摘要状态（${responses.length} 条成功响应）：ready=${responses.filter((query) => query.overlay === 'ready').length} / stale=${responses.filter((query) => query.overlay === 'stale').length} / failed=${responses.filter((query) => query.overlay === 'failed').length} / 未知=${responses.filter((query) => query.overlay === undefined).length}`,
      `Skimmer 索引状态：ready=${responses.filter((query) => query.index === 'ready').length} / indexing=${responses.filter((query) => query.index === 'indexing').length} / empty=${responses.filter((query) => query.index === 'empty').length} / locked=${responses.filter((query) => query.index === 'locked').length} / 未知=${responses.filter((query) => query.index === undefined).length}`,
      `Skimmer 响应内容（扩展过滤前）：有内容 ${withContent} / 无内容 ${contentKnown.length - withContent} / 未知 ${responses.length - contentKnown.length}；成员 ${selfMembers}，关联项 ${relatedItems}`,
      `Skimmer 客户端耗时：平均 ${fmt(queryAverage)}，p50/p95 ${fmt(percentile(queryTimes, 50))} / ${fmt(percentile(queryTimes, 95))}`,
      `Skimmer 服务端耗时 p50/p95（${serverTimes.length} 条响应）：${fmt(percentile(serverTimes, 50))} / ${fmt(percentile(serverTimes, 95))}`,
      `Skimmer 服务端丢弃：dirty=${dropped.dirty}，stale=${dropped.stale}，budget=${dropped.budget}`,
    ];
    return lines.join('\n');
  }
}

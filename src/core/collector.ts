// 上下文收集：并行调用各来源，受统一截止时间约束；任何来源失败只影响本次头部。
import { extractIdentifiers } from './identifiers';
import { renderHeader, type HeaderStyle } from './header';
import { detectFramework } from './framework';
import { findSfcBlocks, hasScriptSetup, regionAt, type SfcBlock } from './sfc';
import { queryOf, type Query } from './snippets';
import type { ChangeItem, Config, Framework, Header, Member, Region, RelatedItem, TextSource } from './types';
import { EMPTY_HEADER } from './types';

export interface CollectInput {
  /** 文档标识（uri 字符串），用于按文档缓存与定位 package.json */
  docKey: string;
  languageId: string;
  /** 用于头部展示的相对路径 */
  fileLabel: string;
  source: TextSource;
  version: number;
  /** （虚拟）光标位置 */
  line: number;
  character: number;
  windowStartLine: number;
  windowStartChar?: number;
  /** prefix + suffix，裁剪成员时使用 */
  windowText: string;
  /** 额外线索（模型草稿），用于二次检索 */
  hint?: string;
  cfg: Config;
}

export interface SourceResult {
  members?: Member[];
  related?: RelatedItem[];
  /** 针对光标处表达式的一行候选名字（文件内用法索引） */
  focus?: string;
  /** 同文件里窗口之外的相关代码片段 */
  snippets?: string[];
  /** 未提交的改动块 */
  changes?: ChangeItem[];
  /** 其他已打开文档（含未跟踪新文件与参照文件）的相关片段 */
  openTabs?: ChangeItem[];
  /** 实验：要放到光标上方而不是头部的参照代码 */
  nearSnippets?: string[];
  /** 来源自报的框架（Skimmer 可用时以它为准） */
  framework?: Framework;
  /** 来源可报告更具体的降级状态，用于日志。 */
  status?: string;
}

export interface ContextSource {
  name: string;
  collect(ctx: SourceContext, deadlineAt: number): Promise<SourceResult | undefined>;
}

export interface SourceContext extends CollectInput {
  framework: Framework;
  region: Region;
  identifiers: string[];
  /** 光标处提取的检索词与中文词组，供 snippets / gitDiff / openTabs 共享，避免重复计算 */
  query?: Query;
  sfcBlocks?: SfcBlock[];
  /** 最近 package.json 中已核实的 Vue 主版本，未知时不推测。 */
  projectVueMajor?: 2 | 3;
}

export interface CollectorDeps {
  sources: ContextSource[];
  /** 文档所属项目里 vue 依赖的主版本；未知返回 undefined */
  vueMajor(docKey: string): Promise<number | undefined>;
  now?: () => number;
}

export interface CollectOutcome {
  header: Header;
  framework: Framework;
  region: Region;
  /** 各来源状态，用于指标：ok / timeout / error / empty */
  status: Record<string, string>;
  /** 实验：放到光标上方的参照代码，不在 header 里 */
  near: string[];
  /** 头部里引用的文件内代码（相关片段、光标上方的参照）的每一行，去掉首尾空白；用来判断沿用头部时这些代码是否还在 */
  evidence: string[];
}

function withDeadline<T>(run: () => Promise<T>, ms: number): Promise<{ timedOut: boolean; value?: T }> {
  if (ms <= 0) {
    return Promise.resolve({ timedOut: true });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    Promise.resolve().then(run).then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      () => {
        clearTimeout(timer);
        resolve({ timedOut: false });
      },
    );
  });
}

/** 头部拼在窗口之前，注释格式取决于窗口起点，而不是光标所在区块。 */
function headerStyleAt(input: CollectInput, blocks: SfcBlock[]): HeaderStyle {
  if (input.languageId !== 'vue') {
    return 'line';
  }
  const block = blocks.find((b) => input.windowStartLine >= b.startLine && input.windowStartLine <= b.endLine);
  if (!block || block.tag === 'template') {
    return 'html';
  }
  const text = input.source.lineAt(input.windowStartLine);
  const character = input.windowStartChar ?? 0;
  if (input.windowStartLine === block.startLine) {
    const openingEnd = text.indexOf('>');
    if (openingEnd < 0 || character <= openingEnd) {
      return 'html';
    }
  }
  if (input.windowStartLine === block.endLine) {
    const closing = new RegExp(`</${block.tag}\\s*>`).exec(text);
    if (closing && character >= closing.index + closing[0].length) {
      return 'html';
    }
  }
  return block.tag === 'style' ? 'block' : 'line';
}

export function createCollector(deps: CollectorDeps) {
  const now = deps.now ?? Date.now;
  return async function collect(input: CollectInput, deadlineAt: number): Promise<CollectOutcome> {
    // 防抖与限频通过之后才会走到这里，允许 O(全文) 的工作（SFC 扫描）。
    let blocks: SfcBlock[] = [];
    let region: Region = 'other';
    let scriptSetup = false;
    if (input.languageId === 'vue') {
      blocks = findSfcBlocks(input.source);
      region = regionAt(blocks, input.line);
      scriptSetup = hasScriptSetup(blocks);
    }
    const vueMajor = input.languageId === 'vue'
      ? (await withDeadline(() => deps.vueMajor(input.docKey), deadlineAt - now())).value
      : undefined;
    let scriptText = '';
    if (input.languageId === 'vue' && vueMajor !== 2 && vueMajor !== 3 && !scriptSetup) {
      for (const block of blocks.filter((block) => block.tag === 'script')) {
        for (let line = block.startLine; line <= block.endLine && scriptText.length < 16_384; line++) {
          scriptText += input.source.lineAt(line).slice(0, 16_384 - scriptText.length) + '\n';
        }
      }
    }
    const framework = detectFramework({
      languageId: input.languageId,
      source: input.source,
      scriptSetup,
      vueMajor,
      scriptText,
    });
    const identifiers = extractIdentifiers(input.source, input.line, input.character);
    const query = queryOf(input.source, input.line, input.hint);
    const ctx: SourceContext = {
      ...input, framework, region, identifiers, query,
      ...(input.languageId === 'vue' ? { sfcBlocks: blocks } : {}),
      ...(vueMajor === 2 || vueMajor === 3 ? { projectVueMajor: vueMajor } : {}),
    };

    const status: Record<string, string> = {};
    const members: Member[] = [];
    const related: RelatedItem[] = [];
    const focus: string[] = [];
    const snippets: string[] = [];
    const changes: ChangeItem[] = [];
    const openTabs: ChangeItem[] = [];
    const near: string[] = [];
    let reported: Framework | undefined;

    await Promise.all(
      deps.sources.map(async (s) => {
        const left = deadlineAt - now();
        const r = await withDeadline(() => s.collect(ctx, deadlineAt), left);
        if (r.timedOut) {
          status[s.name] = 'timeout';
          return;
        }
        if (!r.value) {
          status[s.name] = 'empty';
          return;
        }
        status[s.name] = r.value.status ?? 'ok';
        members.push(...(r.value.members ?? []));
        related.push(...(r.value.related ?? []));
        if (r.value.focus) {
          focus.push(r.value.focus);
        }
        snippets.push(...(r.value.snippets ?? []));
        changes.push(...(r.value.changes ?? []));
        openTabs.push(...(r.value.openTabs ?? []));
        near.push(...(r.value.nearSnippets ?? []));
        reported = reported ?? r.value.framework;
      }),
    );

    // 同一个组件常以标签名和导入名各列一次（skulist-pop / SkulistPop），文件与接口完全相同：只留第一个
    const seenRelated = new Set<string>();
    const relatedItems = related.filter((item) => {
      const key = `${item.kind ?? ''}|${item.file}|${JSON.stringify(item.interface)}`;
      if (seenRelated.has(key)) {
        return false;
      }
      seenRelated.add(key);
      return true;
    });

    // 去重：已在 gitDiff 里出现的同文件同内容不再在 openTabs 里重复展示
    const changeTexts = new Set(changes.map((c) => c.text));
    const filteredOpenTabs = openTabs.filter((item) => !changeTexts.has(item.text));

    // 已核实的项目版本与 script setup 优先；旧服务的语法猜测不能覆盖项目版本。
    const finalFramework = input.languageId === 'vue' && (scriptSetup || vueMajor === 2 || vueMajor === 3)
      ? framework : reported ?? framework;
    if (
      members.length === 0 && relatedItems.length === 0 && focus.length === 0 &&
      snippets.length === 0 && changes.length === 0 && filteredOpenTabs.length === 0
    ) {
      return { header: EMPTY_HEADER, framework: finalFramework, region, status, near, evidence: [] };
    }
    const style = headerStyleAt(input, blocks);
    // 语言服务只知道名字，统一标成 scope；Skimmer 同名成员带有 state/handlers/props 等更具体的种类，
    // 同名时只保留具体种类，避免头部里同一个名字出现两次。
    const specificNames = new Set(members.filter((member) => member.kind !== 'scope').map((member) => member.name));
    const uniqueMembers = new Map<string, Member>();
    for (const member of members) {
      if (member.kind === 'scope' && specificNames.has(member.name)) {
        continue;
      }
      const key = `${member.kind}\0${member.name}`;
      const previous = uniqueMembers.get(key);
      if (!previous || member.signature) {
        uniqueMembers.set(key, member);
      }
    }
    const header = renderHeader({
      file: input.fileLabel,
      framework: finalFramework,
      members: [...uniqueMembers.values()],
      related: relatedItems,
      windowText: input.windowText,
      changes,
      openTabs: filteredOpenTabs,
      snippets,
      focus,
      style,
      budgetChars: input.cfg.headerChars,
    });
    // 超过 150 个字符的行在片段里被截断过，无法逐字比对，跳过
    const evidence = [...new Set([...snippets, ...near].flatMap((text) =>
      text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && line.length < 150)))];
    return { header, framework: finalFramework, region, status, near, evidence };
  };
}

export type Collector = ReturnType<typeof createCollector>;

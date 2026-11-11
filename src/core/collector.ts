// 上下文收集：并行调用各来源，受统一截止时间约束；任何来源失败只影响本次头部。
import { extractIdentifiers } from './identifiers';
import { renderHeader, type HeaderStyle } from './header';
import { detectFramework } from './framework';
import { findSfcBlocks, hasScriptSetup, regionAt, type SfcBlock } from './sfc';
import type { Config, Framework, Header, Member, Region, RelatedItem, TextSource } from './types';
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
  /** prefix + suffix，裁剪成员时使用 */
  windowText: string;
  cfg: Config;
}

export interface SourceResult {
  members?: Member[];
  related?: RelatedItem[];
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

export function createCollector(deps: CollectorDeps) {
  const now = deps.now ?? Date.now;
  return async function collect(input: CollectInput, deadlineAt: number): Promise<CollectOutcome> {
    // 防抖与限频通过之后才会走到这里，允许 O(全文) 的工作（SFC 扫描）。
    let blocks: SfcBlock[] = [];
    let region: Region = 'other';
    let scriptSetup = false;
    if (input.languageId === 'vue') {
      blocks = findSfcBlocks(input.source);
      region = regionAt(blocks, input.windowStartLine);
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
    const ctx: SourceContext = {
      ...input, framework, region, identifiers,
      ...(input.languageId === 'vue' ? { sfcBlocks: blocks } : {}),
      ...(vueMajor === 2 || vueMajor === 3 ? { projectVueMajor: vueMajor } : {}),
    };

    const status: Record<string, string> = {};
    const members: Member[] = [];
    const related: RelatedItem[] = [];
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
        reported = reported ?? r.value.framework;
      }),
    );

    // 已核实的项目版本与 script setup 优先；旧服务的语法猜测不能覆盖项目版本。
    const finalFramework = input.languageId === 'vue' && (scriptSetup || vueMajor === 2 || vueMajor === 3)
      ? framework : reported ?? framework;
    if (members.length === 0 && related.length === 0) {
      return { header: EMPTY_HEADER, framework: finalFramework, region, status };
    }
    const style: HeaderStyle = region === 'template' ? 'html' : 'line';
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
      related,
      windowText: input.windowText,
      style,
      budgetChars: input.cfg.headerChars,
    });
    return { header, framework: finalFramework, region, status };
  };
}

export type Collector = ReturnType<typeof createCollector>;

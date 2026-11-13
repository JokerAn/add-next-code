// 7.3 头部渲染：把窗口之外的上下文压成一小段注释，拼在 prefix 最前面。
import type { ChangeItem, Framework, Header, Member, RelatedItem, SourceDep } from './types';
import { EMPTY_HEADER } from './types';

export type HeaderStyle = 'line' | 'html' | 'block';

export interface HeaderInput {
  /** 相对路径，仅用于展示 */
  file: string;
  framework: Framework;
  members: Member[];
  related: RelatedItem[];
  /** 窗口文本（prefix + suffix），用于裁剪时判断成员是否相关 */
  windowText: string;
  /** 未提交的改动块，每段多行；排在成员之后（内容相对稳定），超预算时在片段之后、从末尾开始丢 */
  changes?: ChangeItem[];
  /** 其他已打开文档（含未跟踪新文件与参照文件）的相关片段 */
  openTabs?: ChangeItem[];
  /** 同文件里窗口之外的相关代码片段，每段多行；超预算时在成员之后、从末尾开始丢 */
  snippets?: string[];
  /** 针对光标处表达式的候选名字行；排在最后，裁剪时最后才丢 */
  focus?: string[];
  style: HeaderStyle;
  budgetChars: number;
}

const KIND_ORDER = ['props', 'data', 'computed', 'methods', 'watch', 'state', 'setters', 'refs', 'handlers', 'hooks', 'context', 'setup', 'symbol'];

function kindRank(kind: string): number {
  const i = KIND_ORDER.indexOf(kind);
  return i < 0 ? KIND_ORDER.length : i;
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function memberText(m: Member): string {
  return m.signature ? m.signature : m.name;
}

function renderMembers(members: Member[]): string {
  const groups = new Map<string, Member[]>();
  for (const m of members) {
    const g = groups.get(m.kind);
    if (g) {
      g.push(m);
    } else {
      groups.set(m.kind, [m]);
    }
  }
  const kinds = [...groups.keys()].sort((a, b) => kindRank(a) - kindRank(b) || (a < b ? -1 : a > b ? 1 : 0));
  return kinds
    .map((k) => `${k}: ${[...(groups.get(k) ?? [])].sort(byName).map(memberText).join(', ')}`)
    .join('; ');
}

function renderRelated(item: RelatedItem): string {
  const groups = new Map<string, Member[]>();
  for (const m of item.interface) {
    const g = groups.get(m.kind);
    if (g) {
      g.push(m);
    } else {
      groups.set(m.kind, [m]);
    }
  }
  const kinds = [...groups.keys()].sort();
  const body = kinds.map((k) => `${k} ${[...(groups.get(k) ?? [])].sort(byName).map(memberText).join(', ')}`).join('; ');
  const label = !item.kind || item.kind === 'component' ? `<${item.name}>` : `${item.kind} ${item.name}`;
  return `${label} ${item.file}${body ? ': ' + body : ''}`;
}

function wrap(lines: string[], style: HeaderStyle): string {
  const head = '[context] reference only, not part of this file';
  const tail = '[/context]';
  if (style === 'html') {
    return `<!--\n${[head, ...lines, tail].join('\n').replace(/-->/g, '-- >')}\n-->\n`;
  }
  if (style === 'block') {
    return `/*\n${[head, ...lines, tail].join('\n').replace(/\*\//g, '* /')}\n*/\n`;
  }
  return [head, ...lines, tail].map((l) => `// ${l}`).join('\n') + '\n';
}

export function renderHeader(input: HeaderInput): Header {
  const focus = input.focus ?? [];
  let snippets = input.snippets ?? [];
  let changes = input.changes ?? [];
  let openTabs = input.openTabs ?? [];
  const hasExtra = input.members.length > 0 || input.related.length > 0 || focus.length > 0 || snippets.length > 0 ||
    changes.length > 0 || openTabs.length > 0;
  if (!hasExtra) {
    return EMPTY_HEADER;
  }

  const related = [...input.related].sort(byName);
  let members = [...input.members];

  const build = (rel: RelatedItem[], mem: Member[], withMembers: boolean): { text: string; deps: SourceDep[] } => {
    const lines: string[] = [`file: ${input.file} (${input.framework})`];
    if (withMembers && mem.length > 0) {
      lines.push(`members: ${renderMembers(mem)}`);
    }
    if (changes.length > 0) {
      lines.push('uncommitted changes in this project (new code, most relevant parts):');
      for (const change of changes) {
        lines.push(...change.text.split('\n'), '...');
      }
    }
    if (openTabs.length > 0) {
      lines.push('related code in open files:');
      for (const tab of openTabs) {
        lines.push(...tab.text.split('\n'), '...');
      }
    }
    for (const r of rel) {
      lines.push(renderRelated(r));
    }
    if (snippets.length > 0) {
      lines.push('related code elsewhere in this file:');
      for (const snippet of snippets) {
        lines.push(...snippet.split('\n'), '...');
      }
    }
    lines.push(...focus);
    const deps: SourceDep[] = [];
    for (const r of rel) {
      if (r.dep) {
        deps.push(r.dep);
      }
      deps.push(...(r.deps ?? []));
    }
    for (const change of changes) {
      if (change.dep && !deps.some((dep) => dep.uri === change.dep?.uri)) {
        deps.push(change.dep);
      }
    }
    for (const tab of openTabs) {
      if (tab.dep && !deps.some((dep) => dep.uri === tab.dep?.uri)) {
        deps.push(tab.dep);
      }
    }
    return { text: wrap(lines, input.style), deps };
  };

  // 预算裁剪：先删关联项（从末尾），再删窗口里没出现的成员，再删整个 members 行，再依次删 openTabs / snippets / changes。
  let rel = related;
  let current = build(rel, members, true);
  while (current.text.length > input.budgetChars && rel.length > 0) {
    rel = rel.slice(0, -1);
    current = build(rel, members, true);
  }
  if (current.text.length > input.budgetChars) {
    members = members.filter((m) => input.windowText.includes(m.name));
    current = build(rel, members, true);
  }
  if (current.text.length > input.budgetChars) {
    current = build(rel, members, false);
  }
  while (current.text.length > input.budgetChars && openTabs.length > 0) {
    openTabs = openTabs.slice(0, -1);
    current = build(rel, members, false);
  }
  while (current.text.length > input.budgetChars && snippets.length > 0) {
    snippets = snippets.slice(0, -1);
    current = build(rel, members, false);
  }
  while (current.text.length > input.budgetChars && changes.length > 0) {
    changes = changes.slice(0, -1);
    current = build(rel, members, false);
  }
  if (current.text.length > input.budgetChars) {
    return EMPTY_HEADER;
  }
  return { text: current.text, deps: current.deps };
}

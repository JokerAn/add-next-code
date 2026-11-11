// 7.3 头部渲染：把窗口之外的上下文压成一小段注释，拼在 prefix 最前面。
import type { Framework, Header, Member, RelatedItem, SourceDep } from './types';
import { EMPTY_HEADER } from './types';

export type HeaderStyle = 'line' | 'html';

export interface HeaderInput {
  /** 相对路径，仅用于展示 */
  file: string;
  framework: Framework;
  members: Member[];
  related: RelatedItem[];
  /** 窗口文本（prefix + suffix），用于裁剪时判断成员是否相关 */
  windowText: string;
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
    return `<!--\n${[head, ...lines, tail].join('\n')}\n-->\n`;
  }
  return [head, ...lines, tail].map((l) => `// ${l}`).join('\n') + '\n';
}

export function renderHeader(input: HeaderInput): Header {
  const hasExtra = input.members.length > 0 || input.related.length > 0;
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
    for (const r of rel) {
      lines.push(renderRelated(r));
    }
    const deps: SourceDep[] = [];
    for (const r of rel) {
      if (r.dep) {
        deps.push(r.dep);
      }
      deps.push(...(r.deps ?? []));
    }
    return { text: wrap(lines, input.style), deps };
  };

  // 预算裁剪：先删关联项（从末尾），再删窗口里没出现的成员，再删整个 members 行，file 行最后丢。
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
  if (current.text.length > input.budgetChars) {
    return EMPTY_HEADER;
  }
  return { text: current.text, deps: current.deps };
}

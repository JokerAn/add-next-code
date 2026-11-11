// 7.2 从语言服务返回的符号树里提取成员名称。只取名称，不使用任何行号（行号可能已过期）。
import type { Framework, Member } from './types';
import type { SfcBlock } from './sfc';

/** 与 vscode.DocumentSymbol 结构兼容的最小形状 */
export interface SymbolNode {
  name: string;
  startLine: number;
  endLine: number;
  startCharacter?: number;
  endCharacter?: number;
  children: SymbolNode[];
  kind?: 'function' | 'variable' | 'other';
}

const VUE2_SECTIONS = ['props', 'data', 'computed', 'methods', 'watch'] as const;
const MAX_MEMBERS = 80;

function cleanName(name: string): string {
  // 语言服务有时返回 "foo()" 或带引号的键名
  return name.replace(/\(.*\)$/, '').replace(/^['"]|['"]$/g, '').trim();
}

function findSection(nodes: SymbolNode[], name: string, depth = 0): SymbolNode | undefined {
  for (const n of nodes) {
    if (cleanName(n.name) === name) {
      return n;
    }
  }
  if (depth >= 4) {
    return undefined;
  }
  for (const n of nodes) {
    const hit = findSection(n.children, name, depth + 1);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

function extractVue2(tree: SymbolNode[]): Member[] {
  const out: Member[] = [];
  for (const section of VUE2_SECTIONS) {
    const node = findSection(tree, section);
    if (!node) {
      continue;
    }
    for (const child of node.children) {
      const name = cleanName(child.name);
      if (name) {
        out.push({ kind: section, name });
      }
    }
  }
  return out;
}

function extractVue3(tree: SymbolNode[], blocks: readonly SfcBlock[] | undefined): Member[] {
  const setupBlocks = blocks?.filter((block) => block.tag === 'script' && /(^|\s)setup(\s|=|$)/.test(block.attrs)) ?? [];
  const isScriptWrapper = (node: SymbolNode) => /^(?:<script(?: setup)?>|script(?: setup)?)$/.test(node.name.trim());
  const roots = tree.flatMap((node) => isScriptWrapper(node) ? node.children : [node]);
  if (setupBlocks.length > 0) {
    return roots.filter((node) => setupBlocks.some((block) =>
      node.startLine >= block.startLine && node.endLine <= block.endLine) &&
      node.kind !== 'other' && /^[A-Za-z_$][\w$]*$/.test(cleanName(node.name)))
      .map((node) => ({ kind: 'setup', name: cleanName(node.name) }));
  }
  const options = roots.find((node) => ['default', 'export default'].includes(node.name.trim()));
  if (!options) {
    return [];
  }
  const members: Member[] = VUE2_SECTIONS.flatMap((section) => {
    const node = options.children.find((child) => cleanName(child.name) === section);
    return (node?.children ?? []).map((child) => ({ kind: section, name: cleanName(child.name) }))
      .filter((member) => member.name.length > 0);
  });
  const setup = options.children.find((node) => cleanName(node.name) === 'setup');
  // 没有明确 return 节点的符号树无法证明哪些局部绑定被公开；交给 Skimmer。
  const returns = setup?.children.filter((node) => /^return(?:\b|\s|\{)/.test(node.name.trim())) ?? [];
  const fields = returns.map((node) => {
    if (!/^return(?:\s*\{\})?$/.test(node.name.trim())) {
      return undefined;
    }
    const names = node.children.map((child) => cleanName(child.name));
    return names.every((name) => /^[A-Za-z_$][\w$]*$/.test(name)) ? names.sort() : undefined;
  });
  if (fields.length > 0 && fields[0] && fields.every((names) => names && JSON.stringify(names) === JSON.stringify(fields[0]))) {
    members.push(...fields[0].map((name) => ({ kind: 'setup', name })));
  }
  return members;
}

/** 通用兜底：包含光标的符号链名称，以及最内层容器内的同级符号名称。 */
function extractGeneric(tree: SymbolNode[], cursorLine: number): Member[] {
  const out: Member[] = [];
  let level = tree;
  for (let depth = 0; depth < 6; depth++) {
    const container = level.find((n) => n.startLine <= cursorLine && cursorLine <= n.endLine);
    for (const n of level) {
      const name = cleanName(n.name);
      if (name) {
        out.push({ kind: depth === 0 ? 'symbol' : 'scope', name });
      }
    }
    if (!container || container.children.length === 0) {
      break;
    }
    level = container.children;
  }
  return out;
}

/** React 的语言服务兜底只使用当前组件/Hook 的直接绑定，不把兄弟组件和回调局部变量带入。 */
function extractReact(tree: SymbolNode[], cursorLine: number, cursorCharacter?: number): Member[] {
  if (cursorLine < 0) {
    return [];
  }
  let owner: SymbolNode | undefined;
  const visit = (nodes: SymbolNode[]) => {
    for (const node of nodes) {
      if (cursorLine < node.startLine || cursorLine > node.endLine) {
        continue;
      }
      if (cursorCharacter !== undefined &&
        (cursorLine === node.startLine && node.startCharacter !== undefined && cursorCharacter < node.startCharacter ||
          cursorLine === node.endLine && node.endCharacter !== undefined && cursorCharacter > node.endCharacter)) {
        continue;
      }
      const name = cleanName(node.name);
      // 箭头函数组件 `const App = () => {...}` 在语言服务里是 Variable（TS 把 const/let/var 都映射为 Variable），
      // 它的子节点是函数体内的 const/function；对象常量 `const Styles = {...}` 的子节点是 property/method（kind 'other'）。
      const isFunctionLike = node.kind === 'function' || node.kind === undefined;
      const isArrowLike = node.kind === 'variable' &&
        node.children.some((child) => child.kind === 'variable' || child.kind === 'function');
      if ((isFunctionLike || isArrowLike) && node.children.length > 0 &&
        (/^[A-Z]/.test(name) || /^use[A-Z]/.test(name) || name === 'default')) {
        owner = node;
      }
      visit(node.children);
    }
  };
  visit(tree);
  if (!owner) {
    return [];
  }
  return owner.children.flatMap((child) => {
    const name = cleanName(child.name);
    // 某些语言服务把解构声明表示为一个符号；这里只展开简单名称，不猜复杂 pattern。
    const tuple = /^\[\s*([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*\]$/.exec(name);
    const names = tuple ? tuple[1]!.split(',').map((item) => item.trim()) : [name];
    return names.filter((item) => /^[A-Za-z_$][\w$]*$/.test(item))
      .map((item) => ({ kind: 'scope', name: item }));
  });
}

export function extractMembers(
  tree: SymbolNode[], framework: Framework, cursorLine: number, cursorCharacter?: number, sfcBlocks?: readonly SfcBlock[],
): Member[] {
  const members = framework === 'vue2' ? extractVue2(tree)
    : framework === 'vue3' ? extractVue3(tree, sfcBlocks)
    : framework === 'react' ? extractReact(tree, cursorLine, cursorCharacter) : extractGeneric(tree, cursorLine);
  // 去重并限量
  const seen = new Set<string>();
  const result: Member[] = [];
  for (const m of members) {
    const key = `${m.kind}:${m.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(m);
    }
    if (result.length >= MAX_MEMBERS) {
      break;
    }
  }
  return result;
}

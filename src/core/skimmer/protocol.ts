import type { Member } from '../types';

export interface Fingerprint {
  mtimeMs: number;
  size: number;
}

export interface CompletionContextRequest {
  protocol: 1;
  vue_major?: 2 | 3;
  project_path: string;
  file_path: string;
  document: { text: string };
  cursor: { line: number; character: number };
  identifiers: string[];
  dirty_files: string[];
  max_items: number;
  budget_chars: number;
  deadline_ms: number;
}

export interface CompletionContextResponse {
  protocol: 1;
  framework: 'vue2' | 'vue3' | 'react' | 'ts' | 'js' | 'unknown';
  overlay: { state: 'ready' | 'stale' | 'failed' };
  index: { state: 'ready' | 'indexing' | 'empty' | 'locked'; watching?: boolean };
  self: { members: Member[]; truncated: boolean } | null;
  related: Array<{
    kind: 'component' | 'hook' | 'module' | 'store';
    name: string;
    file: string;
    binding: 'static' | 'heuristic';
    interface: Member[];
    fingerprint: Fingerprint;
    dependencies?: Array<{ file: string; fingerprint: Fingerprint }>;
  }>;
  dropped: Array<{ file: string; reason: 'dirty' | 'stale' | 'budget' }>;
  elapsedMs: number;
}

export class IncompatibleSkimmerError extends Error {}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function members(value: unknown): Member[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, 200).flatMap((item) => {
    const m = object(item);
    if (!m || typeof m.kind !== 'string' || typeof m.name !== 'string') {
      return [];
    }
    return [{
      kind: m.kind.slice(0, 80),
      name: m.name.slice(0, 256),
      ...(typeof m.signature === 'string' ? { signature: m.signature.slice(0, 1024) } : {}),
    }];
  });
}

function fingerprint(value: unknown): Fingerprint | undefined {
  const v = object(value);
  if (!v || typeof v.mtimeMs !== 'number' || !Number.isFinite(v.mtimeMs) ||
    typeof v.size !== 'number' || !Number.isFinite(v.size) || v.size < 0) {
    return undefined;
  }
  return { mtimeMs: v.mtimeMs, size: v.size };
}

/** MCP 工具返回值按 protocol 解码，旧工具/错误响应不能冒充增强上下文。 */
export function parseCompletionContext(value: unknown): CompletionContextResponse {
  const v = object(value);
  if (!v || v.protocol !== 1) {
    throw new IncompatibleSkimmerError('需要补全协议 protocol=1，请升级 Skimmer');
  }
  const indexData = object(v.index);
  const index = indexData?.state;
  const overlay = object(v.overlay)?.state;
  if (!['ready', 'indexing', 'empty', 'locked'].includes(String(index)) ||
    !['ready', 'stale', 'failed'].includes(String(overlay))) {
    throw new IncompatibleSkimmerError('Skimmer 补全响应结构不兼容');
  }
  const framework = ['vue2', 'vue3', 'react', 'ts', 'js'].includes(String(v.framework))
    ? v.framework as CompletionContextResponse['framework']
    : 'unknown';
  const self = object(v.self);
  const related: CompletionContextResponse['related'] = [];
  if (Array.isArray(v.related)) {
    for (const raw of v.related.slice(0, 8)) {
      const item = object(raw);
      const fp = fingerprint(item?.fingerprint);
      if (!item || !fp || typeof item.name !== 'string' || typeof item.file !== 'string' ||
        item.binding !== 'static' || !['component', 'hook', 'module', 'store'].includes(String(item.kind))) {
        continue;
      }
      const dependencies: NonNullable<CompletionContextResponse['related'][number]['dependencies']> = [];
      let valid = true;
      if (item.dependencies !== undefined) {
        if (!Array.isArray(item.dependencies) || item.dependencies.length > 16) {
          continue;
        }
        for (const rawDep of item.dependencies) {
          const dep = object(rawDep);
          const depFp = fingerprint(dep?.fingerprint);
          if (!dep || typeof dep.file !== 'string' || !depFp) {
            valid = false;
            break;
          }
          dependencies.push({ file: dep.file, fingerprint: depFp });
        }
      }
      if (valid) {
        related.push({
          kind: item.kind as CompletionContextResponse['related'][number]['kind'],
          name: item.name.slice(0, 256), file: item.file, binding: 'static',
          interface: members(item.interface), fingerprint: fp, dependencies,
        });
      }
    }
  }
  return {
    protocol: 1, framework,
    overlay: { state: overlay as CompletionContextResponse['overlay']['state'] },
    index: {
      state: index as CompletionContextResponse['index']['state'],
      ...(typeof indexData?.watching === 'boolean' ? { watching: indexData.watching } : {}),
    },
    self: self ? { members: members(self.members), truncated: self.truncated === true } : null,
    related,
    dropped: [],
    elapsedMs: typeof v.elapsedMs === 'number' ? v.elapsedMs : 0,
  };
}

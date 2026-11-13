// 6.3 来源依赖复核：发给模型的头部引用了哪些关联文件，以及它们当时的指纹。
import type { SourceDep } from './types';

export interface DepsIo {
  /** 文件当前指纹；文件不存在返回 undefined */
  stat(uri: string): Promise<{ mtimeMs: number; size: number } | undefined>;
  /** 该文件在本窗口是否处于未保存状态（支持同步或异步返回） */
  isDirty(uri: string): boolean | Promise<boolean>;
}

/** deps 为空时直接有效，不产生任何 IO。 */
export async function depsValid(deps: readonly SourceDep[], io: DepsIo): Promise<boolean> {
  if (deps.length === 0) {
    return true;
  }
  const dirtyFlags = await Promise.all(deps.map((d) => io.isDirty(d.uri)));
  if (dirtyFlags.some(Boolean)) {
    return false;
  }
  const stats = await Promise.all(deps.map((d) => io.stat(d.uri).catch(() => undefined)));
  for (let i = 0; i < deps.length; i++) {
    const d = deps[i];
    const s = stats[i];
    if (!d || !s || s.mtimeMs !== d.mtimeMs || s.size !== d.size) {
      return false;
    }
  }
  return true;
}

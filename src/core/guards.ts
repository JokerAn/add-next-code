// 6.1 入口守卫：全部是 O(1) 的同步检查，任一不满足立即放弃本次调用。
import type { HealthState } from './backoff';
import type { Config, TriggerKind } from './types';

export type GuardReason =
  | 'disabled'
  | 'scheme'
  | 'not-permitted'
  | 'no-key'
  | 'editor-mismatch'
  | 'multi-cursor'
  | 'selection'
  | 'manual-only'
  | 'health'
  | 'sci-skip';

export interface GuardInput {
  cfg: Config;
  /** 运行时的全局开关（命令切换） */
  runtimeEnabled: boolean;
  languageId: string;
  scheme: string;
  /** 发送许可判定结果；undefined 表示尚未得出结果，按"不许可"处理 */
  permitted: boolean | undefined;
  hasKey: boolean;
  isActiveEditorDoc: boolean;
  selectionCount: number;
  selectionEmpty: boolean;
  cursorAtPosition: boolean;
  trigger: TriggerKind;
  hasSelectedCompletion: boolean;
  health: HealthState;
}

const ALLOWED_SCHEMES = new Set(['file', 'untitled', 'vscode-remote']);

export function languageEnabled(cfg: Config, languageId: string): boolean {
  const v = cfg.enableByLanguage[languageId];
  if (v !== undefined) {
    return v;
  }
  return cfg.enableByLanguage['*'] ?? true;
}

/** 通过返回 undefined，否则返回第一个不满足的原因。 */
export function checkGuards(g: GuardInput): GuardReason | undefined {
  // 1
  if (!g.runtimeEnabled || !g.cfg.enabled || !languageEnabled(g.cfg, g.languageId)) {
    return 'disabled';
  }
  // 2
  if (!ALLOWED_SCHEMES.has(g.scheme)) {
    return 'scheme';
  }
  // 3：发送许可判定；未得出结果按不许可
  if (g.permitted !== true) {
    return 'not-permitted';
  }
  // 4
  if (!g.hasKey) {
    return 'no-key';
  }
  // 5
  if (!g.isActiveEditorDoc || !g.cursorAtPosition) {
    return 'editor-mismatch';
  }
  if (g.selectionCount !== 1) {
    return 'multi-cursor';
  }
  if (!g.selectionEmpty) {
    return 'selection';
  }
  // 6
  if (g.trigger === 'auto' && g.cfg.triggerMode === 'manual') {
    return 'manual-only';
  }
  // 7
  if (!g.health.canRequest(g.trigger === 'manual')) {
    return 'health';
  }
  // 8
  if (g.hasSelectedCompletion && g.cfg.suggestWidget === 'skip') {
    return 'sci-skip';
  }
  return undefined;
}

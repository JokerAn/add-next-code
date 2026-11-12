// 把窗口与头部组织成 FIM 请求。
import { cutBalanced, cutStatement } from '../linePolicy';
import type { Config, Header } from '../types';
import type { WindowResult } from '../window';
import type { FimRequest } from './client';

const CLOSING_CHARS = new Set([')', ']', '}', '>', "'", '"', '`', ';', ',']);

/**
 * 单行模式判定：光标之后当前行剩余文本去掉首尾空白后，若非空且不是只由闭合符号组成，则为单行模式。
 */
export function isSingleLineMode(suffix: string): boolean {
  const nl = suffix.indexOf('\n');
  const rest = (nl < 0 ? suffix : suffix.slice(0, nl)).trim();
  if (rest === '') {
    return false;
  }
  for (const ch of rest) {
    if (!CLOSING_CHARS.has(ch)) {
      return true;
    }
  }
  return false;
}

export function buildFimRequest(
  win: Pick<WindowResult, 'prefix' | 'suffix'>,
  header: Header,
  manual: boolean,
  cfg: Config,
  signal: AbortSignal,
  /** 空行只补一条语句（见 linePolicy） */
  statement = false,
  /** 光标在注释或刚打开的代码块之后：预期要写一整段，输出上限放宽到手动触发的水平 */
  block = false,
): FimRequest {
  const single = isSingleLineMode(win.suffix);
  return {
    prompt: header.text + win.prefix,
    suffix: win.suffix,
    maxTokens: manual || block ? Math.max(cfg.maxTokens, cfg.maxTokensManual) : cfg.maxTokens,
    temperature: cfg.temperature,
    stop: single ? ['\n'] : undefined,
    // 语句模式按语句截断，行数上限只是兜底；其余按"配平后再截"，硬上限是两倍行数
    maxLines: statement ? cfg.maxLines : cfg.maxLines * 2,
    cut: statement ? cutStatement : (text: string) => cutBalanced(text, cfg.maxLines),
    signal,
  };
}

export function modelKeyOf(cfg: Config): string {
  return `${cfg.endpoint}|${cfg.model}|${cfg.temperature}|${cfg.maxTokens}`;
}

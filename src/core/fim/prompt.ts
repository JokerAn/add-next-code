// 把窗口与头部组织成 FIM 请求。
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
): FimRequest {
  const single = isSingleLineMode(win.suffix);
  return {
    prompt: header.text + win.prefix,
    suffix: win.suffix,
    maxTokens: manual ? cfg.maxTokensManual : cfg.maxTokens,
    temperature: cfg.temperature,
    stop: single ? ['\n'] : undefined,
    maxLines: cfg.maxLines,
    signal,
  };
}

export function modelKeyOf(cfg: Config): string {
  return `${cfg.endpoint}|${cfg.model}|${cfg.temperature}|${cfg.maxTokens}`;
}

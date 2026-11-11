// 6.5 错误分类。状态码语义以 DeepSeek 官方文档为准，阶段 0 用假 Key 等实测核对。

export type FimErrorKind = 'auth' | 'balance' | 'config' | 'rate' | 'transient';

export class FimError extends Error {
  readonly kind: FimErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(kind: FimErrorKind, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'FimError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function classifyStatus(status: number): FimErrorKind {
  if (status === 401 || status === 403) {
    return 'auth';
  }
  if (status === 402) {
    return 'balance';
  }
  if (status === 400 || status === 404 || status === 422) {
    return 'config';
  }
  if (status === 429) {
    return 'rate';
  }
  return 'transient';
}

/** Retry-After 既可能是秒数也可能是 HTTP 日期；解析失败返回 undefined。 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) {
    return undefined;
  }
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) {
    return secs * 1000;
  }
  const at = Date.parse(value);
  if (Number.isFinite(at)) {
    return Math.max(0, at - now);
  }
  return undefined;
}

export function httpError(status: number, bodyText: string, retryAfter?: string | null): FimError {
  const kind = classifyStatus(status);
  const snippet = bodyText.replace(/\s+/g, ' ').slice(0, 200);
  return new FimError(kind, `HTTP ${status}${snippet ? ': ' + snippet : ''}`, status, parseRetryAfter(retryAfter));
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR');
}

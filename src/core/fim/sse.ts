// 6.5 SSE 行解析：流式解码、跨 chunk 半行缓冲、兼容 \r\n、忽略空行与注释行。

export class SseDecoder {
  private readonly decoder = new TextDecoder('utf-8');
  private buffer = '';

  /** 喂入一个字节块，返回其中完整的 data 行负载（可能包含 "[DONE]"）。 */
  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /** 流结束时调用，处理最后一行没有换行符的情况。 */
  flush(): string[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf('\n', start);
      if (nl < 0) {
        break;
      }
      this.consumeLine(this.buffer.slice(start, nl), out);
      start = nl + 1;
    }
    this.buffer = this.buffer.slice(start);
    if (final && this.buffer.length > 0) {
      this.consumeLine(this.buffer, out);
      this.buffer = '';
    }
    return out;
  }

  private consumeLine(raw: string, out: string[]): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '' || line.startsWith(':')) {
      return;
    }
    if (!line.startsWith('data:')) {
      return;
    }
    const payload = line.slice(5);
    out.push(payload.startsWith(' ') ? payload.slice(1) : payload);
  }
}

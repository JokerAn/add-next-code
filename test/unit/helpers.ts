import type { CancelToken, TextSource } from '../../src/core/types';

export function src(text: string): TextSource {
  const lines = text.split('\n');
  return {
    get lineCount() {
      return lines.length;
    },
    lineAt(n: number) {
      return lines[n] ?? '';
    },
  };
}

/** 可变文档：用于模拟编辑 */
export class MutableDoc {
  lines: string[];
  version = 1;
  constructor(text: string) {
    this.lines = text.split('\n');
  }
  get source(): TextSource {
    const self = this;
    return {
      get lineCount() {
        return self.lines.length;
      },
      lineAt(n: number) {
        return self.lines[n] ?? '';
      },
    };
  }
  setLine(n: number, text: string): void {
    this.lines[n] = text;
    this.version++;
  }
  insertAt(line: number, character: number, text: string): void {
    const l = this.lines[line] ?? '';
    this.lines[line] = l.slice(0, character) + text + l.slice(character);
    this.version++;
  }
}

export class TestToken implements CancelToken {
  isCancellationRequested = false;
  private listeners = new Set<() => void>();
  onCancellationRequested(listener: () => void) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  cancel(): void {
    if (this.isCancellationRequested) {
      return;
    }
    this.isCancellationRequested = true;
    for (const l of [...this.listeners]) {
      l();
    }
  }
}

export function numberedLines(n: number, width = 10): string {
  return Array.from({ length: n }, (_, i) => `L${i}`.padEnd(width, '.')).join('\n');
}

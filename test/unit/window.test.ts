import { describe, expect, it, vi } from 'vitest';
import { buildWindow, cursorOf, readPrefix, readSuffix, WINDOW_ALIGN_LINES, type WindowLimits } from '../../src/core/window';
import { numberedLines, src } from './helpers';

const limits: WindowLimits = { prefixChars: 6000, suffixChars: 1500, maxPrefixLines: 300, maxSuffixLines: 100 };

describe('buildWindow', () => {
  it('短文件：prefix/suffix 就是光标两侧全文', () => {
    const s = src('const a = 1;\nconst b = |2;\nconst c = 3;'.replace('|', ''));
    const w = buildWindow(s, { line: 1, character: 10 }, undefined, limits);
    expect(w.prefix).toBe('const a = 1;\nconst b = ');
    expect(w.suffix).toBe('2;\nconst c = 3;');
    expect(w.startLine).toBe(0);
    expect(w.anchorLine).toBe(1);
  });

  it('光标两侧紧邻字符不被改动（空行、行首、行尾）', () => {
    const s = src('abc\n\ndef');
    expect(buildWindow(s, { line: 1, character: 0 }, undefined, limits)).toMatchObject({ prefix: 'abc\n', suffix: '\ndef' });
    expect(buildWindow(s, { line: 0, character: 3 }, undefined, limits)).toMatchObject({ prefix: 'abc', suffix: '\n\ndef' });
    expect(buildWindow(s, { line: 2, character: 3 }, undefined, limits)).toMatchObject({ prefix: 'abc\n\ndef', suffix: '' });
  });

  it('前缀起点按 25 行对齐，且不超过行数与字符预算', () => {
    const text = numberedLines(10_000);
    const s = src(text);
    const cursorLine = 5_000;
    const w = buildWindow(s, { line: cursorLine, character: 5 }, undefined, { ...limits, prefixChars: 100_000 });
    expect(w.startLine % WINDOW_ALIGN_LINES).toBe(0);
    expect(cursorLine - w.startLine).toBeLessThanOrEqual(300);
    expect(w.prefix.split('\n').length).toBe(cursorLine - w.startLine + 1);
  });

  it('光标在小行号处：对齐后不会超过光标行', () => {
    const s = src(numberedLines(100));
    const w = buildWindow(s, { line: 3, character: 0 }, undefined, limits);
    expect(w.startLine).toBe(0);
  });

  it('字符预算限制前缀', () => {
    const s = src(numberedLines(2000, 100)); // 每行 100 字符
    const w = buildWindow(s, { line: 1000, character: 0 }, undefined, { ...limits, prefixChars: 2000 });
    expect(w.prefix.length).toBeLessThanOrEqual(2000);
  });

  it('连续移动光标时起点稳定（共享前缀）', () => {
    const s = src(numberedLines(1000, 20));
    const starts = new Set<number>();
    for (let line = 500; line < 520; line++) {
      starts.add(buildWindow(s, { line, character: 0 }, undefined, limits).startLine);
    }
    expect(starts.size).toBeLessThanOrEqual(2);
  });

  it('光标所在行很长：只保留紧邻光标的一半预算，且从非行首开始', () => {
    const long = 'x'.repeat(20_000);
    const s = src(`first\n${long}\nlast`);
    const w = buildWindow(s, { line: 1, character: 10_000 }, undefined, limits);
    expect(w.prefix.length).toBe(3000);
    expect(w.startLine).toBe(1);
    expect(w.startChar).toBe(10_000 - 3000);
    expect(w.suffix.length).toBe(750);
  });

  it('后缀受行数与字符预算约束', () => {
    const s = src(numberedLines(1000, 50));
    const w = buildWindow(s, { line: 0, character: 0 }, undefined, { ...limits, suffixChars: 100_000, maxSuffixLines: 10 });
    expect(w.suffix.split('\n').length).toBe(10);
    const w2 = buildWindow(s, { line: 0, character: 0 }, undefined, { ...limits, suffixChars: 200 });
    expect(w2.suffix.length).toBeLessThanOrEqual(200);
  });

  it('emoji（非 BMP）与 Tab 不被破坏', () => {
    const s = src('\t😀 const a = ;\nnext');
    const w = buildWindow(s, { line: 0, character: 13 }, undefined, limits);
    expect(w.prefix + w.suffix).toBe('\t😀 const a = ;\nnext');
  });

  it('菜单选中项：虚拟光标 = 已接受选中项', () => {
    const s = src('console.\nrest');
    // 文档 `console.`，选中项 `.log` 替换 `.`（7..8）
    const w = buildWindow(s, { line: 0, character: 8 }, { start: { line: 0, character: 7 }, end: { line: 0, character: 8 }, text: '.log' }, limits);
    expect(w.prefix).toBe('console.log');
    expect(w.suffix).toBe('\nrest');
    expect(w.anchorLine).toBe(0);
  });

  it('超过预算的菜单选中项只保留虚拟光标前的有限尾部', () => {
    const s = src('before x after');
    const sci = {
      start: { line: 0, character: 7 }, end: { line: 0, character: 8 },
      text: 'a'.repeat(8000) + '\nlast line',
    };
    const pos = { line: 0, character: 8 };
    const w = buildWindow(s, pos, sci, limits);
    expect(w.prefix).toBe(sci.text.slice(-3000));
    expect(w.prefix.length).toBeLessThanOrEqual(limits.prefixChars);
    expect(w.suffix).toBe(' after');
    expect(readPrefix(s, w.startLine, w.startChar, cursorOf(pos, sci))).toBe(w.prefix);
  });
});

describe('readPrefix 与 buildWindow 口径一致', () => {
  it('从窗口起点重新读取得到同一个 prefix', () => {
    const s = src(numberedLines(800, 30));
    const pos = { line: 400, character: 7 };
    const w = buildWindow(s, pos, undefined, limits);
    expect(readPrefix(s, w.startLine, w.startChar, cursorOf(pos))).toBe(w.prefix);
  });

  it('readSuffix 与 buildWindow 一致', () => {
    const s = src(numberedLines(50));
    const pos = { line: 3, character: 2 };
    expect(readSuffix(s, cursorOf(pos), limits)).toBe(buildWindow(s, pos, undefined, limits).suffix);
  });

  it('有限读取达到字符上限时立即停止读取后续行', () => {
    const lineAt = vi.fn(() => 'abcd');
    const s = { lineCount: 100_000, lineAt };
    const cursor = cursorOf({ line: 99_999, character: 4 });
    expect(readPrefix(s, 0, 0, cursor, 9)).toBe('abcd\nabcd');
    expect(lineAt).toHaveBeenCalledTimes(2);
  });
});

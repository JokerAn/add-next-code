import { describe, expect, it } from 'vitest';
import { detectFramework } from '../../src/core/framework';
import { extractIdentifiers, openTagAt } from '../../src/core/identifiers';
import { findSfcBlocks, hasScriptSetup, regionAt } from '../../src/core/sfc';
import { src } from './helpers';

const sfc = `<template>
  <div>
    <template v-if="ok">
      <Child />
    </template>
  </div>
</template>

<script>
export default {
  name: 'A',
}
</script>

<style scoped>
.a { color: red; }
</style>`;

describe('findSfcBlocks', () => {
  it('定位顶层区块并正确处理嵌套 <template>', () => {
    const blocks = findSfcBlocks(src(sfc));
    expect(blocks.map((b) => [b.tag, b.startLine, b.endLine])).toEqual([
      ['template', 0, 6],
      ['script', 8, 12],
      ['style', 14, 16],
    ]);
  });

  it('区域判定', () => {
    const blocks = findSfcBlocks(src(sfc));
    expect(regionAt(blocks, 3)).toBe('template');
    expect(regionAt(blocks, 10)).toBe('script');
    expect(regionAt(blocks, 15)).toBe('style');
    expect(regionAt(blocks, 7)).toBe('other');
  });

  it('输入中途：标签未闭合时区块延伸到文件末尾', () => {
    const blocks = findSfcBlocks(src('<template>\n  <div>\n'));
    expect(blocks).toEqual([{ tag: 'template', startLine: 0, endLine: 2, attrs: '' }]);
  });

  it('script setup 识别', () => {
    expect(hasScriptSetup(findSfcBlocks(src('<script setup lang="ts">\nconst a = 1\n</script>')))).toBe(true);
    expect(hasScriptSetup(findSfcBlocks(src('<script>\nexport default {}\n</script>')))).toBe(false);
  });

  it('单行 <script src></script>', () => {
    const blocks = findSfcBlocks(src('<script src="./a.js"></script>\n<template>\n</template>'));
    expect(blocks[0]).toMatchObject({ tag: 'script', startLine: 0, endLine: 0 });
    expect(blocks[1]).toMatchObject({ tag: 'template', startLine: 1, endLine: 2 });
  });
});

describe('detectFramework', () => {
  const empty = src('');
  it('vue 按规则顺序', () => {
    expect(detectFramework({ languageId: 'vue', source: empty, scriptSetup: true })).toBe('vue3');
    expect(detectFramework({ languageId: 'vue', source: empty, vueMajor: 3 })).toBe('vue3');
    expect(detectFramework({ languageId: 'vue', source: empty, vueMajor: 2 })).toBe('vue2');
    expect(detectFramework({ languageId: 'vue', source: empty, scriptText: 'export default defineComponent({})' })).toBe('vue3');
    expect(detectFramework({ languageId: 'vue', source: empty })).toBe('vue2');
  });
  it('react / node / generic', () => {
    expect(detectFramework({ languageId: 'typescriptreact', source: empty })).toBe('react');
    expect(detectFramework({ languageId: 'javascript', source: src("import React from 'react'") })).toBe('react');
    expect(detectFramework({ languageId: 'typescript', source: src("import fs from 'node:fs'") })).toBe('node');
    expect(detectFramework({ languageId: 'python', source: empty })).toBe('generic');
  });
});

describe('extractIdentifiers', () => {
  it('未闭合标签名优先，其次当前行，再由近到远', () => {
    const s = src('const total = 1\nconst other = 2\n<OrderTable :rows="list" ');
    const ids = extractIdentifiers(s, 2, 25);
    expect(ids[0]).toBe('OrderTable');
    expect(ids).toContain('rows');
    expect(ids.indexOf('other')).toBeLessThan(ids.indexOf('total'));
  });

  it('过滤关键字与过短标识符，最多 20 个', () => {
    const many = Array.from({ length: 50 }, (_, i) => `name${i}`).join(' ');
    const ids = extractIdentifiers(src(`const a = ${many}`), 0, 5);
    expect(ids).not.toContain('const');
    expect(ids).not.toContain('a');
    expect(ids.length).toBe(20);
  });

  it('openTagAt', () => {
    expect(openTagAt('<div>\n<Foo a="1" ')).toBe('Foo');
    expect(openTagAt('<Foo a="1">')).toBeUndefined();
    expect(openTagAt('a < b')).toBeUndefined();
  });
});

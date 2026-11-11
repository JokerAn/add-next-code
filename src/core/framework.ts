// 7.1 框架识别。结果只影响头部组织方式与指标标签，不影响请求链路。
import type { Framework, TextSource } from './types';

export interface FrameworkInput {
  languageId: string;
  source: TextSource;
  /** 仅 .vue：是否存在 <script setup> */
  scriptSetup?: boolean;
  /** 最近 package.json 里 vue 的主版本；未知为 undefined */
  vueMajor?: number;
  /** 仅 .vue：脚本区文本片段（用于 defineComponent( / setup( 判断），可为空 */
  scriptText?: string;
}

const REACT_IMPORT_RE = /\bfrom\s+['"]react['"]|require\(\s*['"]react['"]\s*\)/;

export function detectFramework(input: FrameworkInput): Framework {
  const { languageId } = input;
  if (languageId === 'vue') {
    if (input.scriptSetup) {
      return 'vue3';
    }
    if (input.vueMajor === 3) {
      return 'vue3';
    }
    if (input.vueMajor === 2) {
      return 'vue2';
    }
    if (input.scriptText && /\bdefineComponent\s*\(|\bsetup\s*\(/.test(input.scriptText)) {
      return 'vue3';
    }
    return 'vue2';
  }
  if (languageId === 'javascriptreact' || languageId === 'typescriptreact') {
    return 'react';
  }
  if (languageId === 'javascript' || languageId === 'typescript') {
    const n = Math.min(50, input.source.lineCount);
    for (let i = 0; i < n; i++) {
      if (REACT_IMPORT_RE.test(input.source.lineAt(i))) {
        return 'react';
      }
    }
    return 'node';
  }
  return 'generic';
}

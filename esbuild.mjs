import { build } from 'esbuild';

const watch = process.argv.includes('--watch');
const ctx = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  minify: !watch,
  // 构建时间写进产物，日志里据此确认当前窗口运行的是哪一次构建
  define: { __BUILD_ID__: JSON.stringify(new Date().toISOString()) },
  logLevel: 'info',
};

await build(ctx);

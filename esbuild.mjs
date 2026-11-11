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
  logLevel: 'info',
};

await build(ctx);

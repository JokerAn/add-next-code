// 阶段 0.5：测量 Skimmer 的 parseFile 在大文件、语法不完整文本上的耗时与结果。
// 本脚本不在 Skimmer 仓库里，运行时把 Skimmer 路径当参数传入，由 Skimmer 自己的 tsx 执行：
//   cd <skimmer 仓库> && npx tsx <本仓库>/tools/skimmer-parse-bench.mts --skimmer <skimmer 仓库> --file <万行 .vue 文件> [--runs 20]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function opt(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const skimmer = opt('skimmer');
const file = opt('file');
const runs = Number(opt('runs', '20'));
if (!skimmer || !file) {
  console.error('需要 --skimmer <路径> 与 --file <文件>');
  process.exit(2);
}

const mod = await import(pathToFileURL(path.resolve(skimmer, 'src/parser/index.ts')).href);
const parseFile = mod.parseFile as (filePath: string, content: string) => { symbols: unknown[]; errors?: string[]; framework: string };

const abs = path.resolve(file);
const text = fs.readFileSync(abs, 'utf8');
const lines = text.split('\n');

function pct(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? 0;
}

function bench(label: string, content: string): void {
  const times: number[] = [];
  let last: ReturnType<typeof parseFile> | undefined;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    last = parseFile(abs, content);
    times.push(performance.now() - t0);
  }
  console.log(
    JSON.stringify({
      case: label,
      bytes: Buffer.byteLength(content),
      lines: content.split('\n').length,
      framework: last?.framework,
      symbols: last?.symbols.length,
      errors: last?.errors?.slice(0, 2),
      firstMs: Math.round(times[0] ?? 0),
      p50Ms: Math.round(pct(times, 50)),
      p95Ms: Math.round(pct(times, 95)),
    }),
  );
}

console.log(`文件：${abs}（${lines.length} 行，${Buffer.byteLength(text)} 字节），每项 ${runs} 次`);
bench('完整文件', text);

// 语法不完整：在文件中部插入未闭合的括号与表达式
const mid = Math.floor(lines.length / 2);
const broken = [...lines.slice(0, mid), 'const unfinished = foo(bar, {', ...lines.slice(mid)].join('\n');
bench('光标处括号未闭合', broken);

// 模板标签没写完：在 <template> 区内插入未闭合标签
const tplLine = lines.findIndex((l) => l.includes('<template'));
if (tplLine >= 0) {
  const t = [...lines.slice(0, tplLine + 2), '<Child :prop="value" @click="', ...lines.slice(tplLine + 2)].join('\n');
  bench('模板标签未写完', t);
}

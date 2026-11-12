#!/usr/bin/env node
// 使用生产客户端验证发布包或本地构建；只创建临时项目，不调用模型。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repo = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const localAt = args.indexOf('--local');
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--local' || !args[1])) {
  throw new Error('用法：node tools/skimmer-smoke.mjs [--local /absolute/path/to/dist/index.js]');
}
const manifest = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));
const properties = manifest.contributes.configuration.properties;
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'add-next-code-skimmer-smoke-')));
const project = path.join(base, 'project');
await fs.mkdir(project);
const fixtures = {
  'package.json': '{"name":"inline-smoke","dependencies":{"vue":"2.7.16"}}',
  'App.vue': '<script>import Child from "./Child.vue";export default {components:{Child},data(){return {rows:[]}},methods:{load(){}}};</script>\n<template><Child :rows="rows"/></template>',
  'Child.vue': '<script>export default {props:["rows"],emits:["pick"]};</script><template><div/></template>',
  'Setup.vue': '<script setup>import SetupChild from "./SetupChild.vue";const count=1;</script>\n<template><SetupChild :count="count"/></template>',
  'SetupChild.vue': '<script setup>defineProps({count:Number});defineEmits(["change"]);</script><template><div/></template>',
  'App.tsx': 'import {useState} from "react";import ReactChild from "./ReactChild";\nexport function App(){const [count,setCount]=useState(0);return <ReactChild count={count}/>;}',
  'ReactChild.tsx': 'export default function ReactChild({count}){return <div>{count}</div>;}',
  'main.mts': 'import {read} from "./typed.mjs";\nexport function main(){return read("");}',
  'typed.mts': 'export function read(file:string){return file;}',
};
await Promise.all(Object.entries(fixtures).map(([file, text]) => fs.writeFile(path.join(project, file), text)));
const records = [];
const statuses = [];
const checks = [];
let client;
try {
  const bundle = path.join(base, 'client.cjs');
  await build({
    stdin: { contents: "export {SkimmerClient} from './src/core/skimmer/client';", resolveDir: repo },
    platform: 'node', target: 'node22', format: 'cjs', bundle: true, outfile: bundle, logLevel: 'silent',
  });
  const { SkimmerClient } = createRequire(import.meta.url)(bundle);
  client = new SkimmerClient({
    options: () => ({
      enabled: true,
      command: localAt >= 0 ? process.execPath : properties['addNextCode.skimmer.command'].default,
      args: localAt >= 0 ? [path.resolve(args[localAt + 1])] : properties['addNextCode.skimmer.args'].default,
      nodePath: process.execPath, cacheDir: path.join(base, 'cache'),
    }),
    status: (value) => { statuses.push(value); },
    log: (line) => console.log(line),
    onIndexChanged() {},
    onQuery: (record) => records.push(record),
  });
  client.ensureStarted();
  const startDeadline = Date.now() + 130_000;
  while (!client.ready && Date.now() < startDeadline) {
    assert.ok(!statuses.at(-1)?.startsWith('降级：'), statuses.at(-1));
    await delay(100);
  }
  assert.equal(client.ready, true, `Skimmer 未就绪：${statuses.at(-1)}`);
  checks.push('production client Node probe, startup and tool capability handshake');
  const query = async (file, marker, identifiers, extra = {}) => {
    const text = fixtures[file];
    const offset = text.indexOf(marker);
    assert.ok(offset >= 0, marker);
    const prefix = text.slice(0, offset).split('\n');
    return client.query({
      protocol: 1, project_path: project, file_path: path.join(project, file), document: { text },
      cursor: { line: prefix.length - 1, character: prefix.at(-1).length },
      identifiers, dirty_files: [], max_items: 8, budget_chars: 8000, deadline_ms: 2000, ...extra,
    }, Date.now() + 2000);
  };
  for (const sample of [
    { file: 'App.vue', marker: ':rows=', ids: ['Child'], framework: 'vue2', target: 'Child.vue', member: 'rows' },
    { file: 'Setup.vue', marker: ':count=', ids: ['SetupChild'], framework: 'vue3', target: 'SetupChild.vue', member: 'count', extra: { vue_major: 3 } },
    { file: 'App.tsx', marker: ' count=', ids: ['ReactChild'], framework: 'react', target: 'ReactChild.tsx', member: 'count' },
    { file: 'main.mts', marker: 'return read', ids: ['read'], framework: 'ts', target: 'typed.mts', member: 'read' },
  ]) {
    let result;
    for (let attempt = 0; attempt < 60; attempt++) {
      result = await query(sample.file, sample.marker, sample.ids, sample.extra);
      if (result?.overlay.state === 'ready' && result.related.some((item) => item.file === sample.target)) {
        break;
      }
      await delay(100);
    }
    assert.equal(result?.framework, sample.framework, sample.file);
    assert.equal(result?.overlay.state, 'ready', sample.file);
    const related = result.related.find((item) => item.file === sample.target);
    assert.ok(related?.interface.some((member) => member.name === sample.member), sample.file);
    assert.ok(related.fingerprint.size > 0, sample.file);
    const dirty = await query(sample.file, sample.marker, sample.ids, { ...sample.extra, dirty_files: [sample.target] });
    assert.equal(dirty.related.some((item) => item.file === sample.target), false);
    assert.ok(dirty.dropped.some((item) => item.file === sample.target && item.reason === 'dirty'));
    checks.push(`${sample.framework} current overlay, static related, fingerprint and dirty filtering`);
  }
  assert.ok(records.some((record) => record.dropped.dirty > 0));
  assert.ok(records.every((record) => record.elapsedMs >= 0 && !('file' in record)));
  checks.push('production query statistics preserve numeric dropped reasons without source paths');
  console.log(JSON.stringify({
    status: 'passed', mode: localAt >= 0 ? 'local' : 'npm-default-range',
    checks, queryCount: records.length,
    outcomes: Object.fromEntries(['ok', 'timeout', 'error', 'cancelled'].map((name) => [name, records.filter((record) => record.outcome === name).length])),
  }, null, 2));
} finally {
  await client?.dispose();
  await fs.rm(base, { recursive: true, force: true });
}

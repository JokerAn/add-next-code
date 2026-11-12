#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = new Set(['--vscode-executable', '--version', '--report']);
const flags = new Set(['--help', '--keep', '--skimmer']);
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (flags.has(key)) {
    continue;
  }
  if (!options.has(key)) {
    throw new Error(`Unknown integration option: ${key}`);
  }
  const value = process.argv[++index];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${key}`);
  }
}
function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
if (process.argv.includes('--help')) {
  console.log('npm run test:integration -- [--vscode-executable /absolute/path/to/Code] [--version 1.90.2|stable|insiders] [--report /absolute/result.json] [--skimmer] [--keep]');
  process.exit(0);
}
const selectedExecutable = argument('vscode-executable') ?? process.env.VSCODE_EXECUTABLE_PATH;
if (selectedExecutable) {
  await fs.access(path.resolve(selectedExecutable));
}
if (selectedExecutable && argument('version')) {
  throw new Error('Use --vscode-executable or --version, not both.');
}
// macOS's default temp path is long enough to exceed the Unix socket limit
// after VS Code appends its IPC name; /tmp keeps isolated profiles portable.
const scratch = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'anc-it-'));
const development = path.join(scratch, 'extension');
const workspace = path.join(scratch, 'workspace');
const userData = path.join(scratch, 'user-data');
const extensions = path.join(scratch, 'extensions');
const skimmer = process.argv.includes('--skimmer');
try {
  await Promise.all([development, workspace, path.join(userData, 'User'), extensions].map((folder) => fs.mkdir(folder, { recursive: true })));
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  manifest.name = 'add-next-code-integration';
  manifest.main = './extension.cjs';
  manifest.activationEvents = []; // Suite controls activation after isolated config is ready.
  delete manifest.scripts;
  delete manifest.dependencies;
  delete manifest.devDependencies;
  await fs.writeFile(path.join(development, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(workspace, '.gitignore'), 'private.js\n');
  if (skimmer) {
    const fixtures = {
      'vue2/package.json': '{"dependencies":{"vue":"^2.7.0"}}',
      'vue2/Child.vue': '<template><div/></template><script>export default {props:["rows"]}</script>',
      'vue2/Vue2App.vue': `<template>\n<Child />\n</template>\n<script>\nimport Child from './Child.vue';\nexport default {components:{Child},data(){return {rows:[],visible:true}},methods:{refresh(){}}};\n</script>\n`,
      'vue3/package.json': '{"dependencies":{"vue":"^3.5.0"}}',
      'vue3/SetupChild.vue': '<script setup>defineProps(["count"]);const childValue=1;</script>',
      'vue3/Vue3App.vue': `<template>\n<SetupChild />\n</template>\n<script setup>\nimport {ref} from 'vue';\nimport SetupChild from './SetupChild.vue';\nconst count=ref(1);\nconst title='fixture';\n</script>\n`,
      'react/ReactChild.tsx': 'export default function ReactChild({count}:{count:number}){return <span>{count}</span>;}',
      'react/ReactApp.tsx': `import {useState} from 'react';\nimport ReactChild from './ReactChild';\nexport function ReactApp(){\nconst [count,setCount]=useState(1);\nconst refresh=()=>setCount(count+1);\nreturn <ReactChild count={count}/>;\n}\n`,
      'node/typed.mts': 'export function read(value:string){return value;}',
      'node/main.mts': `import {read} from './typed.mjs';\nexport function main(){\nconst localValue='fixture';\nreturn read(localValue);\n}\n`,
    };
    for (const [name, text] of Object.entries(fixtures)) {
      await fs.mkdir(path.dirname(path.join(workspace, name)), { recursive: true });
      await fs.writeFile(path.join(workspace, name), text);
    }
  }
  await fs.writeFile(path.join(userData, 'User/settings.json'), JSON.stringify({
    'editor.inlineSuggest.enabled': true,
    'editor.suggest.preview': false,
    'editor.quickSuggestions': false,
    'editor.wordBasedSuggestions': 'off',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'addNextCode.trigger.mode': 'manual',
    'addNextCode.skimmer.enabled': false,
    'addNextCode.context.useLanguageService': false,
  }));
  const bridgePath = path.join(root, 'test/integration/bridge.cjs');
  await build({
    entryPoints: [path.join(root, 'test/integration/bootstrap.mjs')],
    outfile: path.join(development, 'extension.cjs'), bundle: true, platform: 'node', format: 'cjs',
    external: ['vscode'], logLevel: 'warning',
    plugins: [{
      name: 'integration-vscode-adapter',
      setup(builder) {
        builder.onResolve({ filter: /^vscode$/ }, (args) => args.importer === bridgePath
          ? { path: 'vscode', external: true } : { path: bridgePath });
      },
    }],
  });
  const suite = path.join(scratch, 'suite.cjs');
  await build({
    entryPoints: [path.join(root, 'test/integration/suite.mjs')], outfile: suite,
    bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], logLevel: 'warning',
  });
  const executable = selectedExecutable;
  const report = argument('report');
  console.log(`[integration] isolated files: ${scratch}`);
  await runTests({
    extensionDevelopmentPath: development, extensionTestsPath: suite,
    ...(executable ? { vscodeExecutablePath: path.resolve(executable) } : { version: argument('version') ?? process.env.VSCODE_VERSION ?? 'stable' }),
    launchArgs: [
      workspace, '--user-data-dir', userData, '--extensions-dir', extensions,
      '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
      ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ],
    extensionTestsEnv: {
      ...(report ? { ADD_NEXT_CODE_INTEGRATION_REPORT: path.resolve(report) } : {}),
      ...(skimmer ? {
        ADD_NEXT_CODE_INTEGRATION_SKIMMER: 'true',
        ADD_NEXT_CODE_INTEGRATION_NODE: process.execPath,
      } : {}),
    },
  });
} finally {
  if (process.argv.includes('--keep')) {
    console.log(`[integration] retained isolated files: ${scratch}`);
  } else {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

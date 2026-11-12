import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { HealthState } from './core/backoff';
import { BuildWatch } from './core/buildWatch';
import { CompletionCache } from './core/cache';
import { createCollector } from './core/collector';
import { DeepSeekFimClient } from './core/fim/client';
import { Metrics } from './core/metrics';
import { CompletionPipeline } from './core/pipeline';
import { Scheduler } from './core/scheduler';
import { createSnippetSource } from './core/snippets';
import { createScopeSource, createUsageSource } from './core/usage';
import { ConfigStore } from './vscode/config';
import { GitDiffSource } from './vscode/gitDiff';
import { ACCEPTED_COMMAND, FimInlineProvider } from './vscode/provider';
import { KeyStore } from './vscode/secrets';
import { StatusController } from './vscode/status';
import { SymbolSource } from './vscode/symbols';
import { SkimmerSource } from './vscode/skimmer';
import { PermissionGate, ProjectInfo, depsIo } from './vscode/workspace';

/** 由 esbuild 在打包时注入；测试与未打包运行时没有 */
declare const __BUILD_ID__: string | undefined;
const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
const STALE_NOTICE = '磁盘上的扩展已更新，当前窗口仍在运行旧版；执行 Developer: Reload Window 后生效';

const ENABLED_STATE_KEY = 'addNextCode.runtimeEnabled';
let activeSkimmer: SkimmerSource | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // 激活时只做：读配置、注册 Provider、创建状态栏、注册命令。不读任何项目文件，不启动任何子进程。
  const config = new ConfigStore();
  const keys = new KeyStore(context.secrets);
  await keys.load();
  const health = new HealthState();
  const status = new StatusController(health);
  const metrics = new Metrics();
  const cache = new CompletionCache();
  status.log(`[build] ${BUILD_ID}`);
  // 安装同版本号的 VSIX 不会自动重载窗口：发现磁盘上的文件变了就提醒一次
  const entry = typeof __filename === 'string' ? __filename : undefined;
  const buildWatch = new BuildWatch(() => {
    try {
      return entry ? fs.statSync(entry).mtimeMs : undefined;
    } catch {
      return undefined;
    }
  });
  const buildTimer = entry ? setInterval(() => {
    if (buildWatch.shouldNotify()) {
      status.log(`[build] ${STALE_NOTICE}`);
      void vscode.window.showWarningMessage(`Add Next Code：${STALE_NOTICE}。`, '重载窗口').then((choice) => {
        if (choice === '重载窗口') {
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      });
    }
  }, 5000) : undefined;
  const gate = new PermissionGate(config.get());
  const project = new ProjectInfo();
  const symbols = new SymbolSource(() => config.get().useLanguageService);
  const skimmer = new SkimmerSource({
    cfg: () => config.get(),
    cacheDir: vscode.Uri.joinPath(context.globalStorageUri, 'skimmer').fsPath,
    gate,
    status: (text) => status.setSkimmer(text),
    log: (line) => status.log(line),
    onIndexChanged: () => cache.clear(),
    onQuery: (record) => metrics.recordSkimmer(record),
  });
  activeSkimmer = skimmer;

  let runtimeEnabled = context.globalState.get<boolean>(ENABLED_STATE_KEY, true);
  status.setEnabled(runtimeEnabled);
  status.setHasKey(keys.hasKey);

  // FimClient 每次从最新配置读取 endpoint / model，配置变化无需重建
  const fim = {
    complete: (req: Parameters<DeepSeekFimClient['complete']>[0]) => {
      const c = config.get();
      return new DeepSeekFimClient({ endpoint: c.endpoint, model: c.model, getApiKey: () => keys.getKey() }).complete(req);
    },
  };

  const scheduler = new Scheduler({
    timeoutMs: () => config.get().timeoutMs,
    onStuck: () => {
      metrics.stuck++;
      health.onStuck();
      status.log('[stuck] 请求中止后超过 2 秒仍未落定');
    },
    onAbortSettled: (ms) => metrics.abortSettleMs.push(ms),
  });

  // 本次会话里编辑过的文档，用于给它们的未提交改动加权；只记 uri 与时间
  const recentDocs = new Map<string, number>();
  const gitDiff = new GitDiffSource({
    enabled: () => config.get().gitDiff,
    gate,
    recentDocs: () => recentDocs.keys(),
  });

  const collector = createCollector({
    sources: [
      symbols, skimmer, gitDiff,
      createSnippetSource(() => config.get().fileSnippets, () => config.get().nearCursorReference),
      createScopeSource(() => config.get().fileUsage),
      createUsageSource(() => config.get().fileUsage),
    ],
    vueMajor: (docKey) => project.vueMajor(docKey),
  });

  const pipeline = new CompletionPipeline({
    cfg: () => config.get(),
    cache,
    scheduler,
    fim,
    collector,
    depsIo,
    health,
    metrics,
    log: (line) => status.log(line),
    onRequest: (d) => status.setBusy(d),
  });

  const provider = new FimInlineProvider({
    cfg: () => config.get(),
    runtimeEnabled: () => runtimeEnabled,
    pipeline,
    gate,
    keys,
    health,
  });

  context.subscriptions.push(
    new vscode.Disposable(() => pipeline.invalidate()),
    new vscode.Disposable(() => clearInterval(buildTimer)),
    config,
    keys,
    status,
    gate,
    project,
    skimmer,
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider),

    // 输入事件只做缓存条目筛选，不读取任何文本
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) {
        return;
      }
      const key = e.document.uri.toString();
      pipeline.onDocumentChanged(key, e.contentChanges.map((c) => c.range.start.line));
      recentDocs.delete(key);
      recentDocs.set(key, Date.now());
      if (recentDocs.size > 50) {
        recentDocs.delete(recentDocs.keys().next().value as string);
      }
    }),
    // 保存后磁盘上的改动变了，重新取 diff
    vscode.workspace.onDidSaveTextDocument(() => gitDiff.invalidate()),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const key = doc.uri.toString();
      pipeline.onDocumentClosed(key);
      symbols.clearDoc(key);
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled' || doc.uri.scheme === 'vscode-remote') {
        gate.prime(doc.uri);
      }
    }),

    config.onDidChange((event) => {
      pipeline.invalidate();
      gate.reconfigure(config.get());
      if (event.affectsConfiguration('addNextCode.skimmer')) {
        void skimmer.restart();
      }
      health.onConfigChanged();
      cache.clear();
      gitDiff.invalidate();
      status.render();
    }),
    keys.onDidChange(() => {
      config.bumpEpoch();
      pipeline.invalidate();
      health.onConfigChanged();
      cache.clear();
      status.setHasKey(keys.hasKey);
    }),
    gate.onDidChange(() => {
      pipeline.invalidate();
      cache.clear();
    }),

    vscode.commands.registerCommand('addNextCode.setApiKey', async () => {
      const value = await vscode.window.showInputBox({
        title: 'Add Next Code：设置 API Key',
        prompt: 'API Key 仅保存在 VS Code 的 SecretStorage 中，不会写入设置文件或日志。',
        password: true,
        ignoreFocusOut: true,
      });
      if (value && value.trim()) {
        await keys.setKey(value);
        void vscode.window.showInformationMessage('Add Next Code：API Key 已保存。');
      }
    }),
    vscode.commands.registerCommand('addNextCode.clearApiKey', async () => {
      await keys.clearKey();
      void vscode.window.showInformationMessage('Add Next Code：API Key 已清除。');
    }),
    vscode.commands.registerCommand('addNextCode.toggle', async () => {
      runtimeEnabled = !runtimeEnabled;
      pipeline.invalidate();
      status.setEnabled(runtimeEnabled);
      await context.globalState.update(ENABLED_STATE_KEY, runtimeEnabled);
      void vscode.window.showInformationMessage(`Add Next Code：补全已${runtimeEnabled ? '开启' : '关闭'}。`);
    }),
    vscode.commands.registerCommand(ACCEPTED_COMMAND, (seq: unknown) => {
      if (typeof seq === 'number' && metrics.markAccepted(seq)) {
        status.log(JSON.stringify({ seq, accepted: true }));
      }
    }),
    vscode.commands.registerCommand('addNextCode.showLog', () => status.channel.show(true)),
    vscode.commands.registerCommand('addNextCode.restartSkimmer', async () => {
      pipeline.invalidate();
      cache.clear();
      await skimmer.restart();
    }),
    vscode.commands.registerCommand('addNextCode.showStats', () => {
      status.channel.appendLine(`─── 会话统计（构建 ${BUILD_ID}）───`);
      if (buildWatch.stale) {
        status.channel.appendLine(`⚠ ${STALE_NOTICE}`);
      }
      status.channel.appendLine(metrics.summary());
      status.channel.show(true);
    }),
  );

  // 预热已打开文档的发送许可判定，避免第一次按键没有补全
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled' || doc.uri.scheme === 'vscode-remote') {
      gate.prime(doc.uri);
    }
  }
}

export async function deactivate(): Promise<void> {
  const skimmer = activeSkimmer;
  activeSkimmer = undefined;
  await skimmer?.dispose();
}

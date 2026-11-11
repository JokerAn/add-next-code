import * as vscode from 'vscode';
import type { HealthSnapshot, HealthState } from '../core/backoff';

/** 状态栏 + 日志通道。错误类通知每种原因每个会话只弹一次。 */
export class StatusController implements vscode.Disposable {
  readonly channel = vscode.window.createOutputChannel('Add Next Code');
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  private readonly notified = new Set<string>();
  private inflight = 0;
  private enabled = true;
  private hasKey = false;
  private skimmer = '关闭';
  private sub: vscode.Disposable | undefined;

  constructor(private readonly health: HealthState) {
    this.item.command = 'addNextCode.showLog';
    this.sub = health.onChange((s) => {
      this.render();
      this.maybeNotify(s);
    });
    this.render();
    this.item.show();
  }

  log(line: string): void {
    this.channel.appendLine(`${new Date().toISOString()} ${line}`);
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.render();
  }

  setHasKey(v: boolean): void {
    this.hasKey = v;
    this.render();
  }

  setSkimmer(text: string): void {
    this.skimmer = text;
    this.render();
  }

  /** 模型请求开始/结束 */
  setBusy(delta: 1 | -1): void {
    this.inflight = Math.max(0, this.inflight + delta);
    this.render();
  }

  render(): void {
    const h = this.health.snapshot;
    let text = 'FIM';
    let tip = 'Add Next Code：就绪（点击打开日志）';
    if (!this.enabled) {
      text = 'FIM $(circle-slash)';
      tip = '已关闭。运行「Add Next Code: 开启/关闭补全」恢复。';
    } else if (!this.hasKey) {
      text = 'FIM $(key)';
      tip = '尚未设置 API Key。运行「Add Next Code: 设置 API Key」。';
    } else if (h.status === 'configError') {
      text = 'FIM $(error)';
      tip = `配置错误：${h.reason ?? ''}`;
    } else if (h.status === 'backoff') {
      text = 'FIM $(clock)';
      tip = `退避中：${h.reason ?? ''}`;
    } else if (this.inflight > 0) {
      text = 'FIM $(sync~spin)';
      tip = '请求中…';
    }
    this.item.text = text;
    this.item.tooltip = `${tip}\nSkimmer：${this.skimmer}`;
  }

  private maybeNotify(s: HealthSnapshot): void {
    if (s.status !== 'configError' || !s.errorKind) {
      return;
    }
    if (this.notified.has(s.errorKind)) {
      return;
    }
    this.notified.add(s.errorKind);
    const msg = `Add Next Code：${s.reason ?? '配置错误'}`;
    if (s.errorKind === 'auth') {
      void vscode.window.showErrorMessage(`${msg}（请检查 API Key）`, '设置 API Key').then((pick) => {
        if (pick) {
          void vscode.commands.executeCommand('addNextCode.setApiKey');
        }
      });
    } else {
      void vscode.window.showWarningMessage(msg);
    }
  }

  dispose(): void {
    this.sub?.dispose();
    this.item.dispose();
    this.channel.dispose();
  }
}

import * as vscode from 'vscode';

const KEY = 'addNextCode.apiKey';

/** API Key 存 SecretStorage；内存里缓存一份，供同步守卫判断"是否已设置"。 */
export class KeyStore implements vscode.Disposable {
  private cached: string | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly sub: vscode.Disposable;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.sub = secrets.onDidChange(async (e) => {
      if (e.key === KEY) {
        await this.load();
        this.emit();
      }
    });
  }

  async load(): Promise<void> {
    try {
      this.cached = (await this.secrets.get(KEY)) || undefined;
    } catch {
      this.cached = undefined;
    }
  }

  get hasKey(): boolean {
    return this.cached !== undefined;
  }

  async getKey(): Promise<string | undefined> {
    return this.cached;
  }

  async setKey(value: string): Promise<void> {
    await this.secrets.store(KEY, value.trim());
    this.cached = value.trim() || undefined;
    this.emit();
  }

  async clearKey(): Promise<void> {
    await this.secrets.delete(KEY);
    this.cached = undefined;
    this.emit();
  }

  onDidChange(listener: () => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  private emit(): void {
    for (const l of this.listeners) {
      l();
    }
  }

  dispose(): void {
    this.sub.dispose();
    this.listeners.clear();
  }
}

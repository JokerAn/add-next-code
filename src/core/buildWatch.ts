// 安装同版本号的 VSIX 会原地替换磁盘上的扩展文件，但已打开的窗口继续运行旧代码，直到重载窗口。
// 这里只负责发现"磁盘上的文件变了"，提示交给宿主层。

export class BuildWatch {
  private baseline: number | undefined;
  private latest: number | undefined;
  private reported = false;

  /** readMtime 返回扩展主文件当前的修改时间（同步或异步）；读不到返回 undefined */
  constructor(private readonly readMtime: () => number | undefined | Promise<number | undefined>) {
    const initial = readMtime();
    if (typeof initial === 'number' || initial === undefined) {
      this.baseline = initial;
      this.latest = initial;
    } else {
      void initial.then((v) => {
        this.baseline = v;
        this.latest = v;
      }, () => undefined);
    }
  }

  /** 异步刷新最新修改时间（不阻塞主线程） */
  async refresh(): Promise<boolean> {
    try {
      const now = await this.readMtime();
      if (this.baseline === undefined && now !== undefined) {
        this.baseline = now;
      }
      this.latest = now;
    } catch {
      this.latest = undefined;
    }
    return this.shouldNotify();
  }

  /** 磁盘上的文件是否已经不是本窗口加载时的那一份 */
  get stale(): boolean {
    const current = this.readMtime();
    if (typeof current === 'number' || current === undefined) {
      this.latest = current;
    }
    return this.baseline !== undefined && this.latest !== undefined && this.latest !== this.baseline;
  }

  /** 第一次发现变化时返回 true，之后不再重复 */
  shouldNotify(): boolean {
    if (this.reported || !this.stale) {
      return false;
    }
    this.reported = true;
    return true;
  }
}

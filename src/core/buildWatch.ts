// 安装同版本号的 VSIX 会原地替换磁盘上的扩展文件，但已打开的窗口继续运行旧代码，直到重载窗口。
// 这里只负责发现"磁盘上的文件变了"，提示交给宿主层。

export class BuildWatch {
  private readonly baseline: number | undefined;
  private reported = false;

  /** readMtime 返回扩展主文件当前的修改时间；读不到返回 undefined */
  constructor(private readonly readMtime: () => number | undefined) {
    this.baseline = readMtime();
  }

  /** 磁盘上的文件是否已经不是本窗口加载时的那一份 */
  get stale(): boolean {
    const now = this.readMtime();
    return this.baseline !== undefined && now !== undefined && now !== this.baseline;
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

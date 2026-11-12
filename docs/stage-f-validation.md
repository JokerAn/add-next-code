# 阶段 F 验证记录

日期：2026-11-11。

本轮从已提交的扩展 `8fa58f8`、Skimmer `a62be97` 继续，测试的是前者工作区里的阶段 F 修改及后者合并基线。没有提交、推送或发布。环境为 macOS / arm64、外部 Node.js v24.21.0；已安装 VS Code 1.145.2。测试项目和用户配置均位于独立临时目录，固定测试 Key 只用于 loopback 假 FIM 服务。

## 本轮代码

- 协议解码保留最多 200 个有效 dropped 条目，文件名限制长度；只采纳 `dirty`、`stale`、`budget`。缺失或非法服务端耗时保持未知。
- 生产 MCP 客户端在实际查询落定时记录一次统计。启动、索引、忙碌跳过和退避期间没有发出的请求不计入；主动重启/关闭计为取消，意外连接断开计为失败。
- 会话统计使用独立的最近 2,000 条查询窗口，查询数量、结果分类、平均耗时、分位数和丢弃计数来自同一批记录。统计不保存 dropped 文件名、源码或 Key。
- 新增 `@vscode/test-electron@3.1.0` 的真实宿主入口，以及使用生产客户端检查 npm / 本地后端的脚本。仅新增测试依赖，没有升级已有依赖版本。
- 修复无 Vue 扩展时的文件识别：生产 manifest 现在声明 `.vue` 语言关联。测试不再额外注入 Vue 语言，直接检查生产 manifest 能否在无 Vetur / Volar 时把文档识别为 `vue`。

## 已取得的运行证据

| 范围 | 命令 / 条件 | 结果 |
| --- | --- | --- |
| 扩展类型与单元测试 | `npm run typecheck`、`npm test -- --cache=false` | 18 个测试文件、241 项全部通过；覆盖查询生命周期、非法数据、未知耗时及有界统计 |
| Skimmer 合并基线 | `npm run typecheck`、`npm test`、`npm run build` | 490 项测试全部通过，双入口构建成功 |
| npm 启动路径 | `node tools/skimmer-smoke.mjs` | 生产客户端连接 npm 0.9.0；6 项检查通过，9 次查询均成功 |
| 最新本地构建 | `node tools/skimmer-smoke.mjs --local /Users/anshunli1/asl/code/github/frontend-code-skimmer/dist/index.js` | 同样 6 项检查通过，9 次查询均成功 |
| 已安装 VS Code | 1.145.2 / macOS，`test:integration --skimmer` | 12 项通过，25 次 loopback 假请求；宿主 exit 0 |
| 最低支持 VS Code | 1.90.0 / macOS，`test:integration --version 1.90.0 --skimmer` | 12 项通过，24 次 loopback 假请求；宿主 exit 0 |

npm / 本地检查覆盖 Vue 2、Vue 3、React、Node 的当前 overlay、静态关联接口、来源指纹与 dirty 过滤，并确认生产查询统计只传数值计数。npm 测试使用默认 `npx -y @jokeran/frontend-code-skimmer@^0.9.0`；未清空用户 npm 缓存，不能据此声称首次无缓存下载也已验收。

两份最终宿主报告保存在 `docs/validation/vscode-1.90.0-macos.json` 和 `docs/validation/vscode-1.145.2-macos.json`。VS Code 1.90.0 来自官方归档，下载较慢时改用同一归档分段获取，完整 SHA-256 与官方更新服务给出的 `466b6de68aa3e71771153b0ede1063c718da39bd952a81f7e91ea2c565a3ecc0` 一致，再放入测试运行时缓存。没有修改系统安装的 VS Code。

宿主 12 项具体范围：

1. 真实 `editor.action.inlineSuggest.trigger` 与 `editor.action.inlineSuggest.commit` 触发并接受补全，校验最终文档。
2. SelectedCompletionInfo 的 extend 范围与文本前缀契约。
3. skip 模式不发送请求。
4. 编辑与取消后旧结果不返回，假服务端观察到请求中止。
5. 多光标不发送请求。
6. `.gitignore` 匹配文件不发送请求。
7. 长行请求保持 prefix / suffix 预算。
8. Vue 2 当前成员及子组件 props 出现在最终 FIM 头部。
9. Vue 3 script setup 成员及子组件 props 出现在头部。
10. React 当前组件成员及子组件 props 出现在头部。
11. Node 模块成员及相对依赖导出签名出现在头部。
12. Vue 子组件未保存后，头部保留 self 并移除旧关联接口。

只有第 1 项使用真实灰字 UI 命令；其他项通过捕获的同一个生产 Provider，结合真实 TextDocument / TextEditor 验证。增强场景通过默认 npm 子进程取得接口，没有 mock Skimmer。Vue 语言 ID 来自生产 manifest，未安装 Vetur / Volar，语言服务上下文关闭；这组结果不覆盖语言服务共存、菜单 UI 自动化或完整 I1–I25。

Vue 文件识别还执行过修复前的负向验证：移除测试专用语言注入、使用原生产 manifest 时，VS Code 1.90.0 的 `.vue` 文档无法通过 `languageId === "vue"` 断言，测试 exit 1。这促成了生产 manifest 的关联修复，没有用测试适配继续掩盖问题。

## 构建与分发体积

| 产物 | 字节数 | 范围 |
| --- | ---: | --- |
| 扩展 bundle | 354,391 | `dist/extension.js`，不含 sourcemap |
| VSIX | 122,425 | 5 个归档文件，约 119.56 KiB |
| Skimmer 主入口 | 474,531 | `dist/index.js` |
| Skimmer worker | 143,366 | `dist/completion-worker.js` |
| Skimmer 本地 npm 包估算 | 202,541 | 最终构建和当时 README 上执行 `npm pack --dry-run --ignore-scripts --json`，不是发布操作 |
| Skimmer 包内解压文件 | 687,015 | 不含安装时的外部依赖、Node、npm 缓存或项目数据库 |

最终 VSIX 已核对内含 bundle / README 与工作区一致、Vue 语言贡献存在、机器级设置 scope 保持正确；测试代码与 devDependency 文件没有进入归档。具体包校验和见 `docs/validation/package.json`。Skimmer 原生模块及其传递依赖的完整安装占用仍未测，不能把上述 npm 包内体积当成增强模式的全部磁盘成本。

## 复跑

测试命令使用 Node.js >=22；本轮使用 v24.21.0。这是测试工具及可选 Skimmer 进程的运行要求，基础补全的代码仍由 VS Code 扩展宿主运行。

```bash
npm ci
npm run typecheck
npm test -- --cache=false

# macOS 使用已有安装；其他平台传相应 VS Code 可执行文件
npm run test:integration -- \
  --vscode-executable "/Applications/Visual Studio Code.app/Contents/MacOS/Code" \
  --skimmer --report /tmp/add-next-code-integration.json

# 下载并测试最低支持版，下载缓存保存在被忽略的 .vscode-test
npm run test:integration -- --version 1.90.0 --skimmer \
  --report /tmp/add-next-code-integration-minimum.json

# 不传 --skimmer 时只运行 7 项基础宿主测试
node tools/skimmer-smoke.mjs
npm run package
```

测试不会读用户 SecretStorage、修改已有 VS Code 用户配置或请求真实模型。普通模式仅依赖 loopback；`--skimmer` 和 npm smoke 需要可用的 Node.js >=22 以及 npm 包或缓存。`--keep` 可保留失败现场，默认会回收临时项目、配置和数据库；生产 deactivate 与订阅回收完成后才关闭假服务。

## 仍待完成

- 同一真实项目、相同编辑序列下的三组 CPU/内存与延迟报告：仅语言服务、基础模式、Skimmer 增强。分别归属扩展宿主和后端进程，记录样本量、p50/p95、超时占比、首次索引及磁盘占用。
- 真实万行 Vue 文件、语法不完整和不同文件位置的重复测量；当前合成样本不能替代真实样本或 p95。
- Vetur / Volar / 无语言服务的完整矩阵，以及 Windows / Linux 下的启动、原生依赖、锁竞争、退出和多窗口接管。
- 完整 I1–I25 宿主验收，特别是菜单 UI、自动防抖/限频、切换和重开文档、多根工作区、在途外部依赖变化与错误状态交互。相应单元与后端测试已存在，不等同于真实宿主全部跑过。
- 首次无缓存 npm 下载、离线/代理，以及安装/升级 VSIX 的最终用户路径。
- 真实接口测量和固定 30 个编辑点的质量对比。没有读取或使用用户真实 Key，没有产生付费模型请求。

完整资源和质量数据取得前，Skimmer 继续默认关闭，worker 继续启用。阶段 F 尚未整体验收完成。

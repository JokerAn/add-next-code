# Add Next Code

VS Code 行内 FIM 代码补全扩展：停笔后出现灰字，用 VS Code 原生方式接受或取消。直连 DeepSeek 原生 FIM 接口，成本优先。

设计与规格见仓库根目录的 `FIM补全扩展-可执行技术方案.md`（v1.2）。

## 当前进度

| 阶段 | 状态 |
| --- | --- |
| 0 技术验证 | 脚本已备好；已收到真实 Vue 文件的补全日志，性能与质量完整测量尚未执行 |
| A 通用内核 + Vue 2 基础模式 | 已实现；前轮 169 项测试通过，用户已确认真实编辑器可以补全，日志中两次请求约 1.7 秒、缓存命中约 1ms |
| B Skimmer 增强 | protocol 1 接口及审计修复已实现；扩展 193 项、Skimmer 338 项测试全通过，两端类型检查与构建通过；npm 发布及真实编辑器增强联调尚未完成 |
| C React Hooks | 本地实现与回归完成；扩展 206 项、Skimmer 366 项测试通过，实际构建 MCP 联调通过；真实编辑器验收待做 |
| D Vue 3 | 本地实现与补充复核完成；对象返回稳定性、完整返回路径和模板局部遮蔽已修复；已包含于阶段 E 全量回归 |
| E Node.js | 本地实现与回归完成；扩展 229 项、Skimmer 455 项测试通过，最终构建产物的 16 项 MCP 联调通过 |
| F 性能与发布收敛 | 待完成三组资源对比、真实编辑器和跨平台兼容矩阵；本轮仅记录本地构建体积及一条万行合成样本，未发布 |

## 开发

```bash
npm install
npm run check      # 类型检查 + 单元测试 + 打包
```

在扩展开发宿主里调试（本仓库 `.gitignore` 忽略了 `.vscode`，所以没有提交 launch.json）：

```bash
npm run build
code --extensionDevelopmentPath="$PWD"
```

## 打包与手动安装

首次使用先运行 `npm install`，之后在项目根目录执行：

```bash
npm run package
```

命令会自动构建最新代码，并在项目根目录生成 `add-next-code-<版本号>.vsix`（当前为 `add-next-code-0.0.1.vsix`）。

在 VS Code 扩展面板右上角点击 **… → 从 VSIX 安装…（Install from VSIX…）**，选择生成的 `.vsix` 文件即可。

## 使用

1. 命令面板运行 **Add Next Code: 设置 API Key**（保存在 SecretStorage，不写入设置与日志）。
2. 在 `addNextCode.endpoint` / `addNextCode.model` 确认接口地址与模型名（默认 DeepSeek `deepseek-flash`）。
3. 正常输入，停笔约 1 秒后出现灰字；也可用 `editor.action.inlineSuggest.trigger` 手动触发。
4. 需要 `editor.inlineSuggest.enabled` 为开启；与其他行内补全扩展并存时，建议同时只启用一个。

行为要点：

- 被 `.gitignore`、`.git/info/exclude` 或 `addNextCode.exclude` 匹配的文件不会发送任何内容；判定结果尚未得出时按"不许可"处理，所以刚打开的文件第一次按键可能没有补全。
- 多光标、非空选择区不提供补全。补全菜单可见时按 `addNextCode.suggestWidget` 处理（默认在选中项基础上续写）。
- 不读取用户级全局忽略文件（git 的 `core.excludesFile`），需要排除的路径请写进 `addNextCode.exclude`。
- 日志（`Add Next Code: 打开日志`）每次调用一行 JSON，不含源码与 Key；`debug.dumpPrompts` 开启后才会写入 prompt，仅调参用。

## Skimmer 上下文增强（阶段 B）

基础补全可以独立工作。打开 `addNextCode.skimmer.enabled` 后，第一次有效补全懒启动一个 Skimmer stdio 子进程；初始化、索引和查询超时均不阻断基础补全。增强内容包括当前组件成员、能静态确认的子组件 props / emits，以及本地模块导出签名。

在用户设置中配置增强。endpoint 及 Skimmer 的 enabled / command / args / nodePath 均为 `machine` 设置，工作区 `.vscode/settings.json` 无权覆盖。扩展使用固定兼容范围的 npm 启动方式：

```json
{
  "addNextCode.skimmer.enabled": true,
  "addNextCode.skimmer.command": "npx",
  "addNextCode.skimmer.args": ["-y", "@jokeran/frontend-code-skimmer@^0.9.0"],
  "addNextCode.skimmer.nodePath": "node"
}
```

启动后会检查 `skimmer_get_completion_context` 工具和响应 `protocol: 1`，并在日志记录实际服务版本。**本地 Skimmer 的版本号仍为 0.8.5；本轮没有发布 npm。`^0.9.0` 是方案约定的兼容范围，必须先发布包含新接口的版本才能用它启动，当前开发请使用下面的本地构建配置。** 缺少工具的旧版本会关闭并降级为基础补全。

本机开发阶段可直接使用已构建的后端，避免等 npm 发布：

```json
{
  "addNextCode.skimmer.enabled": true,
  "addNextCode.skimmer.command": "node",
  "addNextCode.skimmer.args": [
    "/Users/anshunli1/asl/code/github/frontend-code-skimmer/dist/index.js"
  ],
  "addNextCode.skimmer.nodePath": "node"
}
```

需要外部 Node.js >=22；找不到 Node 时，把 `skimmer.nodePath` 配成其可执行文件的绝对路径。该目录会加入子进程 PATH，帮助 `npx` 使用同一份 Node。子进程仅继承 SDK 的基础环境和明确列出的临时目录、npm registry/cache、代理、证书变量，不继承 API Key、`NODE_OPTIONS` 或 shell 中的 Skimmer 覆盖项。鼠标悬停状态栏可看增强状态；只有 `skimmer.*` 设置变化会重启，旧连接关闭后，后续有效补全才懒启动新连接。退出扩展会等待关闭完成。

增强查询每次携带当前文档全文，只在通过防抖和限频后构造快照。`skimmer.maxDocumentChars` 默认及服务端硬上限均为 200 万 UTF-16 字符，超出后退回基础模式。当前文档和关联模块的解析在单个 worker 中执行，有界队列合并同类任务的最新文本。绑定和整文件摘要分开处理，绑定及目标模块任务优先；新摘要没有完成时 `self` 可为 `stale`，首次摘要等待最多 80ms，尚无成功摘要则为 `failed`。本次绑定在总截止时间内就绪时，`related` 可独立返回，不必等摘要刷新；旧绑定始终不能授权新文本的关联接口。支持能静态证明的 Vue 2 `Vue.extend({ components })`。

关联文件和 re-export 中间文件会再次检查发送许可、未保存状态与指纹，变化后不展示或缓存旧接口。remote 工作区的检查保留 URI 的 scheme / authority，符号链接的实际路径和别名路径均受检查。动态注册、无法证明的绑定和第三方包不返回接口。

数据库放在扩展自己的 `globalStorageUri/skimmer`，按项目真实路径隔离，由后端独占打开。另一窗口占用时保留本文件摘要，服务端将失败打开负缓存 3 秒；扩展每 5 分钟最多重试一次索引，收到非占用响应则立即解除这段退避。缓存清理由后端负责：启动 60 秒后、此后每 6 小时检查项目已不存在或 DB/WAL 均超过 30 天的缓存，取得协调锁和实际数据库锁后再次确认条件才删除。活动库、无协调锁的旧库及异常条目保留；协调锁文件永久保留，避免删除再建导致锁失效。

验证记录更新于 2026-11-11。真实 VS Code 的增强联调、`npx` 下载启动、Windows / Linux 锁与退出行为仍待验证。

本轮 macOS / Node.js v24.21.0 验证：

- 扩展 `npm run typecheck`、`npm test -- --cache=false`（193 项）通过，覆盖 I15–I19、I24、I25 的调度、进程、全文与 dirty 入参、来源依赖和占用边界。
- Skimmer `npm run typecheck`、`npm test`（338 项）、`npm run build` 通过，包含原握手回归和 `real-mcp-eval-cli`。20 轮真实双进程竞争均为一方 owner、一方 locked；强杀持锁进程后另一进程可取得锁；stdin end/close 与 SIGTERM 后锁被释放。
- 用最终打包结构 `dist/index.js` + `dist/completion-worker.js` 在临时项目完成 MCP 联调：静态组件、barrel 指纹、dirty 过滤、watcher 状态通过；约 362KB 合成文件的一次改动查询约 1ms 返回 `stale`，后续恢复 `ready`。这是一条本机样本，不代表 p95 或真实万行项目测量。

## React Hooks 上下文（阶段 C）

`.jsx` / `.tsx` 沿用同一条补全链路，头部使用 `//` 注释。增强模式从本次全文提取光标所在组件的 props 本地别名、`useState` / `useReducer` 的 state 与 setter / dispatch、ref、普通 handler 和 `useCallback` handler。同文件的兄弟组件及 handler 内部临时变量不进入该组件的 `self`；摘要过期时不使用旧位置选取 React 组件。

关联接口只来自能证明的本地静态导入，支持默认、命名、别名、namespace 成员和 barrel 再导出：

- 当前 JSX 标签的 props 按最终导出组件提取，同文件其他组件的 props 不混入。
- 自定义 Hook 提供参数签名和一致的静态 object / tuple 返回结构；tuple 保留索引，不把动态 spread 或不同分支返回结构推断成确定字段。
- React `createContext` 的静态对象或本地类型声明提供 Context 字段；Context 工厂、未知来源值不推断。

头部将组件显示为 `<Child>`，Hook 显示为 `hook useDraft`，Context 显示为 `module SessionContext` 并附 `context` 字段。它们继续受忽略规则、dirty、来源指纹和预算控制；接口来源在模型响应返回前变化时，不展示、不缓存旧补全。

`memo` / `forwardRef` 等 HOC 包装后的 props、运行时动态目标和第三方包接口本轮不展开。语言服务兜底仅在能确认当前函数符号时返回直接绑定；只有 Variable 类型或扁平列表、无法证明组件范围时省略。没有语言服务或 Skimmer 时仍可使用基础窗口补全。

2026-11-11 阶段 C 验证：扩展 `tsc` 和 206 项测试通过，Skimmer `tsc`、366 项测试及双入口构建通过，包含 Vue 2 既有回归。用最终 `dist/index.js` / `dist/completion-worker.js` 在临时 React 项目经真实 stdio MCP 取得当前组件成员、别名组件 props、Hook 参数/返回字段与 Context 字段；三者均携带 barrel 指纹，dirty Hook 被过滤。真实 VS Code React 编辑场景、其他操作系统和 npm 下载启动仍未验证。

## Vue 3 上下文（阶段 D）

Vue 3 分三种写法提取成员：

- `<script setup>`：顶层运行时绑定、静态 `defineProps` / `withDefaults`、`defineEmits`；不把类型声明和 handler 内部变量当成员。
- 普通 `setup()`：仅提供能证明一致的静态返回对象键，支持返回别名；私有局部变量、嵌套函数返回、动态 spread、分支不一致时不推断。
- Options API：保留 props/data/computed/methods/watch；与 setup 混用时仍保留这些明确分组。

子组件关联接口提供静态 props、emits 和显式 `defineExpose` 字段，不把普通 setup 的全部模板返回项当公开实例接口。宏值名称被本地声明或导入遮蔽时省略；纯类型名称不遮蔽运行时宏。本轮只解析本地静态类型字段，不执行类型计算或宏运行时推导。

组件绑定支持 `<script setup>` 的静态 import、`components` 注册（含可信 `Vue.defineComponent`）和普通 setup 返回的 import / const alias；每条返回分支都必须证明相同目标。`<Table>` 等大写组件名可与小写原生标签区分，动态工厂与 namespace 对象不当成确定组件。

扩展把最近 `package.json` 中确认的 Vue 主版本通过可选 `vue_major` 传给 Skimmer，直接 MCP 调用则在项目内查询。Vue 2 / Vue 3 的普通 Options API 按项目版本标注，不被服务端的语法猜测覆盖；含糊版本范围保持未知。按本方案的语法标签规则，`<script setup>` 优先标为 Vue 3（包括使用此写法的 Vue 2.7），该标签只影响上下文分组，不改变补全链路。

语言服务兜底只接受能识别的顶层符号或明确 setup 返回字段，未知树形状及过期 Vue 3 符号省略，交给 Skimmer。模板头部使用 HTML 注释，脚本头部使用行注释，继续按窗口起点所在区域选择。

2026-11-11 阶段 D 验证：扩展 `tsc`、224 项测试通过；Skimmer `tsc`、395 项测试（包含 Vue 2 / React 全部既有回归）和双入口构建通过。构建产物的 stdio MCP 在临时项目验证三种 Vue 3 写法、未保存 props 变化、子组件 props/emits/expose、setup 返回组件、项目主版本、barrel 指纹与 dirty 过滤；最终 worker 构建另复验 camelCase/kebab-case 绑定。真实 VS Code/Volar 编辑体验、npm 下载启动和 Windows/Linux 尚未验证。

2026-11-11 补充复核修复：setup 和 Hook 的 const 对象/tuple 被覆盖、delete、别名改写、未知调用或闭包逃逸后，不继续提供旧返回字段；可能落到隐式 `undefined` 的条件返回和重复对象键保守省略。完整且一致的 if/else 返回仍可提供结构。普通 setup 的返回组件也执行相同稳定性检查，v-for / v-slot 局部变量按 camelCase / kebab-case 名称正确遮蔽组件。

## Node.js 上下文（阶段 E）

`.js` / `.ts` 与新增的 `.mjs` / `.cjs` / `.mts` / `.cts` 复用现有全文查询、worker、预算和 FIM 请求链路。`self` 提供模块顶层运行时声明，以及光标所在类的直接方法，支持普通 class 和顶层 const class expression；兄弟类方法与函数内部临时变量不混入。摘要过期时只保留顶层项，不把旧类位置套到新文本。

`related` 提供相对路径静态 ESM import 与 CommonJS require 目标的导出签名，支持 require 解构/别名、namespace 成员、`module.exports`、`exports.x` 及静态 ESM/CommonJS 再导出链。实际路径优先；`.mjs` / `.cjs` 文件不存在时可解析对应 `.mts` / `.cts` 源文件。每一级再导出仍受忽略规则、dirty、新鲜度和指纹检查。

CommonJS 的导出替换与属性覆盖按源码顺序合成最终接口，默认导入和 namespace 不沿用覆盖前的签名。`require` / `module` / `exports` 被运行时词法名称遮蔽时不当作系统全局，type-only 名称不构成值遮蔽。动态路径、第三方包、条件或动态属性导出、别名改写与未知逃逸无法证明接口时省略，不用旧索引补字段；不执行目标模块或推断 Express 等框架。普通 Node `useXxx` 函数保持 `module` 类别，不仅凭名称套用 Hook 接口。

2026-11-11 阶段 E 验证：扩展 `npm run typecheck` 和 229 项测试通过；Skimmer `npm run typecheck`、455 项测试（含 Vue 2 / React / Vue 3 全部既有回归）及双入口构建通过。最终构建产物经真实 stdio MCP 在临时项目通过 16 项检查：四种扩展名的 overlay / 本地接口、扩展替换、混合 barrel 指纹、dirty / ignore、导出覆盖后的默认/namespace 签名、当前类范围、动态/第三方/遮蔽拒绝、Node `useXxx` 分类和依赖保存后的 watcher 刷新。

另用 10,001 行、237,822 字节的 Node 合成文本测一条 worker 样本：冷模块事实 201ms、文本改动后 98ms、同文本缓存约 0ms，整文件摘要 523ms，主线程定时器最大延迟约 2ms。摘要仍通过已有 stale / 后台刷新机制返回；这只是单次本机样本，不是 p95、真实项目或阶段 F 的三组资源对比。

真实 VS Code 的 Node 增强体验、`npx` 下载路径、Windows/Linux 和阶段 F 完整性能验收仍待完成。本轮没有提交或发布 npm，新接口开发时继续使用上面的本地构建配置。

## 阶段 0 实测

```bash
# 连通性：SSE 实际格式、finish_reason、usage、首字节/总耗时
DEEPSEEK_API_KEY=sk-... node tools/fim-smoke.mjs connect
# stop 是否生效
DEEPSEEK_API_KEY=sk-... node tools/fim-smoke.mjs stop
# 输入上限（逐步加长 prompt 直到报错，按调用计费，请留意）
DEEPSEEK_API_KEY=sk-... node tools/fim-smoke.mjs length --max-chars 128000
# 相同前缀两次请求，看 prompt_cache_hit_tokens
DEEPSEEK_API_KEY=sk-... node tools/fim-smoke.mjs cache
# 假 Key / 错模型名 / 超大 max_tokens 的状态码
DEEPSEEK_API_KEY=sk-... node tools/fim-smoke.mjs errors
# 头部是否被模型续写进结果（用真实文件的某个编辑点）
DEEPSEEK_API_KEY=sk-... node tools/fim-smoke.mjs header --file <源文件> --line <0基行号> --col <列>
```

Key 只从环境变量读取，不要通过命令行参数传入。没有真实 Key 时可用假服务联调：

```bash
node tools/fake-fim-server.mjs --port 8787 --text "foo()" --latency 200
DEEPSEEK_API_KEY=sk-fake node tools/fim-smoke.mjs connect --endpoint http://127.0.0.1:8787/beta/completions
```

Skimmer 解析耗时（方案 0.5）：在 Skimmer 仓库里用它自己的 tsx 运行，路径作为参数传入：

```bash
cd <skimmer 仓库> && npx tsx <本仓库>/tools/skimmer-parse-bench.mts --skimmer <skimmer 仓库> --file <万行 .vue 文件> --runs 20
```

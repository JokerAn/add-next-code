# Add Next Code

VS Code 行内 FIM 代码补全扩展：停笔后出现灰字，用 VS Code 原生方式接受或取消。直连 DeepSeek 原生 FIM 接口，成本优先。

设计与规格见仓库根目录的 `FIM补全扩展-可执行技术方案.md`（v1.2）。

## 当前进度

| 阶段 | 状态 |
| --- | --- |
| 0 技术验证 | 脚本已备好；已收到真实 Vue 文件的补全日志，性能与质量完整测量尚未执行 |
| A 通用内核 + Vue 2 基础模式 | 已实现；前轮 169 项测试通过，用户已确认真实编辑器可以补全，日志中两次请求约 1.7 秒、缓存命中约 1ms |
| B Skimmer 增强 | protocol 1 接口及审计修复已实现；npm `0.9.0` 已可使用，默认 `npx @^0.9.0` 路径通过生产客户端四框架联调 |
| C React Hooks | 本地实现与回归完成；扩展 206 项、Skimmer 366 项测试通过，实际构建 MCP 联调通过；真实编辑器验收待做 |
| D Vue 3 | 本地实现与补充复核完成；对象返回稳定性、完整返回路径和模板局部遮蔽已修复；已包含于阶段 E 全量回归 |
| E Node.js | 本地实现与回归完成；扩展 229 项、Skimmer 455 项测试通过，最终构建产物的 16 项 MCP 联调通过 |
| F 性能与发布收敛 | 已补查询统计、真实 VS Code 测试入口及 npm 启动检查；扩展 241 项、Skimmer 490 项测试通过，macOS 的 VS Code 1.90.0 / 1.145.2 各 12 项通过，完整资源与兼容矩阵仍待完成 |

## 开发

```bash
npm install
npm run check      # 类型检查 + 单元测试 + 打包
```

真实扩展宿主集成测试使用独立的临时配置、项目和本地假 FIM 服务，不读取用户 Key、不调用真实模型：

```bash
# 使用已安装的 VS Code，避免下载
npm run test:integration -- --vscode-executable "/Applications/Visual Studio Code.app/Contents/MacOS/Code" --report /tmp/add-next-code-integration.json
# 启用 npm Skimmer，追加四框架头部与未保存依赖检查
npm run test:integration -- --vscode-executable "/Applications/Visual Studio Code.app/Contents/MacOS/Code" --skimmer
# 或下载指定版本，用于验证最低支持版本
npm run test:integration -- --version 1.90.0 --skimmer
# 生产客户端直接检查默认 npm 后端，也可传 --local /absolute/path/to/dist/index.js
node tools/skimmer-smoke.mjs
```

测试使用生产激活入口和 Provider。灰字触发/接受通过真实编辑器命令验证；SelectedCompletionInfo 的 extend/skip 等契约通过同一个生产 Provider 与真实编辑器验证，菜单 UI 自动化和完整 I1–I25 仍需单独验收。详细执行证据与剩余项见 `docs/stage-f-validation.md`。

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
- 光标停在空行时按 `addNextCode.trigger.blankLine` 处理。默认 `smart`：上一非空行是注释或刚打开的代码块时允许多行，其余空行只补一条语句；`strict`：只有前者才自动触发，手动触发不受限；`always`：不区分空行。
- `addNextCode.request.temperature` 默认 0，同一位置重复触发得到相同结果。
- **文件内用法索引**（`addNextCode.context.fileUsage`，默认开启）：按光标前的表达式，从当前文件的声明与用法里找出候选名字，放在提示词头部的最后一行。`this.` 给出经实例访问过的成员（按使用次数）；`this.form.`、`row.` 给出对象字面量里声明的子字段和文件里用到过的子字段；正在敲的半个名字（至少 3 个字符）给出文件里以它开头的标识符。纯文本扫描，不依赖语言服务与 Skimmer；接收者是调用结果或下标时不猜。
- **同文件相关片段**（`addNextCode.context.fileSnippets`，默认开启）：按光标前后几行里的标识符（紧挨光标的行权重最高，常是说明意图的注释），从当前文件里提示词窗口之外的位置取最相关的最多 6 段代码放进头部，例如模板里的绑定、别处已有的同类写法、被调用方法的定义。名字按大小写、连字符、下划线归一后匹配（`skulist-pop` 与 `skuListPop` 视为同一个），越少见的名字权重越高。为容纳片段与未提交改动，`addNextCode.context.headerChars` 默认为 6000。
- **未提交改动**（`addNextCode.context.gitDiff`，默认开启）：把 `git diff HEAD` 里与光标处相关的改动块放进头部，最多 6 块、约 1600 字符，只取新代码一侧。当前文件的改动（窗口之外）总是候选；其他文件的改动必须与光标附近的名字有交集，所以一次改了几十个文件也只会带上相关的几块。其他文件同样要通过发送许可（`.gitignore`、`addNextCode.exclude`），有未保存修改的其他文件不用；锁文件、压缩产物、二进制、被删除的文件不取。结果按仓库缓存 30 秒，保存文件时刷新；需要本机可执行 git 且工作区受信任。未跟踪的新文件不在 `git diff HEAD` 里，取不到。
- 检索词的权重：紧贴光标上方的注释块（说明接下来要做什么）里的英文标识符最高，其次是紧挨光标的行，更远的行减半。
- 中文注释按长词组匹配：意图注释与文件里（或未提交改动里）另一条注释有连续 5 个以上相同的字时算对上，相同的字越多越靠前；两三个字的常见词（如"弹出""取值"）不参与。对上之后，取回那条注释和它下面的整段代码（到空行或代码块结束为止）。
- 意图注释对上的是某一行的行尾注释（如 `isWLBC: false, // 是否是挽留补偿类型的`）时，那一行声明的名字按意图里直接写出的名字对待；并且会找出这个名字在文件里的固定搭档（在它出现位置的前后 2 行内至少 3 处、且占对方全部出现位置一半以上的名字）一起检索，从而取回"这个名字通常怎么用"的代码。名字和搭档同时出现的位置有单独的名额（最多 2 段，离光标近的优先，多带几行后文），排在相关片段最前面。只认真正的行尾注释，字符串里的相同文字不算；`$refs`、`$emit`、`$store` 这类框架通用入口不作为检索词。
- 片段取景：命中行上面带 2 行、下面带 4 行，不越过所在代码块；得分相近时离光标近的优先。
- 相关片段不再固定 7 行：命中相邻（间隔不超过 8 行）时合并成一段，不越过缩进更浅的行，单段最多 50 行；所有片段合计最多约 3000 字符，放不下时退回 7 行。
- **被调用方法的定义**：光标之后 12 行、之前 5 行里调用的方法，如果定义在本文件且不在提示词窗口里，定义（含上方注释，最多 16 行、2 个）排在相关片段最前面，让模型看到参数和用法。
- **外层变量声明**：光标附近用到、但声明在提示词窗口之外的外层 `let/var/const` 变量，会把声明原文放进提示词。补全在同一层级又用 `let/var/const` 声明外层已有的 `let/var` 变量时，自动去掉声明关键字改成赋值（日志规则名 `redeclare`；`verify.members` 为 `off` 时不做）。
- **行数上限改为软截断**：非语句模式下，到 `request.maxLines` 行时括号还没配平就继续，到配平的行尾为止，最多两倍行数（日志规则名 `balanced`）。光标在注释或刚打开的代码块之后时，输出上限用 `request.maxTokensManual`。
- **实例成员校验**（`addNextCode.verify.members`，默认 `strict`）：补全里出现当前文件不存在的 `this.xxx` 成员或 `$refs.xxx` 名字时，把这份草稿里的名字也作为线索重新检索一次并重发一次请求，采用编造更少的结果；仍然存在的，从用到它的那一行起不展示。`retry` 只重发不截断，`off` 不校验。`$refs.某ref.某方法` 也在校验范围内：ref 指向从本项目路径 import 的组件，而这个方法既没在本文件的同一个 ref 上用过、也不在提示词头部（含 Skimmer 给出的子组件接口）里时，视为没有依据；DOM 元素和全局注册的库组件（如 `el-form`）不校验方法。截断后会把原结果末尾的闭合括号接回来，只剩空代码块时整条不展示。以 `$` 开头的成员（框架与插件注入）不校验；只在 mixin 里定义、本文件从未出现过的成员会被当成不存在，遇到这种项目请改用 `retry` 或 `off`。
- 接受一段补全后光标停在块尾时，模型有时会把刚写完的几行原样再写一遍；结果开头连续 2 行以上（合计至少 20 个字符）与光标前最后几行逐行相同时不展示；整个结果（去掉注释行后 4 行以上、相同部分合计至少 60 个字符）逐行等于光标前 40 行代码内的某一段时也不展示，其中两边都以闭合括号开头的行算对上（如 `}` 与 `} else {`）；只要有一行实质内容不同就不算（日志里的规则名为 `replay`）。
- 光标停在只有闭合括号的一行（如 `}`）之后，补全另起一行却比这一行缩进更深时不展示（日志规则名 `overindent`）：代码块已经结束，模型还按"在块里"续写。链式调用等以 `.` `?` `:` 开头的延续行不算。
- **确认运行的是哪一次构建**：扩展启动时在日志里写一行 `[build] 构建时间`，会话统计的标题里也带构建时间。安装同版本号的 VSIX 不会自动重载窗口；扩展发现磁盘上的文件被替换后会弹出提醒并提供"重载窗口"按钮，统计里也会标出当前窗口仍在运行旧版。
- **实验：参照放到光标上方**（`addNextCode.experimental.referenceNearCursor`，默认关闭）：把最相关的一两段参照（名字与固定搭档的用法、与意图注释对上的整段旧代码；最多 2 段、40 行、1200 字符）用行注释插在光标上方的意图注释之前，其余仍在提示词顶部。只在脚本区域生效；只改发给模型的内容，不改文件，本地缓存与各项校验仍以真实代码为准。日志里的 `near` 是插入的段数，`debug.dumpPrompts` 可以看到完整提示词。效果未经验证：可能让模型更愿意照着已有代码写，也可能照抄参照里的变量名。
- 括号规则按缩进区分：后文的闭合括号在另一行时，补全里多出的闭合括号只有缩进与它相同才当作重复而截掉；缩进更深的是在闭合光标前没闭合的代码块，保留。
- 模型有时把提示词顶部参照块的 `// ` 前缀一起抄出来：首行是正常代码、其后整段都被 `//` 包着。首行以 `{ ( [ =>` 结尾、其后至少 3 个非空行全是 `//` 注释、去掉前缀后括号配平时，自动还原成代码（日志规则名 `uncomment`）。真正的注释不受影响。
- **头部沿用**（`addNextCode.context.reuseHeader`，`block` / `intent` / `off`，默认 `block`）：服务端缓存只认提示词前缀，而头部在提示词最前面，每次请求头部都不同就等于没有缓存。连续几次自动补全沿用第一次收集到的头部：`intent` 只在同一段意图注释之下；`block` 另外覆盖"在同一个代码块里逐行往下写、没有意图注释"的情形，以包着光标的块开头行（如 `if (…) {`，至少 12 个字符）为锚点，在这个块或它里面的嵌套块里写都算同一个块。以下情形重新收集：意图注释变了、写完块回到外面、手动触发、超过 5 分钟、离收集时的位置 60 行以上、头部里引用的本文件代码被改过、引用的其他文件变了、配置变化，以及光标前正在补候选名字（`this.`、`row.`、半个标识符）时——头部末尾的候选行只对当时的位置有效，带候选行的收集结果不会被记下来沿用。日志里的 `hdr` 是 `reuse` 或 `fresh`，`hdrBy` 是锚点种类（`intent` / `block`），统计里显示沿用次数和输入缓存命中率。沿用的代价：块内新写的变量名不再影响参照的选择；觉得参照变陈旧可以改成 `intent` 或 `off`。
- 关联接口去重：同一个组件以标签名和导入名各列一次（接口完全相同）时只留第一个。
- 后文回声：结果里有一行（去掉空白后至少 40 个字符、不是注释）与光标之后 80 行内的某一行逐字相同时，从该行起截断，首行就是则整条不展示（日志规则名 `suffixEcho`）：模型把后面已有的代码又写了一遍。
- 按后文截断后留下的是写到一半的语句（括号没配平、且不是以 `{` 结尾的块开头）时整条不展示（日志规则名 `fragment`）。
- **负缓存**：温度为 0（默认）时，同样的提示词必然得到同样的结果。某次请求完整返回、却被后处理整条拒绝（如 `suffixEcho`、`replay`）后，两分钟内同样的提示词（光标行之前的部分与光标之后每一行的行尾空白不计）不再重复请求，日志里 `neg` 为 `hit`（拦截）或 `stored`（记下）。手动触发、温度不为 0、请求出错或被取消的情况不受影响；前缀、后文、头部、配置任何一项变了就是新的请求；`invalidate`（配置或 Key 变化）、关闭文档会清掉。统计里显示拦截次数。
- 整块照抄：结果里有一段连续的代码行（去掉注释与空行后至少 6 行、合计至少 120 个字符），与光标之前窗口里的某一段连续代码行逐行相同，并占结果代码行的 60% 以上时整条不展示（日志规则名 `clone`）。模型常把窗口里离得很远的一整块（埋点、提示之类）原样再写一遍；只相同零星几行、或照着相邻的块写个相似的，不算。
- 日志每行另外记录：光标行列与窗口起始行、结束阶段（`stage`）、取消或过期的原因（`why`）、行模式（`mode`）、用法索引结果（`focus`）、首段文本与结束标记的到达时间（`tFirstToken` / `tFinish`）、模型原始输出与最终展示的规模、改动了结果的后处理规则（`pp`）、展示内容里的属性名个数及其中本文件从未出现过的个数（`props` / `newProps`）、相关片段段数（`snippets`）、未提交改动的选中块数与候选块数（`diff`，形如 `6/44`）、提示词里带上的外层变量声明个数（`scope`）、成员校验的草稿与最终编造个数和重发结果（`draftInvented` / `invented` / `retry` / `tRetry`）。全部是计数和枚举，不含源码。
- **显示本次会话统计**里包含采纳次数与采纳率（整条接受才计入）、输入缓存命中率和费用估算。费用按代码内置的 2026-11-11 DeepSeek 官方价目计算，只对官方端点的已知模型估算，未排除节假日，客户端提前截断的请求没有用量、不计入。
- 扩展声明 `.vue` 的语言标识，不依赖 Vetur / Volar 才能识别 Vue 文件；语法分析与语言服务仍按现有来源提供。
- 不读取用户级全局忽略文件（git 的 `core.excludesFile`），需要排除的路径请写进 `addNextCode.exclude`。
- 日志（`Add Next Code: 打开日志`）每次调用一行 JSON，不含源码与 Key；`debug.dumpPrompts` 开启后才会写入 prompt，仅调参用；`debug.dumpCompletions` 开启后才会写入补全原文（模型原始输出 `raw`、校验判定为不存在的名字 `invented`、重发后的输出 `retry raw`、最终展示的文本 `shown`），仅排查用，用完关闭。

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

启动后会检查 `skimmer_get_completion_context` 工具和响应 `protocol: 1`，并在日志记录实际服务版本。2026-11-11 已确认 npm `0.9.0` 可用，并用生产客户端实际启动默认 `^0.9.0` 范围，通过 Vue 2 / Vue 3 / React / Node 的接口与 dirty 过滤检查。缺少工具的旧版本会关闭并降级为基础补全。首次无缓存下载、离线和代理环境仍需分别验收。

本机开发也可直接使用已构建的后端：

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

验证记录更新于 2026-11-11。下方 B～E 数字为各阶段当时的历史结果，本轮结果和限制见阶段 F 验证记录。Windows / Linux 锁与退出行为仍待验证。

阶段 B 当时的 macOS / Node.js v24.21.0 验证：

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

以上为阶段 E 当时记录。阶段 F 已补 npm `0.9.0` 的生产客户端启动验证；后续兼容矩阵、资源报告及真实编辑器覆盖范围见 `docs/stage-f-validation.md`。

## 查询统计与阶段 F 验证

运行 **Add Next Code: 显示本次会话统计**，可以查看最近 2,000 次实际 Skimmer 补全查询的成功、超时、失败、取消数量，客户端平均耗时和 p50/p95、有效响应的服务端耗时，以及服务端 `dirty / stale / budget` 丢弃计数。启动、索引、缓存命中和退避期间未发出的查询不计入，主动重启/关闭与进程意外断开分别归为取消和失败。

查询统计只保留数值和分类，不记录被丢弃文件的路径或源码。客户端耗时包含 MCP 传输和处理时间；服务端耗时来自响应，二者分开显示。完整三组 CPU/内存、真实项目延迟与补全质量对比尚未完成，Skimmer 继续默认关闭，worker 保持启用。

会话统计另外列出成功响应的 `overlay`、`index` 状态，以及成员和关联项的返回数量；这些数量位于扩展权限、dirty 和指纹过滤之前，不代表最终写入 prompt 的数量。查询成功与摘要可用分别统计；缺少内容计数字段时显示未知，不计为无内容。状态栏区分已连接、当前摘要就绪、使用旧摘要和摘要暂不可用，后台索引完成也保留最近查询的摘要状态。

延迟统计使用 **Provider 调用到返回**，按自动非缓存、手动非缓存、缓存命中、续显分别显示，只计返回了补全的调用。这不是编辑器实际展示灰字的回执，也不把手动请求或 0ms 续显混入自动非缓存的延迟。

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

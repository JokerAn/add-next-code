# Add Next Code (FIM)

直连 DeepSeek 原生 FIM 接口的 VS Code 行内代码补全扩展。针对前端与全栈工程（Vue 2 / Vue 3 / React Hooks / TypeScript / Node.js）深度优化上下文召回、服务端缓存命中率与防幻觉后处理，兼顾低延迟与极低 Token 成本。

---

## 快速开始

1. **设置 API Key**：打开命令面板（`Cmd+Shift+P` / `Ctrl+Shift+P`），执行 **`Add Next Code: 设置 API Key`**（密钥安全保存在系统 `SecretStorage` 中，不会写入配置文件或日志）。
2. **开始编码**：正常输入停笔后自动出现灰字补全，按 `Tab` 采纳、`Esc` 取消；也可通过 VS Code 原生快捷键手动触发（`editor.action.inlineSuggest.trigger`）。
3. **状态栏菜单**：点击编辑器右下角状态栏的 **`FIM`** 图标，可一键暂停/开启补全、查看本次会话统计与费用估算、打开运行日志或重启 Skimmer 增强。

> 请确保已开启 `"editor.inlineSuggest.enabled": true`。若安装了其他行内灰字补全扩展，建议同一时间只启用一个以免快捷键或显示冲突。

---

## 核心特性

- **智能触发与自适应防抖**：在意图注释回车、代码块开头回车、点号属性访问（如 `this.`、`res?.data.`）处自动缩短等待时间，响应更跟手；在 `return` / `continue` / `break` / `throw` 终止语句后及代码块末尾完整语句 `;` 处自动静默跳过，避免无效打扰。
- **多源上下文精准召回**：
  - **同文件深度关联**：支持中英文意图注释匹配、复合驼峰词拆分、被调用函数定义置顶、新函数调用点反向召回，以及 React `useState` 列表构造与多分支赋值自动感知。
  - **用法与外层作用域**：自动提取当前对象的真实属性候选，跨屏补齐外层变量声明并自动消除重复 `let/var` 声明。
  - **跨文件工作流感知**：自动关联 `git diff` 未提交改动与本窗口其他已打开标签页中的强相关代码片段（自动去重）。
  - **Skimmer 语义增强（可选）**：开启后空闲自动预热，静态解析当前组件成员、子组件 `props/emits/expose`、自定义 Hook 返回结构与本地模块导出签名（需本机安装 Node.js >= 22）。
- **高缓存命中与低成本**：同一意图注释或代码块内连续编码自动沿用提示词头部（跨函数自动刷新），最大化命中 DeepSeek 服务端前缀缓存；被过滤的无效结果自动记入短期负缓存，避免重复计费。
- **防幻觉校验与安全边界**：
  - 自动校验实例成员与状态数组元素属性，发现不存在的属性时自动带草稿线索二次检索修正，并拦截块尾复读、后文回声与无意义纯水注释。
  - 严格遵守 `.gitignore`、`.git/info/exclude` 与 `addNextCode.exclude` 忽略规则，自动隔离 `.env`、密钥文件及未保存的脏文件。

---

## 常用命令

| 命令名称 | Command ID | 说明 |
| --- | --- | --- |
| `Add Next Code: 打开快捷菜单` | `addNextCode.showMenu` | 汇总开关、会话统计、日志、API Key 与 Skimmer 快捷操作 |
| `Add Next Code: 设置 API Key` | `addNextCode.setApiKey` | 设置或更新 DeepSeek API Key |
| `Add Next Code: 清除 API Key` | `addNextCode.clearApiKey` | 清除已保存的 API Key |
| `Add Next Code: 开启/关闭补全` | `addNextCode.toggle` | 临时暂停或恢复代码补全 |
| `Add Next Code: 显示本次会话统计` | `addNextCode.showStats` | 查看请求数、采纳率、缓存节省比例、估算费用与分位耗时 |
| `Add Next Code: 打开日志` | `addNextCode.showLog` | 打开输出面板查看单次补全指标日志 |
| `Add Next Code: 重启 Skimmer 增强` | `addNextCode.restartSkimmer` | 重启后台 Skimmer 语义分析服务 |

---

## 配置参考（含高级与隐藏配置）

以下为完整的 `settings.json` 配置项及默认值。标注 **`[仅用户级]`** 的配置项出于安全限制仅在 **User `settings.json`** 中生效，工作区 `.vscode/settings.json` 无法覆盖：

```jsonc
{
  // ── 基础与模型 ──
  "addNextCode.enable": {
    "*": true,
    "plaintext": false,
    "markdown": false,
    "scminput": false
  },
  "addNextCode.endpoint": "https://api.deepseek.com/beta/completions", // [仅用户级] FIM 接口地址
  "addNextCode.model": "deepseek-flash",

  // ── 触发与交互策略 ──
  "addNextCode.trigger.mode": "auto",               // "auto" 停笔自动触发 | "manual" 仅手动触发
  "addNextCode.trigger.debounceMs": 1000,           // 普通位置停笔等待时间（300~5000ms）
  "addNextCode.trigger.adaptiveDebounce": true,     // 注释/代码块回车、点号后自动缩短防抖
  "addNextCode.trigger.minIntervalMs": 3000,        // 同一文件两次自动请求的最小间隔（ms）
  "addNextCode.trigger.blankLine": "smart",         // 空行策略："smart" | "strict" | "always"
  "addNextCode.suggestWidget": "extend",            // 建议列表弹出时："extend" 基于选中项续写 | "skip" 不显示灰字

  // ── 输出长度与上下文预算 ──
  "addNextCode.request.maxTokens": 96,              // 自动触发最大输出 tokens
  "addNextCode.request.maxTokensManual": 192,       // 手动触发及代码块模式最大输出 tokens
  "addNextCode.request.maxLines": 12,               // 软截断基准行数（未配平时最多延伸至 2 倍）
  "addNextCode.request.temperature": 0,             // 采样温度（0 保证确定性与负缓存生效）
  "addNextCode.request.timeoutMs": 8000,            // 请求总超时（ms）
  "addNextCode.context.prefixChars": 6000,          // 光标前窗口字符预算
  "addNextCode.context.suffixChars": 1500,          // 光标后窗口字符预算
  "addNextCode.context.headerChars": 6000,          // 外部上下文头部字符预算
  "addNextCode.context.maxPrefixLines": 300,
  "addNextCode.context.maxSuffixLines": 100,
  "addNextCode.context.extraWaitMs": 500,           // 上下文收集最大等待时间（ms）

  // ── 上下文来源与校验开关 ──
  "addNextCode.context.useLanguageService": true,   // 启用 VS Code 语言服务符号兜底
  "addNextCode.context.fileUsage": true,            // 启用当前文件对象成员与前缀候选索引
  "addNextCode.context.fileSnippets": true,         // 启用同文件窗口外相关代码片段召回
  "addNextCode.context.gitDiff": true,              // 启用 git diff 未提交相关改动召回
  "addNextCode.context.openTabs": true,             // 启用已打开标签页跨文件相关片段召回
  "addNextCode.context.reuseHeader": "block",       // 头部缓存沿用："block" | "intent" | "off"
  "addNextCode.verify.members": "strict",           // 成员真实性校验："strict" 校验重发并截断 | "retry" 仅重发 | "off" 关闭

  // ── 隐私与文件排除规则 ──
  "addNextCode.respectGitignore": true,
  "addNextCode.exclude": [
    "**/.env*",
    "**/*.pem",
    "**/*.key",
    "**/node_modules/**",
    "**/dist/**"
  ],

  // ── 可选：Skimmer 静态语义增强（均需配置在 User settings.json，需 Node.js >= 22）──
  "addNextCode.skimmer.enabled": false,             // [仅用户级] 开启跨组件/Hook/模块静态接口增强
  "addNextCode.skimmer.command": "npx",             // [仅用户级] 启动命令（如 "npx" 或 "node"）
  "addNextCode.skimmer.args": [                     // [仅用户级] 启动参数
    "-y",
    "@jokeran/frontend-code-skimmer@^0.9.0"
  ],
  "addNextCode.skimmer.nodePath": "node",           // [仅用户级] Node.js >= 22 可执行文件路径
  "addNextCode.skimmer.maxDocumentChars": 2000000,

  // ── 隐藏实验与排障配置（默认关闭；开启日志转储会输出源码片段，共享屏幕时请勿开启）──
  "addNextCode.experimental.referenceNearCursor": false, // 实验：将强相关参照代码插在光标上方而非顶部 Header
  "addNextCode.debug.dumpPrompts": false,                // 排障：在日志面板输出完整请求 Prompt
  "addNextCode.debug.dumpCompletions": false             // 排障：在日志面板输出模型原始返回、校验项与最终展示文本
}
```

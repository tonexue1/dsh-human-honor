# 人类荣耀 · dsh-human-honor

DSH 的个人编程学习插件。让 AI 正常写代码，打开 `/honor` 看这次改动中值得理解的知识点。每条卡片包含一个问题、适用条件、可迁移的规律，以及来自真实改动的源码。用户可以直接标记「我会了」，或挑一条知识运行学习实验。

## 在 DSH 中使用

需要 Node.js 24.9 或更高版本。Git 用于仓库导入和工作区对比；Python 3（带 sqlite3）用于 SQLite 配方。从 GitHub 获取源码后，在仓库根目录打包并安装到 DSH Web profile：

```sh
npm pack
dsh plugin --profile web add ./dsh-human-honor-0.1.0.tgz
```

重新启动对应的 DSH profile。在一个 Git 工作区让 DSH 修改代码。宿主发出顶层会话工作区变更事件后，插件立即取得源码片段，再在后台分析。可以继续原来的开发任务。DSH 会话需启用 `tools`、`llm` 和 `workspaceChanges` 服务；如要使用斜杠命令，还需 `commands` 服务。Desktop 的 profile 由 Electron 宿主管理。上面这条安装命令针对 Web profile，当前已验收的宿主版本见文末。

| 在哪里操作 | 能做什么 |
|---|---|
| `/honor`、`/honor tree` | 查看待判断知识，或按主题查看个人知识树 |
| `/honor show <key>`、`/honor search <词>` | 查看适用条件、原始片段和出处，或查找某条规律 |
| `/honor known <key>`、`/honor later <key>`、`/honor inbox <key>` | 确认已会、稍后再学或撤销之前的决定。已会知识在默认列表中折叠 |
| 在会话里说「带我推一遍这条知识」或「跑一下它的 Demo」 | Agent 调用 `honor_learn` 或 `honor_demo`，可以按原代码提问，并返回实验目录与实测报告 |
| 在会话里说「从这个仓库的 src 目录提炼知识」 | Agent 调用 `honor_import`，后台扫描该目录已提交的 Git 快照。远端仓库也能用下面的命令导入 |

## 在终端直接试

进入仓库根目录即可使用源码，不需要安装 npm 包依赖。先跑一个实验，再看产物目录里的 README，自己换一组输入：

```sh
node bin/human-honor.mjs demo js-latest-request --out ./labs
node bin/human-honor.mjs demo sql-version-guard --out ./labs
```

从自己的本地仓库提炼知识。用实际路径替换示例里的仓库路径：

```sh
node bin/human-honor.mjs changes /path/to/your/repo
node bin/human-honor.mjs list
node bin/human-honor.mjs tree
node bin/human-honor.mjs show sql-version-guard
node bin/human-honor.mjs mark sql-version-guard known
```

`changes` 读取 HEAD 到当前工作树的净改动，含未跟踪源文件；`--staged` 只分析已暂存内容。`import` 可接受本地 Git 工作树或公开 HTTPS Git URL，读取固定提交中的源码且不执行仓库脚本。支持 `--subpath` 和 `--ref`。默认最多 150 份文件，每份最多 128 KiB。超过上限时可按目录再次导入。终端支持 `--json`、`--help`。

### 模型与数据

DSH 模式尝试复用该会话的模型路由。未取得模型路由时，离线提取仅识别两种写法：SQL 的版本条件更新、JavaScript/TypeScript 的请求序号检查。只在找到合适代码时出卡，空结果也会缓存。通用语言解析和开放式实验构造需要模型。

终端运行时，可配置 OpenAI 兼容接口。设置 `HUMAN_HONOR_CHAT_URL` 为完整的 chat completions URL，`HUMAN_HONOR_MODEL` 为模型 ID，服务要求认证时通过 `HUMAN_HONOR_API_KEY` 提供密钥。配置后，分析会将筛选过的代码和已有知识候选交给所选模型。没有配置时，CLI 使用离线规则。

默认数据库为 `~/.dsh-human-honor/knowledge.sqlite`。覆盖路径可用 `HUMAN_HONOR_DB` 或 CLI 的 `--db`；`HUMAN_HONOR_DEMOS` 可指定实验根目录。宿主未完成的提取任务放在数据库旁的 `.queue` 文件中。失败的材料可通过 `honor_retry` 重试。个人库保存逐字引用的证据，已掌握状态由用户明确操作更新。主题路径供浏览，稳定的知识 key 用于复用：两个仓库中的同一规律只建一张卡，各自保留出处。模型的跨技术栈匹配仍需实践检验。

## 什么算实验跑通

内置 JS 实验让两个 Promise 以 AB 或 BA 顺序完成，比较是否可能显示过期结果。内置 SQL 实验用两个连接打开真实 SQLite，比较检查版本前后能够更新的行数和最终值。两者均有验收器：先实际运行正向样例，再在副本里撤掉决定行为的条件，检查错误结果真的出现。每次创建独立目录，保留用户修改过的旧实验。

其他知识也可制作新实验。模型先生成输入、对照组/实验组的预期输出；插件冻结这份验收计划后才请求模型构造程序和反向对照。通用执行器支持 Node.js 和 Python 的单文件程序和标准库。使用终端时：

```sh
node bin/human-honor.mjs demo <知识ID> --out ./labs
node bin/human-honor.mjs lab-verify <上一步生成的目录>
```

`demo <知识ID> --run` 会构造后直接运行新实验，在失败时根据原始验收条件尝试修复一次。运行器通过当前用户的本地解释器执行新程序，独立临时目录并非操作系统沙箱。DSH 模式将新生成的实验交还宿主终端运行，以沿用宿主权限。没有模型时可以在草稿中写 `plan.json`，用 `lab-freeze` 冻结预期，再补程序和变异说明。只有 `verify-report.json` 中 `verified: true` 表示本次实测通过；它说明这些输入下的实验现象成立。浏览器、移动设备和需要额外基础设施的运行器尚待接入。

## 本地验收

```sh
npm test
```

源码包保留了真实 DSH 宿主冒烟脚本。将 `DSH_CLI` 指向本机 `@deepseek-ai/dsh/lib/bin.js` 后运行 `node scripts/smoke-dsh.mjs`。它打包并安装至临时 web profile，通过 DSH 的真实工作区、会话、工具和模型服务验证采集、入库和运行实验。宿主测试使用确定性的模型适配器，不需要 API key。本版已在 DSH 0.2.1-rc.2、0.2.2-rc.1 的临时 Web profile 上装包，再通过真实 Cordis/DSH 服务验证工作区变更、斜杠命令和实验执行。32 项自动测试通过。尚需在目标 Desktop 配置及实际模型上验证提取准确率和长会话体验。

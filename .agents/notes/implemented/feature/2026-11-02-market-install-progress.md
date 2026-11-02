# Agent Note: 插件安装/更新的进度流与「装完不再重拉目录」

Status: implemented

## Problem

市场里点一次「安装」，页面只会把底部活动行改成「正在安装 X …」，然后**一动不动**，直到成功或失败。pnpm 启动本身就要 1.5 秒才开始输出（实测：首行 `Progress:` 出现在 1523 ms），依赖多的插件要几十秒到几分钟，这期间用户完全无法判断它是在下载、在链接、还是已经卡死。

慢的第二个来源在安装**之后**：成功后窗口会用 `loadCatalog(catalog.page)` 刷新列表——这是一次完整的目录请求（社区目录约 5 MB），而它要表达的只是「这一张卡片的已装标记变了」。

## Decision

**进度**：把 pnpm 的输出变成一条事件流。

1. `pnpmArgs` 增加 `--reporter=append-only`（逐行、格式稳定，是进度解析的前提）与 `--prefer-offline`（`name@1.2.3` 这种精确版本内容不会变，优先用本地元数据，省掉一次 registry 往返）。
2. `runPnpm` 按行切分 stdout/stderr，通过 `onLine` 回调逐行吐出；`MarketInstallOptions.onOutput` 把行透传给上层。
3. `describeProgress(line)`（纯函数，单测覆盖）把 `Progress: resolved 12, reused 9, downloaded 3, added 1` 翻译成 `{phase, detail}`：`resolve` / `download` / `link` / `done`，人话是「已解析 12 · 复用 9 · 下载 3 · 已链接 1」。**看不懂的行返回 `undefined`**，失败信息不会冒充进度。
4. `MarketService.#act` 在 spawn 之前先发一帧 `starting`（覆盖 pnpm 启动那 1.5 秒的空白），之后每解析出一行发一帧，结束时发 `done`/`failed` 并带总耗时；事件形状 `{action, name, phase, detail, elapsedMs}`，经新 IPC 通道 `market:progress` 推到窗口（`preload` 暴露 `onProgress`）。
5. 窗口顶部一条进度条：转圈 + 「下载中 · 插件名」+ 明细 + 已用时（本地 100 ms 计时，主进程事件里的 `elapsedMs` 校正）。安装/更新/卸载/从 GitHub 安装四条路径都走它。

**速度**：动作成功后改为 `renderCatalog()` —— 用刚刷新的 `installed` 映射就地重绘，不再请求目录。目录快照本来就是 10 分钟缓存，安装不该为了翻一个标记去付那 5 MB。

## Alternatives considered

- **只放一个转圈动画，不接 pnpm 输出**（最强理由：零解析、零 IPC）。放弃原因：转圈无法区分「在下载」和「卡住」，而用户抱怨的正是"我不知道正在发生什么"；假进度比没有进度更糟，卡死时它会一直转。
- **用 pnpm 的 `--reporter=ndjson` 拿结构化事件**（最强理由：不用解析人类可读文本）。放弃原因：pnpm 11 没有稳定的 ndjson reporter（`--reporter` 只认内置名），自己解析 JSON 就得跟着上游的私有格式走；`append-only` 是它的默认非 TTY 形态，反而更稳。
- **轮询动作日志（`market.log`）来猜进度**（最强理由：日志已经存在）。放弃原因：日志在动作**结束**时才写一条，中间没有任何东西可轮询；为了进度改成边跑边写，会把"日志是结果"的语义破坏掉。
- **自己下载 tarball 并显示百分比**（最强理由：真正的字节级进度）。放弃原因：等于把 pnpm 的解析/链接/脚本执行全部重写一遍，而慢的部分往往在依赖解析与构建脚本，不在单文件下载。

## Consequences

- **收益**：安装期间每秒都有新信息（阶段 + 依赖数字 + 耗时）；用户能判断"在动"与"卡在下载"。
- **收益（速度）**：装完立刻看到卡片状态，不再为一次刷新多等一个目录请求；精确版本安装少一次 registry 元数据往返。
- **代价**：pnpm 命令行多了两个参数——凡是断言 `pnpmArgs` 的测试都跟着改（`market-install.test.ts`、`market-github-install.test.ts`）。`--prefer-offline` 的语义是"元数据优先用缓存"，若某个包的中段元数据被上游重新发布（npm 不允许，但镜像可能），可能读到旧元数据；精确版本场景下这是可接受的取舍。
- **边界**：进度事件是 best-effort——窗口关掉后 `webContents.send` 直接丢弃，动作照常在主进程跑完；`describeProgress` 只认 pnpm 现有输出形态，上游改文案时进度会退回「准备中/完成」两帧，不会报错。
- **测试**：`describeProgress` 7 条样例 + 未知行；`runMarketAction` 的 onOutput 透传；`MarketService.install` 的事件序列（starting → download → link → done，末尾带耗时）；`market-ui.test.ts` 继续守着 id 存在与「页面不 fetch / 不 innerHTML」。
- **未覆盖**：没有在真实慢网络下做时长对比（本机 cold store 单依赖安装 2.7 s、pnpm 启动占 1.5 s）；`--prefer-offline` 的实际节省取决于 registry 往返延迟，未单独量化。

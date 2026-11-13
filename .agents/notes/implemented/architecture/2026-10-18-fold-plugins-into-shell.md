# Agent Note: 把 deepseek-harness-plugins 的功能并进桌面壳

Status: implemented

- 日期：2026-10-18
- 相关：`2026-10-16-desktop-performance-baseline.md`（genui 掉帧）、`2026-10-18-pocket-bridge-dead-buttons.md`
  、`2026-10-19-shell-plugin-rows-never-mounted.md`（0.4.6 对注入方式的纠偏）

## 问题

桌面壳此前把这批能力当成「用户自己装的 DSH 插件」维护：

- ONE-WAY 用量监控是 `dsh-oneway-usage-monitor`，界面在 DSH 页面里，宿主半区抓 HTML、管 Cookie；
- git 变更 / 运行配置 / 工作区分类 / 侧栏宽度四个面板由 `dsh-plugin-kit` 从市场装进 profile；
- MCP 与 Skills 的管理界面也在 `dsh-plugin-kit` 的 `dsh-mcp-skill-manager` 里。

用户要求：ONE-WAY 做成壳窗口（标题栏新增菜单、功能齐全）；四个面板改成随壳注入；MCP/Skills 只做「维护 DSH 配置」的壳窗口，不做注入插件。目标是壳自己就是这套能力的唯一来源，不再独立维护插件仓库的发布节奏。

## 决定

### 1. ONE-WAY 用量 = 壳窗口（标题栏「用量」）

- 主进程 `oneway-service.ts` 从插件宿主移植：HTML 解析、`CookieJar`、企业微信扫码登录状态机、日志分页。
  所有失败（未登录/401/网络/页面结构变化）都降级成 `snapshot.error`，不把异常抛给页面。
- `usage-state.ts` 把会话 Cookie 与网关配置存 `bridgeDir()/oneway.json`（0600、原子写、非法值拒绝而非静默 clamp）。
- `usage-window.ts` + `usage-ui/index.html`：三张指标卡（近 5 小时/今日/本周，含占比与周为 0 时回退本月）、
  四个标签页（请求日志、趋势、渠道限额、渠道与模型）、扫码登录弹窗、可折叠设置。
- 页面无网络、无 `innerHTML`，只通过 preload 的 `__DSH_USAGE__` 拿快照。

### 2. MCP 与 Skills = 壳窗口，直接改 DSH 配置

- MCP 服务本质就是 `@deepseek-ai/dsh-mcp-client` 的 loader 行（schema 与随包运行时逐字段核对过），
  因此不需要任何插件：窗口把行写进 profile 补丁即可。**行必须写在置顶的 `- insert: [...]` 容器里**：
  顶层非 insert 条目里的 `name` 只是断言，不会挂载；0.4.5 的迁移正是把行写成了顶层，四个服务全部
  掉线，0.4.6 起启动时会把旧写法自动搬进容器（见
  [修复笔记](../bug-fix/2026-10-19-shell-plugin-rows-never-mounted.md)）。
- `dsh-config.ts` 用 `yaml` 的 Document API 就地改，保留注释与无关行；写前备份、最多留 5 份。
- 旧 `dsh-mcp-skill-manager` 的 `mcpServers` 一次性迁移成原生行并删旧行（幂等、先备份）；真实 profile 演练成功。
- Skills 走 `$DSH_HOME/skills`（bundle / 单文件 / junction 链接），壳只删除自己创建的链接。
- 入口放「插件」菜单 →「MCP 与 Skills…」，保存后提示并可直接重启 DSH。

### 3. 四个面板插件随壳注入（0.4.6）

> **已被取代（2026-11-13）**：按用户要求，这四个面板改为 profile 插件，不再打进
> `resources/plugins`。本节保留当时“随壳注入”的决策与证据，仅作历史；当前做法见
> [四个面板改为 profile 插件](./2026-11-13-four-panels-as-profile-plugins.md)。

- `scripts/prepare-plugins.mjs` 只复制运行时文件 + 依赖闭包：**300 文件 / 2.38 MiB**（0.4.6 起含
  host 半区运行时 import 的 `src/`；此前漏掉它，git 面板与运行环境两个插件打包后 `ERR_MODULE_NOT_FOUND`），
  而整目录复制是 109 MB（jsdom/esbuild/react/typescript 全是构建期依赖）。产物 `resources/plugins` 不入库；
  复制后按入口点的相对 import 自检，缺目录直接构建失败。
- 启动时 `plugin-provision.ts` 把插件 junction 进当前 profile 的 `node_modules`，并把包名追加进 profile
  `package.json` 的 `dsh.profile.bundles`：每个插件包自带 `dsh.bundle.patch`（`- insert: [{id, name}]`），
  harness 只为 bundle 列表里的包装载这一层，用户补丁里的同 id 条目则作为覆盖生效（分类、运行环境、
  侧栏宽度等配置原样保留）。**不能**改写成往用户补丁里塞 `{id,name}` 顶层行：DSH patch 语义里带 name
  的顶层条目只是断言、不会插入（0.4.5 因此四个插件一行都没挂载，见
  [0.4.6 修复笔记](../bug-fix/2026-10-19-shell-plugin-rows-never-mounted.md)）。
- 已有真实目录改名 `.bak-shell-*` 保留、不删除；`dsh-plugin-kit` 从 profile 的依赖与 bundle 列表移除
  （备份）；ONE-WAY / MCP-Skills 旧行移除。
- `resources/plugins` 随 `extraResources` 进安装包；`package:win/dir/debug` 自动跑 `plugins:prepare`；
  `verify-package.mjs` 与发版预检校验清单、入口和 schemastery 依赖，0.4.6 起还会用打包壳在干净 home 上
  真跑一次冒烟 + `dsh --dump-config`，断言插件包已登记/挂载、MCP 行在 insert 内、启动日志无
  `did not activate`（见 [修复笔记](../bug-fix/2026-10-19-shell-plugin-rows-never-mounted.md)）。

### 4. 2026-11-13：会话通知插件也随壳分发

- 背景：用户的 `dsh-win-notify` 包还在 `node_modules`，但不在 profile 的依赖与 `dsh.profile.bundles`
  里，DSH 从未加载它，会话结束/人工干预通知静默消失；插件自身测试 25/25（宿主）与 36/36（客户端）全过。
- 决定：把它作为第五个随壳插件，和四个面板插件同一条链路分发；不再让用户手动登记本地 `link:`，
  避免插件仓库路径变化后再次静默失效。
- 实现：`prepare-plugins.mjs` 的 `PACKAGES` 增加 `dsh-win-notify`；`KEEP_FILES` 增加根级
  `client.js`——这个插件的客户端半区没有打进 `lib/client.js`，漏掉它会让宿主半区加载而客户端观察器不挂载。
  `verify-package.mjs` 的组合门禁改为按 `plugins.json` 的实际数量断言登记日志，并断言 `win-notify`
  行真实挂载。
- 证据：`plugins:prepare` 为 5 个插件 / 349 文件 / 2.67 MiB；dev 壳启动日志出现
  `随壳插件：已链接 1 个（dsh-win-notify）到 profile` 与 `[dsh-win-notify] 客户端侧已启用`；
  `/dsh-win-notify/config` 返回 200；实际跑一轮会话后 shell 日志出现
  `系统通知：DSH 会话通知 —— 「只回复 OK」已执行完成`。桌面全量 665 测试 / 0 失败。

### 5. 2026-11-13：任务看板 `dsh-super-kanban` 也随壳分发（上游源码 vendored）

> **已被取代（2026-11-13 晚些时候）**：按用户要求，任务看板改为 profile 插件，不再打进
> `resources/plugins`。本节保留当时“随壳分发”的决策与证据，仅作历史；当前做法见
> [任务看板改为 profile 插件](./2026-11-13-task-board-as-profile-plugin.md)。

- 背景：用户看中上游 topmindspace/dsh-super-kanban（把 DSH 会话提炼成任务卡的 AI 看板：全局/右侧/悬浮三形态、待验收/待处理、快聊、项目与工作区），
  要求「源码放到我们的 plugin 项目里，以后可以自己改」，并内置进桌面壳，而不是让用户从市场装。
- 取源：上游 v0.10.0（commit 64cdc88，2026-11-13，MIT）。源码作为独立目录 `dsh-super-kanban/` 进 `deepseek-harness-plugins` 仓库
  （同仓库的其它插件目录并列），排除 `.git` 与 `.github/`（后者含会往 npm 发布的 CI/release 工作流）；包内 `UPSTREAM.md` 记来源、
  本地改动（为自检删掉 `tests/package.test.mjs` 里两条 `.github/workflows` 断言）与和上游 `diff -ru --exclude=.git --exclude=.github` 的同步方式。
  该副本自带 309 条测试，取入后全绿。
- 形态与其它五个随壳插件不同：宿主入口是 `index.mjs`（不是 esbuild 出的 `index.js`），宿主实现全在 `server/`（12 个 `.mjs`，
  `service.mjs` 157 KB、`sessions.mjs` 57 KB）；客户端半区是**手写的** 428 KB `client.js`（`window.__ModuleLoader__.load`），无构建、
  `package.json` 里没有任何 dependencies/peerDependencies（上游测试断言零依赖），因此依赖闭包拷贝对它什么都不做。
  包声明 `engines.dsh ">=0.2.1-rc.5 <0.3.0"`，随包运行时 0.2.2-rc.2 在范围内；`dsh.client.inject` 只要 locale/layout/sidebar/workspace 四个标准服务。
- 实现（`prepare-plugins.mjs`）：`PACKAGES` 增加 `dsh-super-kanban`；`KEEP_FILES` 增加 `index.mjs`；`KEEP_DIRECTORIES` 增加 `server/`；
  入口改为读包声明 `main`（缺省 `./index.js`）再校验存在性，不再写死 `index.js`。
  同时把「入口的相对 import 自检」扩展成**全部复制进来的模块**：上游 `server/service.mjs` 用多行 `import {…} from "./store.mjs"`，
  只查入口的话少一个 `server/` 文件仍能构建通过、启动才报 `ERR_MODULE_NOT_FOUND`。
- `verify-package.mjs` 的组合门禁在原有 id 列表里加 `super-kanban`，打包后断言它的行真实出现在 `dsh --dump-config` 里。
- 证据：`plugins:prepare` 为 6 个插件 / 365 文件 / 3.39 MiB，其中 dsh-super-kanban 16 文件 / 0.72 MiB / deps 为空；
  负向验证：临时抽走源里的 `server/store.mjs`，构建以 `dsh-super-kanban: server\service.mjs 引入了 ./store.mjs，但复制后的目录里没有它` 退出 1；
  恢复后重新变绿。桌面全量测试 665 条 / 657 通过 / 0 失败 / 8 跳过；`build.mjs` + `smoke.mjs cookie --isolate-home` PASS，
  启动日志 `随壳插件：已链接 6 个（… dsh-super-kanban …）`，产品页侧栏出现「任务看板」（字符串即 `client.js` 的 `任务看板` 标题），
  `readyState complete`。冒烟里唯一的新警告是上游 `dsh-client-ui-account-notifications: pending (waiting for service: accountUi)`，
  属 0.2.2 的既有等待，`verify-package.mjs` 的门禁早已只把「命名了随壳插件」的 `did not activate` 判为失败。

## Alternatives considered

- **把插件源码并进 `dsh-desktop-shell` 面板插件，合成一个大包**。理由：能少一个分发单元，但四个插件是
  DSH 客户端插件（要注册服务、侧边栏 tab、设置面），塞进壳的面板插件等于重写它们并和上游分叉；
  它们本来就是独立包，链接注入能保留原样升级路径。代价是安装包多 1.75 MiB，可接受。
- **把 MCP/Skills 也做成注入插件**。用户明确说只是维护配置；而且注入插件会把「配置归谁」再次搅浑，
  旧插件正是因为自己在运行时创建 MCP 客户端，才让配置无法被别的界面复用。
- **直接复制整份插件目录（含 node_modules）**。109 MB→安装包膨胀、更新变慢；实际运行时闭包只有 1.75 MiB。
- **MCP 迁移时保留旧插件行**。插件包一旦注入就会再创建一份 MCP 客户端，服务器会出现两次；必须删旧行。
- **把 `yaml` 用 esbuild 打进 main**。它是 CJS 且在 `composer.js` 里 `require('process')`，打进 ESM main 后
  启动即抛 `Dynamic require of "process" is not supported`；改为 external + 作为 production 依赖放进 ASAR
  的 `node_modules/yaml`（`files` 显式声明）。

## 证据

- 测试：`dsh-config` 9 组、`mcp-ui` 7 组、`plugin-provision` 8 组、`oneway-service` 29 组、`usage-state` 5 组、
  `usage-ui` 14 组；全量 529 条 / 0 失败 / 8 跳过；`tsc --noEmit` 干净。
- 迁移演练（真实 profile 副本）：4 个 MCP 服务（jenkins_dev/jenkins_prod/dbx/gwd-mcp）全部转成原生行，
  注释保留、旧行删除、ONE-WAY 会话可读；dev profile 上 8 个服务迁移同样通过。
- 真机注入：dev 启动日志 `随壳插件：已链接…`、`已补 1 条首次使用的插件行`、`已移除 1 条旧插件行`，
  profile 清单去掉 plugin-kit（有备份），DSH 启动无 `failed to import`。
  **这条证据后来被推翻**：当时的 dev 构建还在「保留非壳创建的链接」的旧分支，日志里的「已链接」并没有
  真正把链接指向随壳副本；「已补插件行」补的是顶层断言行，DSH 从未挂载。0.4.5 发布后用户报障，
  根因与修复见 [0.4.6 修复笔记](../bug-fix/2026-10-19-shell-plugin-rows-never-mounted.md)：
  插件改为登记 profile bundles，MCP 行改为置顶 insert 容器，链接删除改用 unlinkSync。
- 菜单冒烟：`app/plugins/pocket` 菜单可打开（「插件」里含「MCP 与 Skills…」），用量窗口与 MCP 窗口的
  loaded/bridge/selectors/close 全绿。冒烟加了每步 15 s、整体 90 s 看门狗——正是它抓到了手机访问服务队列
  偶发阻塞 15 s 的问题（不影响功能，报告里记录为步骤超时）。
  **注**：这个冒烟名单本身也是手写的，漏了 `usage`，所以标题栏「用量」按钮的死守卫没被它抓到；
  0.4.6 起改成遍历 `MENU_TEMPLATES`。
- 发版：v0.4.5 已发布；安装包 223.9 MiB，4 个资产；匿名 HEAD 安装包与 APK 均 200；
  打包版冒烟 PASS（运行时 0.2.1-rc.2、壳 0.4.5、面板注入、cookie 认证、手机访问网关全通过）。

## Consequences

- 首次启动会改用户 profile（补丁/package.json 都有 `.bak-shell-*` 备份）：若用户在别处手改了同名行，
  迁移是幂等的，但**不会**回滚旧插件行——回滚需要用户自己从备份恢复。
- 已有 profile 里若同名目录是真实目录，壳会改名保留并改用随壳版本；升级插件版本靠壳发版，不再靠市场。
- MCP 会话 Cookie 从旧 ONE-WAY 行导入 `oneway.json`，旧行删除后不影响重扫码。
- 随壳插件升级只随壳发版：`dsh-win-notify` 仍随壳（见第 4 节），不再走市场；
  任务看板已改为 profile 插件（见第 5 节的取代说明及新笔记），不再随壳。
  `dsh-super-kanban` 是 vendored 的上游源码（插件仓库里的 `dsh-super-kanban/`，含 `UPSTREAM.md`），
  上游后续版本要按该文件里的 `diff -ru --exclude=.git --exclude=.github` 手工同步，不会自动跟随 npm。
- 手机访问 `pocket-close` 在冒烟里的偶发超时仍未定位到具体服务调用（当前用看门狗兜住，不影响用户）。

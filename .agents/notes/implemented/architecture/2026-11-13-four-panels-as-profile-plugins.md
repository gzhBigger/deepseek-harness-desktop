# Agent Note: 四个面板插件改为 profile 插件

Status: implemented

> 部分取代 [把 deepseek-harness-plugins 的功能并进桌面壳](./2026-10-18-fold-plugins-into-shell.md) 第 3 节。
> 那一节保留 0.4.6 起“四个面板随壳注入”的决策与证据；从 2026-11-13 起，git 面板 / 运行环境 /
> 工作区分类 / 侧栏宽度不再进安装包，改由用户 profile 的 `link:` 依赖加载。

## Problem

`dsh-git-panel`、`dsh-run-env-manager`、`dsh-workspace-category-manager`、`dsh-sidebar-width`
四个面板自 0.4.6 起由壳分发：`prepare-plugins.mjs` 把它们复制进 `resources/plugins`，
`plugin-provision.ts` 在每次启动时 junction 进 profile 并登记 `dsh.profile.bundles`。因此：

- 用户改插件必须重新打包发版；即使直接改 profile 的链接，壳重启也会覆盖回安装目录副本。
- 三个包在 npm 上没有可安装版本（`dsh-run-env-manager` / `dsh-workspace-category-manager` /
  `dsh-sidebar-width` 均 404），`dsh-git-panel@0.1.20` 是另一个人的包（maintainer
  a792883583，repository `git+https://github.com/a792883583/dsh-git-panel.git`），
  所以“从市场装”这条路走不通。
- 用户要求这 4 个与 `dsh-super-kanban` 一样，只是普通 dsh 插件。

## Decision

**把四个包从随壳清单移除，运行源改为 `deepseek-harness-plugins` 仓库源码，profile 用 `link:` 声明。**

- `electron/scripts/prepare-plugins.mjs`：`PACKAGES` 只剩 `dsh-win-notify`；注释写明四个面板是
  profile 插件，重新出现在 `plugins.json` 时构建必须失败。
- `electron/scripts/verify-package.mjs`：在 `dsh-super-kanban` 门禁之后，对四个名字逐个断言
  `plugins.json` 不得包含，命中即
  `fail('<name> 已改为 profile 插件，不能再打包进 resources/plugins')`。
  组合门禁的临时 profile 补丁从 `sidebar-width` 覆盖改为 `win-notify` 的
  `notifyKinds: [completed]`，id 列表缩到 `['win-notify', 'mcp-composition_check']`，
  覆盖断言改成 `/notifyKinds:\s*\n\s*- completed/u`。
- profile `~/.dsh/profiles/dsh-desktop/package.json` 与 `dsh-desktop-dev/package.json` 增加四个
  `link:D:/workspace/research/deepseek-harness-plugins/<name>` 依赖；`node_modules/<name>` 从
  `D:\Program Files\DSH Desktop\resources\plugins\<name>`（dev 为
  `electron/resources/plugins/<name>`）改指源码仓库。`dsh.profile.bundles` 保留四个包名——挂载行由
  各包自带的 `cordis.patch.yml`（`- insert: [{id, name}]`）提供，用户补丁里的同 id 条目继续作为配置
  覆盖生效。
- `electron/README.md` 新增第 40 条，写明分发方式、门禁、升级代价。

## Alternatives considered

- **继续随壳，同时在 provisioning 里尊重用户已声明的 `link:`**：能保留自动分发，但壳要区分“用户自己
  链接的”与“上次壳链接的”，只能看 package.json 依赖形态与 junction 目标，判断规则会越来越绕；同一套
  逻辑还要作用到仍随壳的 `dsh-win-notify` 上，语义分叉。用户要的是“插件不是壳的一部分”，不是
  “壳里多一个开关”。
- **新建独立 dev profile 只装这四个**：能隔离壳的覆盖，但看不到用户真实的 workspace / session / 分类
  与运行配置，验证还得重放一遍；日常使用的 profile 仍然看不到改动。看板迁移时已否决过同一方案。
- **把源码复制进 profile 而不是 link**：能避开壳，但每次改完要重新复制，失去“改完刷新即见”。
- **发布到 npm 再走壳内市场**：三个包 404、`dsh-git-panel` 名字已被占用；改用私有作用域需要账号与
  网络，且市场安装是版本化的，仍做不到“改源码立即生效”。

## Consequences

- 收益：四个面板与看板一致，源码仓库就是运行源；客户端半区改完刷新页面即见，宿主半区重启 DSH 生效。
- 代价：新 profile 不再自动拥有这四个面板；从旧版升级的 profile 若 `node_modules` 还指向安装目录，
  必须改指源码（本次已对 `dsh-desktop` 与 `dsh-desktop-dev` 完成），否则启动时报
  `cannot resolve profile bundle`。移动/重命名插件仓库要同步改 `link:` 与 junction。
- 过渡期风险：当前安装的 0.4.32 安装包内仍有这四个包，旧壳下次启动会把 junction 重链回
  `D:\Program Files\DSH Desktop\resources\plugins\<name>`，覆盖本次迁移。**只有安装一个不含它们
  的新壳后才真正生效**；在那之前不要重启旧壳（或重启后重跑链接迁移）。
- `plugins.json` 从 5 个包 / 349 文件 / 2.67 MiB 降到 1 个包 / 46 文件 / 0.23 MiB；
  `verify-package` 的组合门禁随之只剩 `win-notify` + MCP 行。
- 四个插件在 dump-config 里的行 id 不变（`git-panel` / `run-env-manager` / `sidebar-width` /
  `workspace-category-manager`），已有用户补丁与设置命名空间不受影响。

## Verification

- `node scripts/prepare-plugins.mjs`：`resources/plugins` 只剩 `dsh-win-notify`；
  `plugins.json` packages = `["dsh-win-notify"]`，46 files / 236145 bytes。
- profile `--dump-config`（`DSH_HOME=C:/Users/gzh33/.dsh`）：
  - `dsh-desktop`：`- id: git-panel` / `run-env-manager` / `sidebar-width` /
    `workspace-category-manager` 各一行，`name` 正确；`sidebar-width` 覆盖为
    `sidebarWidth: 280`，`run-env-manager` 保留 `environments`，`workspace-category-manager`
    保留 `categories`。
  - `dsh-desktop-dev`：四个 id 各一行；`sidebarWidth: 319`；四个包均无
    `cannot resolve`（仅余一条 `dsh-super-kanban` 链接悬空的旧告警）。
- `npm run typecheck` 通过；`npm test`：665 tests / 657 pass / 8 skipped / 0 fail。
- `npm run package:dir`：exit 0；`组合校验：1 个随壳插件与 MCP 行在打包 dsh 里真实挂载，用户配置生效`；
  `打包校验通过：dsh 0.2.2-rc.2（Electron 44.10.0）、asar 内 33121 个文件…`；
  `release/win-unpacked/resources/plugins` 只有 `dsh-win-notify`。
- 全新临时 profile（`DSH_HOME` 指向临时目录，只声明四个 `link:` 依赖与 bundle 名，不经壳 provisioning）
  用随包 runtime 启动：首行即 `dsh web: http://127.0.0.1:41998/?token=…`，无 `did not activate` /
  导入错误；登录后的页面模块清单含 `dsh-git-panel/client.js`、`dsh-run-env-manager/client.js`、
  `dsh-sidebar-width/client.js`、`dsh-workspace-category-manager/client.js`，整批模块 bundle HTTP 200、
  2.49 MB，含 `dsh-git-panel` / `run-env` / `sidebar-width` / `workspace-category` 标记。

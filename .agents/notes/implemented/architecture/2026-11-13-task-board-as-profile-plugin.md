# Agent Note: 任务看板改为 profile 插件

Status: implemented

> 取代 [任务看板随壳分发](./2026-10-18-fold-plugins-into-shell.md) 第 5 节。那一节保留当时的内置方案与证据；
> 从 2026-11-13 起，`dsh-super-kanban` 不再进安装包，改由用户 profile 通过 `link:` 加载。

## Problem

任务看板（`dsh-super-kanban`）是 vendored 进插件仓库的上游源码，之前作为第 6 个随壳插件打进
`electron/resources/plugins`。这带来两个问题：

- 改一行 `client.js` 也要经过 `plugins:prepare`、重新打包、再发版才能在界面看到；用户希望“改了马上能看到效果”。
- 随壳插件的运行副本由壳在每次启动时重新链接并登记到 profile，用户直接改 profile 链接会被壳覆盖。

## Decision

**把 `dsh-super-kanban` 从随壳插件清单移除，改为 profile 插件，源码仓库直接作为运行源。**

- `electron/scripts/prepare-plugins.mjs` 的 `PACKAGES` 不再包含 `dsh-super-kanban`；复制器继续支持
  `index.mjs` 与 `server/`，因为其他 plain-ESM 插件仍可能需要。
- `electron/scripts/verify-package.mjs` 删除组合 id 列表中的 `super-kanban`，并加一条显式门禁：
  `plugins.json` 里一旦出现 `dsh-super-kanban`，校验直接失败并提示“已改为 profile 插件，不能再打包进 resources/plugins”。
- 用户 profile `dsh-desktop` 的 `package.json` 增加依赖
  `"dsh-super-kanban": "link:D:/workspace/research/deepseek-harness-plugins/dsh-super-kanban"`，
  bundle 列表保留 `dsh-super-kanban`；`node_modules/dsh-super-kanban` 从安装目录副本改为指向源码仓库的 junction。
- 热更新语义：
  - 客户端半区（`client.js`）由页面直接加载；改完刷新页面即可看到，无需重启 DSH。
  - 宿主半区（`index.mjs`、`server/`）在服务启动时加载；改完需要重启 DSH（或重启对应宿主进程），不会随页面刷新重载。
- 这不是“开发模式专用”配置：源码仓库就是运行源，用户可以直接改；升级/回退仍由插件仓库的 git 管理。

## Alternatives considered

- **继续随壳，但提供 dev override**：壳每次启动仍会重新链接 `resources/plugins/dsh-super-kanban` 并登记 bundle，
  override 会被覆盖；要保留 override 就得在 provisioning 里加特例，路径会越来越绕。
- **新建一个独立 dev profile 只装看板**：能隔离，但看不到用户真实的 workspace/session/分类配置，验证还得再复制一份，
  而且用户日常用的 profile 仍看不到改动。
- **在 profile 里复制一份源码而不是 link**：能避开壳的链接，但每次改完要重新复制，失去“改完刷新”的收益。
- **保留随壳分发，只把 `client.js` 做成外部文件**：可以热改，但插件清单仍归壳管，宿主半区与升级路径还是随壳版本走；
  用户要求的是“看板是插件”，不是“插件里再开一个外部文件”。

## Consequences

- 新 profile 不再自动拥有任务看板；需要装 `dsh-super-kanban`（或从已有 profile 迁移）后才出现「任务看板」。
  这是把看板当普通插件的直接代价。
- 当前已安装的 0.4.31 仍然把看板打在安装包里，启动时会重新链接旧副本并覆盖 profile 的 link。**只有安装一个不含
  `dsh-super-kanban` 的新壳（下一次发版）后，这个方案才对用户真正生效。** 在此之前重启 0.4.31 会把 link 改回
  `D:\Program Files\DSH Desktop\resources\plugins\dsh-super-kanban`。
- 安装包少一个插件、`plugins.json` 从 6 个变 5 个；`plugins:prepare` 为 5 个插件 / 349 files / 2.67 MiB，
  `package:dir` 的组合校验按 5 个插件通过。
- 客户端改动可以秒级验证；宿主改动要重启 DSH，不能把“刷新即生效”误解成全部代码都热重载。
- 看板源码仓库成为运行依赖；移动/重命名仓库必须同步更新 profile 的 `link:` 与 junction，否则插件加载失败。

## Verification

- `node scripts/prepare-plugins.mjs`：5 个插件 / 349 files / 2.67 MiB；`resources/plugins/dsh-super-kanban` 不存在，
  `plugins.json` packages 只有 5 个。
- profile `--dump-config` 出现 `# == dsh-super-kanban`、`- id: super-kanban`、`name: dsh-super-kanban`；
  链接目标为 `D:\workspace\research\deepseek-harness-plugins\dsh-super-kanban`。
- `npm run typecheck`；`npm test` 665 tests / 657 pass / 8 skipped / 0 fail。
- `npm run package:dir`：`组合校验：5 个随壳插件与 MCP 行在打包 dsh 里真实挂载`，`打包校验通过：dsh 0.2.2-rc.2、asar 33121 files`，exit 0。
- 热更新实测：临时 profile 指向源码，DSH web 41770 + headless Chrome 打开看板；把 `client.js` 的侧栏标题
  `范围` 临时改成 `范围HOT`，刷新页面后 rail 标题变为 `范围HOT`；`git checkout -- client.js` 恢复后刷新回到 `范围`。
  临时 profile 已恢复为干净源码链接；临时 Chrome/DSH 进程收尾时停止。

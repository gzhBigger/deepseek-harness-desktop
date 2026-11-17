# Agent Note: worktree 会话使用有效 cwd

Status: implemented

## Problem

Git 面板的 worktree 在新会话的第一条消息之后才创建，并通过 `workingDirectory` session projection
把 Agent 的 cwd 切到 `<repo>/.agents/worktrees/...`。但会话 header 的 `cwd` 仍是原项目：

- 侧栏会话行只读 header，用户看不出这是 worktree 会话；
- DSH 自带文件侧栏和文件 API 也读 header，文件树继续显示主项目；
- Git 面板的默认 root 同样是 header，切到 worktree 后仍操作主项目。

用户需要的是：选定 worktree 后，本次会话的所有项目相对路径（文件面板、Git 面板、后续工具）都跟随
会话的有效 cwd，而不是要求再新建一个会话或手动切目录。

## Decision

**把 `workingDirectory` projection 提升为所有项目相对界面的根，而不是改 session header。**

- 插件侧：
  - `dsh-git-panel/src/client/components/GitPanel.tsx` 的 `sessionCwd` 优先取
    `session.projectionValues?.workingDirectory`，回退 `session.cwd`；root effect 跟随该值变化。
  - `dsh-workspace-category-manager/src/client/components/CategorySidebar.tsx` 用同一个有效 cwd
    识别 `.agents/worktrees/<name>`，在会话行显示 `WT` 徽标；普通会话不显示。
  - worktree 名称 stem 改用 session UUID 前 8 位 + 6 位十六进制，避免所有会话都叫 `sessione`。
- 桌面 runtime 侧（DSH 自身仍读 header，必须在打包时打小补丁）：
  - `prepare-runtime.mjs` 在复制 `node_modules` 后调用 `patchEffectiveCwd()`；
  - `dsh-client-ui-sidebar-files/lib/client.js` 的 3 处 session root 取
    `projectionValues.workingDirectory ?? cwd`；
  - `dsh-api-workspace-files/lib/index.js` 注入 `workingDirectory`，文件 API 用 projection 覆盖
    `header.cwd`；
  - `verify-package.mjs` 检查 asar 里两个补丁标记，DSH 升级导致替换失配时直接失败，避免静默退回 header。

## Alternatives considered

- **只加 worktree 徽标，不改文件面板**：最小改动，但用户打开文件面板仍看到主项目，问题只解决一半。
- **worktree 创建后新开一个会话**：header 会是 worktree，文件面板自然正确；但当前会话的第一条消息、
  草稿和上下文都留在旧会话，用户明确要“当前会话”跟随，不是换会话。
- **在 git-panel 里复制一套文件树**：能绕开 core，但文件打开、搜索、预览、上传都要重做一遍，
  且用户会在两个文件入口之间困惑。
- **改 session header 的 cwd**：会破坏 header 作为项目身份/workspace 归属的语义，影响归档、侧栏分类和
  其他按 header 取项目的代码；projection 已经是 DSH 提供的正确抽象。
- **直接改 DSH 上游源码**：上游升级会覆盖；用 prepare-runtime 的显式补丁 + 校验才能让安装包可重复构建。

## Consequences

- 安装包必须在 `runtime:prepare` 时打 core 补丁；DSH 升级后若三处替换文本变化，`prepare-runtime`/`verify-package`
  会 fail，需要同步更新补丁，不会静默出错。
- Git 面板和侧栏插件是 profile link，刷新页面即可生效；core 文件补丁只有新壳/新 runtime 才生效。
- 文件 API 的 `workspaceRoot` 现在跟随 projection，所有依赖它的相对路径（读、写、搜索）都会落到 worktree。
- 安装版 0.4.34 的 runtime 仍是旧代码；本次修复要下次打包/安装后才会进入用户桌面端。

## Verification

- `node scripts/prepare-runtime.mjs`：33,120 文件 / 643.3 MiB，物理落盘 1233；日志出现
  「文件侧栏/文件 API 已改为优先使用 workingDirectory projection」，client 替换计数 3/3。
- `npm run package:dir`：asar 33121 文件、物理 1233、打包校验通过；新门禁确认 asar 内含
  `projectionValues?.workingDirectory??s?.cwd` 与 `scope.workingDirectory?.get(session)`。
- 插件测试：git-panel 12 个文件全过（220.0kb client），sidebar `npm test` 与 `validate` 全过；
  sidebar 新增 WT badge 用例（worktree 显示、普通会话不显示）。
- 真实页面：41793（仓库 runtime + 真实 profile）中带 WT 的会话打开右侧「文件」tab，根目录为
  `D:\workspace\hdyy\one-bot\.agents\worktrees\dsh-sessione-8719`，而非主项目。

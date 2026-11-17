# Agent Note: 归档会话时清理已合并的 worktree

Status: implemented

## Problem

Git 面板的 worktree 会话在归档后仍会留下工作树和分支。用户希望归档一个已经用完的
worktree 会话时，自动把对应的工作树与分支清理掉，而不是再去工作树页手动删除。

但“归档”本身不等于“可以丢弃工作”。如果分支还有未合并的提交，或工作树里有未提交的
改动，自动删除会直接丢数据；这比留下一个多余分支更糟。

## Decision

在 `dsh-git-panel` 宿主监听 `workspace/session-archived`，只对能确认有效 cwd 的会话执行
清理，并且只在 `readWorktrees()` 判定 `merged === true` 时删树 + 删分支。

- 有效 cwd 取 `workingDirectory.get(session)`，回退到当前请求表里的 `path`；没有路径就跳过。
- 有效 cwd 可能在 worktree 内，此时 `inspectRepository()` 的 `repoRoot` 是这棵工作树本身，
  直接执行 `git worktree remove` 会拒绝删除“当前工作树”。因此用 `repo.commonDir` 的父目录
  找到主工作区，再在主工作区执行删除。
- `merged` 的定义沿用现有实现：分支 HEAD 是主仓库 HEAD 的祖先，且工作树 `dirty === 0`。
  未合并或有改动时只记日志，保留树和分支。
- `removeWorktree()` 增加可选 `deleteBranch`；只有 `info.merged === true` 才执行
  `git branch -D`。默认不传，所以工作树页的手动删除仍然保留分支。
- 新配置 `cleanupWorktreeOnArchive` 默认 `true`，设置页加 checkbox；用户可随时关闭。
- 清理放在 `setTimeout(…, 0)` 里异步执行，失败只 warn，不阻塞/回滚归档。
- 监听在 `createWorktreeRequests` 创建时注册，`dispose`/`ctx.effect` 时注销。

## Alternatives considered

- **归档即无条件删树 + `branch -D`**：最省事，但会丢掉未合并提交或未提交改动。归档是
  “不再出现在当前列表”，不是“永久丢弃”；不可接受。
- **只删工作树、保留分支**：比无条件删安全，但用户明确要“把分支也删掉”，而且已合并分支
  留着只会积累垃圾。
- **在工作树页手动删除时顺便删分支**：手动删除的语义是“移除这棵树”，用户可能还要用分支；
  默认保留分支更符合现有行为，自动归档才是可安全清理的时机。
- **在归档 API 里同步删 Git**：归档写入会被 Git I/O 拖慢，而且 Git 失败会让归档失败；
  用事件异步清理，归档语义保持独立。

## Consequences

- 已合并且干净的 worktree 会在归档后自动消失，分支也会删除；未合并/脏树会保留，需要用户
  在工作树页手动处理。
- 归档事件后清理是异步的，磁盘上的树可能比会话晚几秒消失。
- 宿主代码改动需要重启 DSH 才生效；客户端设置页刷新即可看到开关。
- 若会话在宿主重启后归档、且既没有有效 projection 也没有请求表记录，无法定位 worktree，
  此时不会自动清理（安全侧失败）。

## Verification

- `node --check src/host/worktree.js src/host/worktree-requests.js`。
- `node tests/worktree-requests.test.js`：21 assertions，覆盖
  - 创建后归档：树和分支都删除；
  - 有未提交改动时归档：树和分支都保留，随后手动清理。
- `pnpm test` 12 个测试文件全过；`pnpm run typecheck`、`pnpm run build`、`pnpm run validate` 全过。
- 新增设置字段 `cleanupWorktreeOnArchive`，README 配置表与工作树说明同步更新。

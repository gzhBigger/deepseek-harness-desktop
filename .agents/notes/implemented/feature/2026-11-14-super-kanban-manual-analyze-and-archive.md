# Agent Note: Super Kanban 手动研判与归档项目删除

Status: implemented

## Problem

自动研判只在 `turn/end` 触发，用户想立刻重判某个任务时没有入口，只能等下一轮会话或改状态。任务卡右键菜单里没有手动研判项。

项目页只把归档项目放在底部折叠区，不能单独筛选；也没有删除入口。归档项目长期堆积后无法清理，且已归档项目仍可能被误当作活跃项目查看。

## Decision

- 任务卡右键菜单新增「重新研判」：直接调用现有 `task.analyze`（不传 `auto`），toast 显示引擎、AI 调用数、token 数或返回消息，完成后 `reload(true)`。请求进行中禁用所有任务的该菜单项，避免并发。
- 项目页把「归档项目」作为筛选 chip，选中后只显示已归档项目；移除底部重复的归档折叠入口。
- 只有已归档项目可以删除（服务端 `project.delete` 二次校验），删除前需要两次点击确认。删除项目时把关联任务的 `projectId` 置空并 `touchTask`，返回 `detachedTasks` 数量；不删除任务本身。
- 保留现有归档/恢复流程；删除是破坏性动作，和归档分开。

## Alternatives considered

- **在自动研判设置里再加一个手动触发按钮**：放在设置页离任务太远，且需要选择任务；右键菜单更贴近上下文。
- **允许直接删除未归档项目**：容易误删活跃项目；先归档再删除多一步，但给了可恢复的中间状态。
- **删除项目时级联删除任务**：任务可能承载会话、验收和证据，级联删除不可恢复；只解除归属更安全。
- **把归档项目继续放在底部折叠区**：和「分类筛选」是两套入口，用户找不到；统一为筛选 chip。

## Consequences

- 手动研判不受 `autoAnalyzeOnTurnEnd` 开关影响，也不自动锁手写字段（仍走 `task.analyze` 的原有规则）。
- 删除项目后，任务仍在看板/待办中，只失去项目归属；如需恢复项目，只能重新创建并重新归类。
- 归档项目筛选依赖客户端状态，不影响自动研判和任务查询；归档项目不会进入常规项目分组。
- `project.delete` 是服务端新命令，需重启 DSH Desktop 才能生效；手动研判按钮和归档筛选刷新页面即可看到。

## Verification

- `node --check client.js server/service.mjs` 通过。
- `npm test` 317/317；新增服务端用例覆盖「未归档项目不能删除」「归档后可删除」「关联任务 projectId 置空」。
- `npm run validate`、`check:privacy`、`check:docs`、`check:version` 全过。
- 客户端静态测试覆盖归档筛选 chip、无旧 `sk-project-archive` 折叠入口、`project.delete` 与「删除归档项目」文案。
- 插件仓库提交 `f4d6826 feat(super-kanban): add manual re-analysis and archived project cleanup`（6 files，+123/−25），工作区干净。
